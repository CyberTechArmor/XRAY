import { Request } from 'express';
import rateLimit from 'express-rate-limit';
import { createHash } from 'crypto';
import { config } from '../config';

// Step 9 IP+device tier. The first defence against high-volume
// scripted abuse: 100 requests per 60s per (IP, device-fingerprint)
// pair. Fingerprint is hash(IP + UA + Accept-Language) so a
// botfarm rotating IPs but reusing one UA still buckets under the
// same key from the rate-limiter's perspective. Window is in-memory
// — restarts reset it, which is fine for a 60s window: the bot is
// already throttled before the next restart.
//
// Skipped routes (separate buckets handled by per-route limiters or
// public/embed semantics that don't share auth surface):
//   /api/health     — operator probe; never gated.
//   /api/embed/*    — public render token surface.
//   /api/share/*    — public share-token surface.
//
// 429 body matches the rest of the API's error envelope so the
// frontend can surface a generic "you're being rate-limited" toast.
//
// Pre-step-9 this file exported four narrow limiters
// (passkeyRateLimit / authRateLimit / apiRateLimit / magicLinkRateLimit)
// but they were never wired up in index.ts ("Rate limiting removed").
// Step 9 collapses them into one global limiter that gates every
// request and pairs with the per-email-24h limiter in
// middleware/auth-attempts.ts for the auth surface.

function deviceFingerprint(req: Request): string {
  const ip = req.ip || req.socket.remoteAddress || 'no-ip';
  const ua = (req.headers['user-agent'] as string) || '';
  const lang = (req.headers['accept-language'] as string) || '';
  return createHash('sha256').update(`${ip}|${ua}|${lang}`).digest('hex');
}

// Helper shared with auth-attempts.ts: routes that should skip both
// the IP-device limiter and the auth-attempts ledger.
export function isPublicSurface(req: Request): boolean {
  const p = req.path;
  return (
    p === '/api/health' ||
    p.startsWith('/api/embed/') ||
    p.startsWith('/api/share/')
  );
}

export const globalIpDeviceLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  keyGenerator: deviceFingerprint,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: isPublicSurface,
  message: {
    ok: false,
    error: {
      code: 'RATE_LIMITED',
      message: 'Too many requests. Please slow down and try again.',
    },
  },
});

// Hashed IP for the auth_attempts ledger. Same salt-with-
// server-secret pattern so the table never carries raw addresses;
// cross-attempt linkage is preserved (same IP → same hash) but
// reverse lookup needs the secret.
export function ipHash(req: Request): string {
  const ip = req.ip || req.socket.remoteAddress || '';
  if (!ip) return '';
  return createHash('sha256').update(`${ip}|${config.jwtSecret}`).digest('hex');
}

// Step 10: User-Agent hash with the same salt convention. Used to
// fingerprint magic-link issuance (migration 037) so consumption
// from a different device fails LINK_FINGERPRINT_MISMATCH.
export function uaHash(req: Request): string {
  const ua = (req.headers['user-agent'] as string) || '';
  if (!ua) return '';
  return createHash('sha256').update(`${ua}|${config.jwtSecret}`).digest('hex');
}

// Convenience: returns the pair the magic-link issuance + verify
// paths need. Either side can be empty when the relevant header
// is absent — the verify side uses skip-on-NULL semantics so an
// empty hash never falsely matches.
export function requestFingerprint(req: Request): { ipHash: string; uaHash: string } {
  return { ipHash: ipHash(req), uaHash: uaHash(req) };
}
