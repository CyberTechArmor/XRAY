import { Router } from 'express';
import { authenticateJWT } from '../middleware/auth';
import { requirePermission } from '../middleware/rbac';
import { validateBody, validateQuery, invitationCreateSchema, invitationAcceptSchema, paginationSchema } from '../lib/validation';
import * as invitationService from '../services/invitation.service';
import { config } from '../config';

const router = Router();

// GET /info/:token - get invitation info (no auth, for pre-populating the accept form)
router.get('/info/:token', async (req, res, next) => {
  try {
    const info = await invitationService.getInvitationInfo(req.params.token);
    res.json({
      ok: true,
      data: info,
      meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

// POST /accept - accept invitation (no auth)
// Defined before /:id to avoid route conflict
router.post('/accept', async (req, res, next) => {
  try {
    const data = validateBody(invitationAcceptSchema, req.body);
    const result = await invitationService.acceptInvitation(data);

    // Set refresh cookie for auto-login
    if (result.refreshToken) {
      res.cookie('refresh_token', result.refreshToken, {
        httpOnly: true,
        secure: config.nodeEnv === 'production',
        sameSite: 'lax',
        path: '/api/auth',
        maxAge: config.jwt.refreshTokenExpiry,
      });
    }

    res.json({
      ok: true,
      data: {
        accessToken: result.accessToken,
        sessionId: result.sessionId,
        user: result.user,
        tenantId: result.tenantId,
      },
      meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

// POST / - create invitation (JWT, users.invite)
router.post('/', authenticateJWT, requirePermission('users.invite'), async (req, res, next) => {
  try {
    const data = validateBody(invitationCreateSchema, req.body);
    const result = await invitationService.createInvitation(req.user!.tid, req.user!.sub, data);
    res.status(201).json({
      ok: true,
      data: result,
      meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

// GET / - list invitations (JWT, users.invite)
router.get('/', authenticateJWT, requirePermission('users.invite'), async (req, res, next) => {
  try {
    const query = validateQuery(paginationSchema, req.query);
    const result = await invitationService.listInvitations(req.user!.tid, query);
    res.json({
      ok: true,
      data: result,
      meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

// DELETE /:id - revoke invitation (JWT, users.invite)
router.delete('/:id', authenticateJWT, requirePermission('users.invite'), async (req, res, next) => {
  try {
    await invitationService.revokeInvitation(req.user!.tid, req.params.id);
    res.json({
      ok: true,
      data: { message: 'Invitation revoked' },
      meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

export default router;
