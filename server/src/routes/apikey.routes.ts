import { Router } from 'express';
import { authenticateJWT } from '../middleware/auth';
import { requirePermission } from '../middleware/rbac';
import { validateBody, apiKeyCreateSchema } from '../lib/validation';
import * as apikeyService from '../services/apikey.service';

const router = Router();

// All API key routes require JWT + platform.admin
router.use(authenticateJWT, requirePermission('platform.admin'));

// POST / - create API key
router.post('/', async (req, res, next) => {
  try {
    const data = validateBody(apiKeyCreateSchema, req.body);
    const result = await apikeyService.createApiKey({
      name: data.name,
      scopes: data.scopes,
      createdBy: req.user!.sub,
      tenantId: data.tenantId,
      expiresAt: data.expiresAt,
    });
    res.status(201).json({
      ok: true,
      data: result,
      meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

// GET / - list API keys
router.get('/', async (req, res, next) => {
  try {
    const result = await apikeyService.listApiKeys();
    res.json({
      ok: true,
      data: result,
      meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

// GET /:id - get single API key
router.get('/:id', async (req, res, next) => {
  try {
    const result = await apikeyService.getApiKey(req.params.id);
    if (!result) {
      res.status(404).json({
        ok: false,
        error: { code: 'NOT_FOUND', message: 'API key not found' },
        meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
      });
      return;
    }
    res.json({
      ok: true,
      data: result,
      meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

// DELETE /:id - revoke API key
router.delete('/:id', async (req, res, next) => {
  try {
    const result = await apikeyService.revokeApiKey(req.params.id, req.user!.sub);
    if (!result) {
      res.status(404).json({
        ok: false,
        error: { code: 'NOT_FOUND', message: 'API key not found' },
        meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
      });
      return;
    }
    res.json({
      ok: true,
      data: { message: 'API key revoked', id: req.params.id },
      meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

export default router;
