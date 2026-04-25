import { Request, Response, NextFunction } from 'express';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { AppError } from './error-handler';
import { isPublicSurface } from './rate-limit';
import { getSetting, updateSettings } from '../services/settings.service';
import { config } from '../config';

// Step-10 CSRF middleware — double-submit cookie pattern.
//
// Issue: every response that sets the refresh_token cookie also
//   sets a sibling `xsrf_token` cookie containing
//   `<random>.<hmac(random, csrf_signing_secret)>`. Path '/',
//   SameSite=Lax, Secure in production, NOT HttpOnly (the SPA
//   reads it to mirror into the X-CSRF-Token header).
//
// Verify: every state-changing method (POST/PUT/PATCH/DELETE) that
//   isn't on the skip list must present `X-CSRF-Token` matching
//   the cookie value AND the HMAC must validate. Mismatch /
//   missing → 403 CSRF_INVALID.
//
// Skip list:
//   - GET / HEAD / OPTIONS — no state change.
//   - Authorization: Bearer xray_* — API keys are header-auth and
//     not subject to cross-site cookie replay.
//   - /api/health, /api/embed/*, /api/share/* — public surfaces
//     (already on the rate-limit isPublicSurface predicate).
//   - /api/stripe/webhook — sender-signed (Stripe's signature).
//   - /api/webhooks/* — sender-signed (HMAC headers).
//   - /api/admin/import — operator-controlled tenant import path
//     accepts raw application/zip; the operator drives this from
//     a CLI, not a browser session. CSRF would just break it.

const CSRF_COOKIE = 'xsrf_token';
const CSRF_HEADER = 'x-csrf-token';
const API_KEY_PREFIX = 'xray_';

// In-process cache for the HMAC secret. settings.service has its
// own 60-second TTL cache, but the verify path is on every
// state-changing request so a hot-path memoise here keeps the cost
// at one HMAC compute per request.
let cachedSecret: string | null = null;
let cachedAt = 0;
const SECRET_TTL_MS = 60_000;

async function getSigningSecret(): Promise<string> {
  if (cachedSecret && Date.now() - cachedAt < SECRET_TTL_MS) {
    return cachedSecret;
  }

  // Lazy-seed on first use: settings.service.updateSettings runs
  // through encrypt() so getSetting() can later decrypt() round-trip.
  // Migration 038 deliberately left the row absent — the AES-256-GCM
  // shape lib/crypto uses can't be produced from SQL.
  let value: string | null = null;
  try {
    value = await getSetting('csrf_signing_secret');
  } catch {
    // decrypt() failure means the row exists with a malformed/legacy
    // value. Treat as absent and re-seed.
    value = null;
  }

  if (!value) {
    const fresh = randomBytes(32).toString('hex');
    // Pass user_id 'system' marker — updateSettings logs the writer
    // to platform_settings.updated_by. The bootstrap writer is the
    // server itself, not a user; use a sentinel string.
    try {
      await updateSettings({ csrf_signing_secret: fresh }, 'system');
    } catch {
      // If two boots race the seed, one INSERT wins via ON CONFLICT
      // DO UPDATE; both end up reading the winning value below.
    }
    value = await getSetting('csrf_signing_secret');
    if (!value) {
      // Should not happen — surface a hard fail rather than serve
      // an unsigned token pair.
      throw new Error('csrf_signing_secret seed failed');
    }
  }

  cachedSecret = value;
  cachedAt = Date.now();
  return value;
}

function sign(random: string, secret: string): string {
  return createHmac('sha256', secret).update(random).digest('hex');
}

function buildToken(secret: string): string {
  const random = randomBytes(24).toString('hex');
  return `${random}.${sign(random, secret)}`;
}

function verifyToken(token: string, secret: string): boolean {
  const [random, mac] = token.split('.');
  if (!random || !mac) return false;
  const expected = sign(random, secret);
  if (expected.length !== mac.length) return false;
  try {
    return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(mac, 'hex'));
  } catch {
    return false;
  }
}

// Cookie issuance: call from any route that sets the refresh
// cookie (login completion, refresh, signup, invite-accept,
// impersonate start/stop). Side-effects only — returns nothing.
export async function issueCsrfCookie(res: Response): Promise<void> {
  const secret = await getSigningSecret();
  const token = buildToken(secret);
  res.cookie(CSRF_COOKIE, token, {
    httpOnly: false,
    secure: config.nodeEnv === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days; ride longer than the access token
  });
}

// Cookie clear: call from logout / account-deletion paths so a
// stale cookie doesn't sit on the device.
export function clearCsrfCookie(res: Response): void {
  res.clearCookie(CSRF_COOKIE, { path: '/' });
}

function methodIsSafe(method: string): boolean {
  return method === 'GET' || method === 'HEAD' || method === 'OPTIONS';
}

function pathBypassesCsrf(req: Request): boolean {
  const p = req.path;
  // Already-skip-listed public surfaces.
  if (isPublicSurface(req)) return true;
  // Sender-signed paths.
  if (p === '/api/stripe/webhook') return true;
  if (p.startsWith('/api/webhooks/')) return true;
  // Operator-CLI import path (raw application/zip body, not a
  // browser session).
  if (p === '/api/admin/import') return true;
  return false;
}

function authIsBearerApiKey(req: Request): boolean {
  const h = req.headers.authorization;
  if (!h?.startsWith('Bearer ')) return false;
  return h.slice(7).startsWith(API_KEY_PREFIX);
}

// Verify middleware — mount globally after cookieParser + body
// parsing, before route mounting. State-changing methods on
// non-skip-listed routes require a matching cookie + header pair.
export function verifyCsrf(req: Request, _res: Response, next: NextFunction): void {
  if (methodIsSafe(req.method)) return next();
  if (pathBypassesCsrf(req)) return next();
  if (authIsBearerApiKey(req)) return next();

  const cookieValue = (req.cookies as Record<string, string> | undefined)?.[CSRF_COOKIE];
  const headerValue = req.headers[CSRF_HEADER];
  const headerString = typeof headerValue === 'string' ? headerValue : '';

  if (!cookieValue || !headerString) {
    return next(new AppError(403, 'CSRF_INVALID', 'Missing CSRF token'));
  }

  // Constant-time string compare on the cookie/header pair.
  const a = Buffer.from(cookieValue);
  const b = Buffer.from(headerString);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return next(new AppError(403, 'CSRF_INVALID', 'CSRF token mismatch'));
  }

  // HMAC verify the cookie payload itself so a forged cookie
  // mirrored into the header still fails the gate.
  getSigningSecret()
    .then((secret) => {
      if (!verifyToken(cookieValue, secret)) {
        return next(new AppError(403, 'CSRF_INVALID', 'CSRF token signature invalid'));
      }
      next();
    })
    .catch((err) => next(err));
}

// Test helper — wipes the in-process cache so tests can re-seed
// against a fresh secret without restarting the process.
export function _resetCsrfCacheForTests(): void {
  cachedSecret = null;
  cachedAt = 0;
}

// Hash helper exported for other modules that want to derive a
// stable per-secret tag (currently unused; reserved for future
// rotation-versioning if the secret column grows a generation
// counter).
export function csrfSecretFingerprint(secret: string): string {
  return createHash('sha256').update(secret).digest('hex').slice(0, 12);
}
