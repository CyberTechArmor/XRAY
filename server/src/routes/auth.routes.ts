import { Router, Response } from 'express';
import { authenticateJWT } from '../middleware/auth';
import { validateBody, signupSchema, verifySchema, verifyTokenSchema, loginBeginSchema, magicLinkSchema } from '../lib/validation';
import { hashRefreshToken } from '../lib/crypto';
import { config } from '../config';
import * as authService from '../services/auth.service';
// Rate limiting removed

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

export default router;
