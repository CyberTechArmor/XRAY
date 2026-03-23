import { Router } from 'express';
import { authenticateJWT } from '../middleware/auth';
import { requirePermission } from '../middleware/rbac';
import { validateBody, webhookCreateSchema, webhookUpdateSchema } from '../lib/validation';
import * as webhookService from '../services/webhook.service';

const router = Router();

// POST / - create outbound webhook
router.post('/', authenticateJWT, requirePermission('connections.view'), async (req, res, next) => {
  try {
    const data = validateBody(webhookCreateSchema, req.body);
    const result = await webhookService.createWebhook({
      tenantId: req.user!.tid,
      name: data.name,
      url: data.url,
      events: data.events,
      createdBy: req.user!.sub,
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

// GET / - list all webhooks for tenant
router.get('/', authenticateJWT, requirePermission('connections.view'), async (req, res, next) => {
  try {
    const result = await webhookService.listAllWebhooks(req.user!.tid);
    res.json({
      ok: true,
      data: result,
      meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

// GET /:id - get webhook details
router.get('/:id', authenticateJWT, requirePermission('connections.view'), async (req, res, next) => {
  try {
    const result = await webhookService.getWebhook(req.params.id, req.user!.tid);
    if (!result) {
      return res.status(404).json({
        ok: false,
        error: { code: 'NOT_FOUND', message: 'Webhook not found' },
        meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
      });
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

// PATCH /:id - update webhook
router.patch('/:id', authenticateJWT, requirePermission('connections.view'), async (req, res, next) => {
  try {
    const data = validateBody(webhookUpdateSchema, req.body);
    const result = await webhookService.updateWebhook(req.params.id, req.user!.tid, data);
    if (!result) {
      return res.status(404).json({
        ok: false,
        error: { code: 'NOT_FOUND', message: 'Webhook not found' },
        meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
      });
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

// DELETE /:id - delete webhook
router.delete('/:id', authenticateJWT, requirePermission('connections.view'), async (req, res, next) => {
  try {
    const deleted = await webhookService.deleteWebhook(req.params.id, req.user!.tid, req.user!.sub);
    if (!deleted) {
      return res.status(404).json({
        ok: false,
        error: { code: 'NOT_FOUND', message: 'Webhook not found' },
        meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
      });
    }
    res.json({
      ok: true,
      data: { message: 'Webhook deleted', id: req.params.id },
      meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

// POST /:id/regenerate-secret - regenerate webhook signing secret
router.post('/:id/regenerate-secret', authenticateJWT, requirePermission('connections.view'), async (req, res, next) => {
  try {
    const result = await webhookService.regenerateSecret(req.params.id, req.user!.tid);
    if (!result) {
      return res.status(404).json({
        ok: false,
        error: { code: 'NOT_FOUND', message: 'Webhook not found' },
        meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
      });
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

// POST /:id/test - send a test event to the webhook
router.post('/:id/test', authenticateJWT, requirePermission('connections.view'), async (req, res, next) => {
  try {
    const webhook = await webhookService.getWebhook(req.params.id, req.user!.tid);
    if (!webhook) {
      return res.status(404).json({
        ok: false,
        error: { code: 'NOT_FOUND', message: 'Webhook not found' },
        meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
      });
    }
    await webhookService.dispatchEvent(req.user!.tid, 'webhook.test', {
      message: 'This is a test event from XRay',
      webhook_name: webhook.name,
    });
    res.json({
      ok: true,
      data: { message: 'Test event dispatched' },
      meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

export default router;
