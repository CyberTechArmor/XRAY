import { Router, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { authenticateJWT } from '../middleware/auth';
import { validateBody, signupSchema, verifySchema, verifyTokenSchema, loginBeginSchema, magicLinkSchema } from '../lib/validation';
import { hashRefreshToken } from '../lib/crypto';
import { config } from '../config';
import { AppError } from '../middleware/error-handler';
import * as authService from '../services/auth.service';
import * as totpService from '../services/totp.service';
import * as backupCodesService from '../services/backup-codes.service';
import { withAdminClient } from '../db/connection';

const router = Router();

// ─── Helpers ─────────────────────────────────────────────────────────────────

function setRefreshCookie(res: Response, refreshToken: string) {
  res.cookie('refresh_token', refreshToken, {
    httpOnly: true,
    secure: config.nodeEnv === 'production',
    sameSite: 'lax',
    path: '/api/auth',
    maxAge: config.jwt.refreshTokenExpiry,
  });
}

function sendTokenPair(res: Response, tokens: { accessToken: string; refreshToken: string; sessionId: string }, req: any) {
  setRefreshCookie(res, tokens.refreshToken);
  res.json({
    ok: true,
    data: { accessToken: tokens.accessToken, sessionId: tokens.sessionId },
    meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
  });
}

// Step 9: detects the MFA-pending shape returned by completeLogin /
// loginToTenant / completePasskeyAuth. The route hands the
// mfa_required + mfa_token straight back to the client; the auth
// modal swaps to the TOTP step, then POSTs /api/auth/totp/verify.
function isMfaPending(r: any): r is { mfa_required: 'verify' | 'enroll'; mfa_token: string } {
  return r && typeof r === 'object' && typeof r.mfa_required === 'string' && typeof r.mfa_token === 'string';
}

function sendMfaPending(res: Response, req: Request, payload: { mfa_required: 'verify' | 'enroll'; mfa_token: string }) {
  res.json({
    ok: true,
    data: { mfa_required: payload.mfa_required, mfa_token: payload.mfa_token },
    meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
  });
}

// Step 9: TOTP enroll/confirm accept either a full session bearer
// JWT (an already-logged-in user opting into TOTP) OR an interim
// mfa-enroll token (an admin forced to enroll before primary-auth
// can complete). Returns the resolved (userId, tenantId) pair plus
// whether the caller is fully authenticated — the confirm route
// uses that flag to decide whether to also issue the final session.
async function resolveTotpAuth(
  req: Request
): Promise<{ userId: string; tenantId: string; isFullSession: boolean }> {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    try {
      const payload = jwt.verify(token, config.jwtSecret) as any;
      if (payload?.sub && payload?.tid && !payload.scope) {
        return { userId: payload.sub, tenantId: payload.tid, isFullSession: true };
      }
    } catch {
      // fall through to mfa_token path
    }
  }
  const mfaToken = req.body?.mfa_token;
  if (typeof mfaToken === 'string' && mfaToken.length > 0) {
    const claims = authService.verifyMfaPendingToken(mfaToken, 'mfa-enroll');
    return { userId: claims.sub, tenantId: claims.tid, isFullSession: false };
  }
  throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
}

async function lookupUserEmail(userId: string): Promise<string> {
  // Pre-tenant lookup for the otpauth label. Same admin-bypass rationale
  // as auth.service's getUserPermissions — we read users by id before
  // any tenant context is bound.
  return withAdminClient(async (client) => {
    const r = await client.query('SELECT email FROM platform.users WHERE id = $1', [userId]);
    return r.rows[0]?.email ?? '';
  });
}

// ─── GET /setup - check if first-boot setup is needed (no auth) ──────────────

router.get('/setup', async (_req, res, next) => {
  try {
    const status = await authService.getSetupStatus();
    res.json({
      ok: true,
      data: status,
      meta: { timestamp: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

// ─── POST /setup - first-boot admin provisioning, bypasses email (no auth) ───

router.post('/setup', async (req, res, next) => {
  try {
    const data = validateBody(signupSchema, req.body);
    const tokens = await authService.firstBootSetup(data);
    sendTokenPair(res, tokens, req);
  } catch (err) {
    next(err);
  }
});

// POST /signup - initiate signup (no auth)
router.post('/signup', async (req, res, next) => {
  try {
    const data = validateBody(signupSchema, req.body);
    const result = await authService.initiateSignup(data);
    res.json({
      ok: true,
      data: result,
      meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

// POST /verify - verify code for signup completion or login verification (no auth)
router.post('/verify', async (req, res, next) => {
  try {
    const data = validateBody(verifySchema, req.body);
    const magicLink = await authService.verifyCode(data);
    let tokens;
    if (magicLink.purpose === 'signup') {
      tokens = await authService.completeSignup(magicLink);
    } else {
      tokens = await authService.completeLogin(magicLink);
    }
    // Step 9 MFA gate: primary auth succeeded but second factor required.
    if (isMfaPending(tokens)) {
      sendMfaPending(res, req, tokens);
      return;
    }
    // If multi-tenant, return tenant list for user to pick
    if ((tokens as any).tenants) {
      res.json({
        ok: true,
        data: { tenants: (tokens as any).tenants, email: magicLink.email },
        meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
      });
      return;
    }
    sendTokenPair(res, tokens, req);
  } catch (err) {
    next(err);
  }
});

// POST /verify-token - for magic link clicks (no auth)
router.post('/verify-token', async (req, res, next) => {
  try {
    const data = validateBody(verifyTokenSchema, req.body);
    const magicLink = await authService.verifyToken(data.token);
    let tokens;
    if (magicLink.purpose === 'signup') {
      tokens = await authService.completeSignup(magicLink);
    } else {
      tokens = await authService.completeLogin(magicLink);
    }
    if (isMfaPending(tokens)) {
      sendMfaPending(res, req, tokens);
      return;
    }
    if ((tokens as any).tenants) {
      res.json({
        ok: true,
        data: { tenants: (tokens as any).tenants, email: magicLink.email },
        meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
      });
      return;
    }
    sendTokenPair(res, tokens, req);
  } catch (err) {
    next(err);
  }
});

// POST /select-tenant - select tenant after multi-tenant login (no auth)
router.post('/select-tenant', async (req, res, next) => {
  try {
    const { email, tenantId } = req.body;
    if (!email || !tenantId) {
      return res.status(400).json({ ok: false, error: { code: 'MISSING_FIELDS', message: 'Email and tenantId are required' } });
    }
    // Create a temporary magic link for the tenant selection (short-lived)
    const tokens = await authService.loginToTenant(email, tenantId);
    if (isMfaPending(tokens)) {
      sendMfaPending(res, req, tokens);
      return;
    }
    sendTokenPair(res, tokens, req);
  } catch (err) {
    next(err);
  }
});

// POST /login/begin - start email login, return challenge (no auth)
router.post('/login/begin', async (req, res, next) => {
  try {
    const data = validateBody(loginBeginSchema, req.body);
    const result = await authService.initiateLogin(data.email);
    res.json({
      ok: true,
      data: result,
      meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

// POST /login/complete - complete passkey auth (no auth)
router.post('/login/complete', async (req, res, next) => {
  try {
    const data = validateBody(verifySchema, req.body);
    const magicLink = await authService.verifyCode(data);
    const tokens = await authService.completeLogin(magicLink);
    if (isMfaPending(tokens)) {
      sendMfaPending(res, req, tokens);
      return;
    }
    if ((tokens as any).tenants) {
      res.json({
        ok: true,
        data: { tenants: (tokens as any).tenants, email: magicLink.email },
        meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
      });
      return;
    }
    sendTokenPair(res, tokens, req);
  } catch (err) {
    next(err);
  }
});

// POST /passkey/begin - start passkey authentication (no auth)
router.post('/passkey/begin', async (req, res, next) => {
  try {
    const result = await authService.beginPasskeyAuth(req.body.email);
    res.json({
      ok: true,
      data: result,
      meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

// POST /passkey/complete - complete passkey authentication (no auth)
router.post('/passkey/complete', async (req, res, next) => {
  try {
    const tokens = await authService.completePasskeyAuth(req.body);
    if (isMfaPending(tokens)) {
      sendMfaPending(res, req, tokens);
      return;
    }
    sendTokenPair(res, tokens, req);
  } catch (err) {
    next(err);
  }
});

// POST /magic-link - send magic link for login (no auth)
router.post('/magic-link', async (req, res, next) => {
  try {
    const data = validateBody(magicLinkSchema, req.body);
    const result = await authService.initiateLogin(data.email);
    res.json({
      ok: true,
      data: result,
      meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

// POST /recover - initiate account recovery (no auth)
router.post('/recover', async (req, res, next) => {
  try {
    const data = validateBody(magicLinkSchema, req.body);
    const result = await authService.initiateRecovery(data.email);
    res.json({
      ok: true,
      data: result,
      meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

// POST /refresh - refresh session (cookie-based)
router.post('/refresh', async (req, res, next) => {
  try {
    const rawToken = req.cookies?.refresh_token;
    if (!rawToken) {
      return res.status(401).json({ ok: false, error: { code: 'NO_TOKEN', message: 'No refresh token' } });
    }
    const tokenHash = hashRefreshToken(rawToken);
    const tokens = await authService.refreshSession(tokenHash);
    sendTokenPair(res, tokens, req);
  } catch (err) {
    next(err);
  }
});

// POST /logout - logout (JWT)
router.post('/logout', authenticateJWT, async (req, res, next) => {
  try {
    await authService.logout(req.user!.sub);
    res.clearCookie('refresh_token', { path: '/api/auth' });
    res.json({
      ok: true,
      data: { message: 'Logged out successfully' },
      meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

// ─── Step 9: TOTP / backup codes ──────────────────────────────────────────────
//
// Enroll / confirm accept either a full session bearer JWT (an
// already-logged-in user opting into TOTP) or an interim mfa_token
// in the body (an admin forced to enroll before primary-auth can
// complete). Verify / disable / regenerate require a confirmed
// session.

// POST /totp/enroll — start enrollment, return QR + secret + otpauth_url.
router.post('/totp/enroll', async (req, res, next) => {
  try {
    const auth = await resolveTotpAuth(req);
    const email = await lookupUserEmail(auth.userId);
    const result = await totpService.enrollTotp(auth.userId, auth.tenantId, email || auth.userId);
    res.json({
      ok: true,
      data: result,
      meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

// POST /totp/confirm — verify first code, flip confirmed_at, mint
// 8 fresh backup codes. If the caller arrived via an mfa-enroll
// interim token, the response also includes the full session.
router.post('/totp/confirm', async (req, res, next) => {
  try {
    const auth = await resolveTotpAuth(req);
    const code: string | undefined = req.body?.code;
    if (!code || typeof code !== 'string') {
      throw new AppError(400, 'INVALID_CODE', 'Code is required');
    }
    const ok = await totpService.confirmTotp(auth.userId, auth.tenantId, code.trim());
    if (!ok) {
      throw new AppError(400, 'INVALID_CODE', 'Incorrect verification code');
    }
    const backupCodes = await backupCodesService.regenerateBackupCodes(auth.userId, auth.tenantId);

    if (auth.isFullSession) {
      res.json({
        ok: true,
        data: { confirmed: true, backup_codes: backupCodes },
        meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
      });
      return;
    }
    // Admin-forced enrollment path: confirmTotp just satisfied the
    // gate; issue the full session now.
    const session = await authService.createSession(auth.userId, auth.tenantId);
    setRefreshCookie(res, session.refreshToken);
    res.json({
      ok: true,
      data: {
        confirmed: true,
        backup_codes: backupCodes,
        accessToken: session.accessToken,
        sessionId: session.sessionId,
      },
      meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

// POST /totp/verify — second-factor step after primary auth.
// Body: { mfa_token, code } — code may be a 6-digit TOTP or a
// backup code (xxxx-xxxx-xxxx). Returns the full session on success.
router.post('/totp/verify', async (req, res, next) => {
  try {
    const mfaToken: string | undefined = req.body?.mfa_token;
    const code: string | undefined = req.body?.code;
    if (!mfaToken || !code) {
      throw new AppError(400, 'MISSING_FIELDS', 'mfa_token and code are required');
    }
    const session = await authService.completeMfaVerify(mfaToken, code);
    sendTokenPair(res, session, req);
  } catch (err) {
    next(err);
  }
});

// POST /totp/disable — require a current valid code; cascade-deletes
// backup codes via the FK on user_backup_codes.user_id.
router.post('/totp/disable', authenticateJWT, async (req, res, next) => {
  try {
    const code: string | undefined = req.body?.code;
    if (!code) {
      throw new AppError(400, 'INVALID_CODE', 'Current TOTP code is required');
    }
    const u = req.user!;
    await totpService.disableTotp(u.sub, u.tid, code.trim());
    res.json({
      ok: true,
      data: { disabled: true },
      meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

// POST /totp/backup-codes/regenerate — invalidate the current batch
// + return a fresh set. Caller must show them once and discard.
router.post('/totp/backup-codes/regenerate', authenticateJWT, async (req, res, next) => {
  try {
    const u = req.user!;
    const codes = await backupCodesService.regenerateBackupCodes(u.sub, u.tid);
    res.json({
      ok: true,
      data: { backup_codes: codes },
      meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

// GET /totp/status — for the Account → Security panel: tells the UI
// whether TOTP is enrolled and how many unused backup codes remain.
router.get('/totp/status', authenticateJWT, async (req, res, next) => {
  try {
    const u = req.user!;
    const [enrolled, unused] = await Promise.all([
      totpService.hasConfirmedTotp(u.sub, u.tid),
      backupCodesService.countUnusedCodes(u.sub, u.tid),
    ]);
    res.json({
      ok: true,
      data: { enrolled, backup_codes_remaining: unused },
      meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

export default router;
