import { Router } from 'express';
import { authenticateJWT } from '../middleware/auth';
import { requirePermission } from '../middleware/rbac';
import { validateBody, validateQuery, userUpdateSchema, paginationSchema } from '../lib/validation';
import * as userService from '../services/user.service';
import * as authService from '../services/auth.service';

const router = Router();

// GET /me/tenants - list all tenants this user's email belongs to (for tenant switching)
router.get('/me/tenants', authenticateJWT, async (req, res, next) => {
  try {
    const tenants = await userService.getUserTenants(req.user!.sub);
    res.json({
      ok: true,
      data: tenants,
      meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

// POST /me/switch-tenant - switch to a different tenant
router.post('/me/switch-tenant', authenticateJWT, async (req, res, next) => {
  try {
    const { tenantId } = req.body;
    if (!tenantId) {
      return res.status(400).json({ ok: false, error: { code: 'MISSING_FIELD', message: 'tenantId is required' } });
    }
    // Get user email from current profile
    const profile = await userService.getProfile(req.user!.sub);
    const tokens = await authService.loginToTenant(profile.email, tenantId);
    // Set refresh cookie
    res.cookie('refresh_token', tokens.refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/api/auth',
      maxAge: 30 * 24 * 60 * 60 * 1000,
    });
    res.json({
      ok: true,
      data: { accessToken: tokens.accessToken, sessionId: tokens.sessionId },
      meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

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

// GET /me/settings - get user preferences
router.get('/me/settings', authenticateJWT, async (req, res, next) => {
  try {
    const result = await userService.getUserSettings(req.user!.sub);
    res.json({
      ok: true,
      data: result,
      meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

// PATCH /me/settings - update user preferences
router.patch('/me/settings', authenticateJWT, async (req, res, next) => {
  try {
    const result = await userService.updateUserSettings(req.user!.sub, req.body);
    res.json({
      ok: true,
      data: result,
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

// GET /:id/dashboard-access - list dashboards a user has access to (JWT, users.manage)
router.get('/:id/dashboard-access', authenticateJWT, requirePermission('users.manage'), async (req, res, next) => {
  try {
    const { withClient } = await import('../db/connection');
    const result = await withClient(async (client) => {
      await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
      const r = await client.query(
        `SELECT da.dashboard_id, d.name, d.status, da.created_at as granted_at
         FROM platform.dashboard_access da
         JOIN platform.dashboards d ON d.id = da.dashboard_id
         WHERE da.user_id = $1
         ORDER BY d.name`,
        [req.params.id]
      );
      return r.rows;
    });
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

// DELETE /:id - delete user (JWT, users.manage)
router.delete('/:id', authenticateJWT, requirePermission('users.manage'), async (req, res, next) => {
  try {
    // Prevent self-deletion
    if (req.params.id === req.user!.sub) {
      return res.status(400).json({ ok: false, error: { code: 'SELF_DELETE', message: 'Cannot delete your own account' } });
    }
    await userService.deleteUser(req.user!.tid, req.params.id);
    res.json({
      ok: true,
      data: { message: 'User deleted' },
      meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

export default router;
