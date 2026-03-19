import { Router } from 'express';
import { authenticateJWT } from '../middleware/auth';
import { validateBody, signupSchema, verifySchema, verifyTokenSchema, loginBeginSchema, magicLinkSchema } from '../lib/validation';
import * as authService from '../services/auth.service';

const router = Router();

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
    const result = await authService.verifyCode(data);
    res.json({
      ok: true,
      data: result,
      meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

// POST /verify-token - for magic link clicks (no auth)
router.post('/verify-token', async (req, res, next) => {
  try {
    const data = validateBody(verifyTokenSchema, req.body);
    const result = await authService.verifyToken(data);
    res.json({
      ok: true,
      data: result,
      meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

// POST /login/begin - start passkey auth, return challenge (no auth)
router.post('/login/begin', async (req, res, next) => {
  try {
    const data = validateBody(loginBeginSchema, req.body);
    const result = await authService.loginBegin(data);
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
    const result = await authService.loginComplete(req.body);
    res.json({
      ok: true,
      data: result,
      meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

// POST /magic-link - send magic link for login (no auth)
router.post('/magic-link', async (req, res, next) => {
  try {
    const data = validateBody(magicLinkSchema, req.body);
    const result = await authService.initiateMagicLink(data);
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
    const result = await authService.initiateRecovery(data);
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
    const refreshToken = req.cookies?.refresh_token;
    const result = await authService.refreshSession(refreshToken);
    res.json({
      ok: true,
      data: result,
      meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

// POST /logout - logout (JWT)
router.post('/logout', authenticateJWT, async (req, res, next) => {
  try {
    await authService.logout(req.user!.sub);
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
