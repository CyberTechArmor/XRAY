import { Router } from 'express';
import { authenticateJWT } from '../middleware/auth';
import { requirePermission } from '../middleware/rbac';
import { validateBody, webhookCreateSchema, webhookUpdateSchema } from '../lib/validation';
import * as webhookService from '../services/webhook.service';

const router = Router();

// ==========================================
// Inbound webhook endpoint (API key auth)
// ==========================================

// POST /ingest/:urlToken - receive data from external services (e.g., n8n)
// Authenticated via API key bearer token
router.post('/ingest/:urlToken', authenticateJWT, async (req, res, next) => {
  try {
    const webhook = await webhookService.validateInboundWebhook(req.params.urlToken);
    if (!webhook) {
      res.status(404).json({
        ok: false,
        error: { code: 'NOT_FOUND', message: 'Webhook not found or inactive' },
        meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
      });
      return;
    }

    // Verify the API key has the webhook.ingest scope or platform.admin
    const user = req.user!;
    const hasScope = user.permissions.includes('webhook.ingest') ||
                     user.permissions.includes('platform.admin') ||
                     user.is_platform_admin;

    if (!hasScope) {
      res.status(403).json({
        ok: false,
        error: { code: 'FORBIDDEN', message: 'API key lacks webhook.ingest scope' },
        meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
      });
      return;
    }

    // Return webhook metadata + accepted payload for pipeline processing
    res.json({
      ok: true,
      data: {
        accepted: true,
        webhook_id: webhook.id,
        connection_id: webhook.connection_id,
        connection_name: webhook.connection_name,
        tenant_id: webhook.tenant_id,
        event: req.body.event || 'data.push',
        payload_size: JSON.stringify(req.body).length,
        received_at: new Date().toISOString(),
      },
      meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
    });
  } catch (err) {
    // Record failure
    if (req.params.urlToken) {
      webhookService.recordFailure(req.params.urlToken).catch(() => {});
    }
    next(err);
  }
});

// ==========================================
// Webhook management endpoints (JWT auth)
// ==========================================

// POST / - create webhook for a connection
router.post('/', authenticateJWT, requirePermission('connections.view'), async (req, res, next) => {
  try {
    const data = validateBody(webhookCreateSchema, req.body);
    const result = await webhookService.createWebhook({
      connectionId: data.connectionId,
      tenantId: req.user!.tid,
      name: data.name,
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

// GET /connection/:connectionId - list webhooks for a connection
router.get('/connection/:connectionId', authenticateJWT, requirePermission('connections.view'), async (req, res, next) => {
  try {
    const result = await webhookService.listWebhooks(req.params.connectionId, req.user!.tid);
    res.json({
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
      res.status(404).json({
        ok: false,
        error: { code: 'NOT_FOUND', message: 'Webhook not found' },
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

// PATCH /:id - update webhook
router.patch('/:id', authenticateJWT, requirePermission('connections.view'), async (req, res, next) => {
  try {
    const data = validateBody(webhookUpdateSchema, req.body);
    const result = await webhookService.updateWebhook(req.params.id, req.user!.tid, data);
    if (!result) {
      res.status(404).json({
        ok: false,
        error: { code: 'NOT_FOUND', message: 'Webhook not found' },
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

// DELETE /:id - delete webhook
router.delete('/:id', authenticateJWT, requirePermission('connections.view'), async (req, res, next) => {
  try {
    const deleted = await webhookService.deleteWebhook(req.params.id, req.user!.tid, req.user!.sub);
    if (!deleted) {
      res.status(404).json({
        ok: false,
        error: { code: 'NOT_FOUND', message: 'Webhook not found' },
        meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
      });
      return;
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
      res.status(404).json({
        ok: false,
        error: { code: 'NOT_FOUND', message: 'Webhook not found' },
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

export default router;
