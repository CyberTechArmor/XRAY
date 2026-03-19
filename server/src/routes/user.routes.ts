import { Router } from 'express';
import { authenticateJWT } from '../middleware/auth';
import { requirePermission } from '../middleware/rbac';
import { validateBody, validateQuery, userUpdateSchema, paginationSchema } from '../lib/validation';
import * as userService from '../services/user.service';

const router = Router();

// GET /me - get current user profile (JWT, account.view)
// Defined before /:id to avoid route conflict
router.get('/me', authenticateJWT, requirePermission('account.view'), async (req, res, next) => {
  try {
    const result = await userService.getProfile(req.user!.sub);
    res.json({
      ok: true,
      data: result,
      meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

// PATCH /me - update current user profile (JWT, account.edit)
router.patch('/me', authenticateJWT, requirePermission('account.edit'), async (req, res, next) => {
  try {
    const data = validateBody(userUpdateSchema, req.body);
    const result = await userService.updateProfile(req.user!.sub, data);
    res.json({
      ok: true,
      data: result,
      meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

// GET /me/passkeys - list passkeys (JWT, account.view)
router.get('/me/passkeys', authenticateJWT, requirePermission('account.view'), async (req, res, next) => {
  try {
    const result = await userService.listPasskeys(req.user!.sub);
    res.json({
      ok: true,
      data: result,
      meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

// POST /me/passkeys - register passkey, returns registration options (JWT, account.edit)
router.post('/me/passkeys', authenticateJWT, requirePermission('account.edit'), async (req, res, next) => {
  try {
    const result = await userService.registerPasskey(req.user!.sub);
    res.json({
      ok: true,
      data: result,
      meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

// POST /me/passkeys/verify - complete passkey registration (JWT, account.edit)
router.post('/me/passkeys/verify', authenticateJWT, requirePermission('account.edit'), async (req, res, next) => {
  try {
    const result = await userService.verifyPasskeyRegistration(req.user!.sub, req.body);
    res.json({
      ok: true,
      data: result,
      meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

// DELETE /me/passkeys/:id - revoke passkey (JWT, account.edit)
router.delete('/me/passkeys/:id', authenticateJWT, requirePermission('account.edit'), async (req, res, next) => {
  try {
    await userService.revokePasskey(req.user!.sub, req.params.id);
    res.json({
      ok: true,
      data: { message: 'Passkey revoked' },
      meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

// GET /me/sessions - list sessions (JWT, account.view)
router.get('/me/sessions', authenticateJWT, requirePermission('account.view'), async (req, res, next) => {
  try {
    const result = await userService.listSessions(req.user!.sub);
    res.json({
      ok: true,
      data: result,
      meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

// DELETE /me/sessions/:id - revoke session (JWT, account.edit)
router.delete('/me/sessions/:id', authenticateJWT, requirePermission('account.edit'), async (req, res, next) => {
  try {
    await userService.revokeSession(req.user!.sub, req.params.id);
    res.json({
      ok: true,
      data: { message: 'Session revoked' },
      meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

// GET / - list users (JWT, users.view)
router.get('/', authenticateJWT, requirePermission('users.view'), async (req, res, next) => {
  try {
    const query = validateQuery(paginationSchema, req.query);
    const result = await userService.listUsers(req.user!.tid, query);
    res.json({
      ok: true,
      data: result,
      meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

// PATCH /:id - update user (JWT, users.manage)
router.patch('/:id', authenticateJWT, requirePermission('users.manage'), async (req, res, next) => {
  try {
    const data = validateBody(userUpdateSchema, req.body);
    const result = await userService.updateUser(req.user!.tid, req.params.id, data);
    res.json({
      ok: true,
      data: result,
      meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

export default router;
