import { Router } from 'express';
import { authenticateJWT } from '../middleware/auth';
import { requirePermission } from '../middleware/rbac';
import * as connectionService from '../services/connection.service';
import * as integrationService from '../services/integration.service';
import { withTenantContext } from '../db/connection';
import { encryptSecret } from '../lib/encrypted-column';
import { mintOAuthState, buildAuthorizeUrl } from '../lib/oauth-state';
import { config } from '../config';
import * as auditService from '../services/audit.service';
import { z } from 'zod';
import { validateBody } from '../lib/validation';

const commentSchema = z.object({
  content: z.string().min(1).max(10000),
});

const apiKeySchema = z.object({
  apiKey: z.string().min(1).max(4000),
});

const router = Router();

// ─── OAuth + API-key connection flows ──────────────────────────────────────

// Kicks off the OAuth authorization-code flow. Returns the provider's
// authorize URL; the frontend does a full-page redirect (popups are too
// fragile given provider X-Frame-Options). Per-flow state travels in a
// signed state JWT so we can remain stateless on the callback.
router.get(
  '/oauth/:slug/authorize',
  authenticateJWT,
  async (req, res, next) => {
    try {
      const integration = await integrationService.getIntegrationWithSecret(req.params.slug);
      if (!integration) {
        return res.status(404).json({
          ok: false,
          error: { code: 'INTEGRATION_NOT_FOUND', message: 'Integration not found' },
        });
      }
      if (integration.status !== 'active') {
        return res.status(409).json({
          ok: false,
          error: {
            code: 'INTEGRATION_NOT_ACTIVE',
            message: 'This integration is not active yet.',
          },
        });
      }
      if (!integration.supports_oauth) {
        return res.status(409).json({
          ok: false,
          error: {
            code: 'OAUTH_NOT_SUPPORTED',
            message: 'This integration does not offer OAuth; use the API key path instead.',
          },
        });
      }
      if (!integration.auth_url || !integration.client_id) {
        return res.status(500).json({
          ok: false,
          error: {
            code: 'INTEGRATION_CONFIG_INCOMPLETE',
            message: 'Platform admin has not finished configuring this integration.',
          },
        });
      }

      const state = mintOAuthState({
        tenantId: req.user!.tid,
        integrationId: integration.id,
        userId: req.user!.sub,
      });
      const authorizeUrl = buildAuthorizeUrl({
        authUrl: integration.auth_url,
        clientId: integration.client_id,
        redirectUri: config.oauth.redirectUri,
        scopes: integration.scopes ?? null,
        state,
        extraParams: integration.extra_authorize_params || {},
      });
      // Return the URL rather than 302 redirecting — the frontend owns
      // the navigation so it can decide between full-page redirect and
      // same-tab behavior per its modal UX.
      res.json({ ok: true, data: { authorize_url: authorizeUrl } });
    } catch (err) {
      next(err);
    }
  }
);

// API-key connect. Tenant has pasted the provider-issued API key into
// the Connect modal's API Key card; we encrypt and store it on the
// connections row, setting auth_method='api_key'. Upsert semantics
// match the OAuth callback: update-if-exists, otherwise insert.
router.post(
  '/api-key/:slug',
  authenticateJWT,
  async (req, res, next) => {
    try {
      const data = validateBody(apiKeySchema, req.body);
      const integration = await integrationService.getIntegrationWithSecret(req.params.slug);
      if (!integration) {
        return res.status(404).json({
          ok: false,
          error: { code: 'INTEGRATION_NOT_FOUND', message: 'Integration not found' },
        });
      }
      if (integration.status !== 'active') {
        return res.status(409).json({
          ok: false,
          error: { code: 'INTEGRATION_NOT_ACTIVE', message: 'This integration is not active yet.' },
        });
      }
      if (!integration.supports_api_key) {
        return res.status(409).json({
          ok: false,
          error: {
            code: 'API_KEY_NOT_SUPPORTED',
            message: 'This integration does not accept API keys; use OAuth instead.',
          },
        });
      }

      const tenantId = req.user!.tid;
      // Capture whether this call CREATED a new connection (vs. updated
      // an existing one) so the seed hook only fires on first-connect.
      // newConnectionId is set only on the INSERT path.
      const newConnectionId = await withTenantContext(tenantId, async (client) => {
        const existing = await client.query(
          `SELECT id FROM platform.connections
            WHERE tenant_id = $1 AND (integration_id = $2 OR source_type = $3)
            LIMIT 1`,
          [tenantId, integration.id, integration.slug]
        );
        if (existing.rows.length > 0) {
          await client.query(
            `UPDATE platform.connections
                SET integration_id = $2,
                    auth_method = 'api_key',
                    api_key = $3,
                    oauth_refresh_token = NULL,
                    oauth_access_token = NULL,
                    oauth_access_token_expires_at = NULL,
                    oauth_last_refreshed_at = NULL,
                    oauth_refresh_failed_count = 0,
                    oauth_last_error = NULL,
                    status = 'active',
                    updated_at = now()
              WHERE id = $1`,
            [existing.rows[0].id, integration.id, encryptSecret(data.apiKey)]
          );
          return null;
        }
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO platform.connections
             (tenant_id, name, source_type, integration_id, auth_method, api_key, status)
           VALUES ($1, $2, $3, $4, 'api_key', $5, 'active')
           RETURNING id`,
          [
            tenantId,
            integration.display_name,
            integration.slug,
            integration.id,
            encryptSecret(data.apiKey),
          ]
        );
        return inserted.rows[0].id;
      });

      auditService.log({
        tenantId,
        userId: req.user!.sub,
        action: 'connection.api_key_connected',
        resourceType: 'connection',
        resourceId: integration.id,
        metadata: { integration_slug: integration.slug },
      });

      // Seed hook: fire-and-forget on first-connect only (newConnectionId
      // is null when this was an UPDATE — token rotation, re-key, etc.).
      // Loaded dynamically to avoid pulling the import into the hot path
      // for integrations that don't use seed URLs.
      if (newConnectionId) {
        const { fireSeedHookForConnection } = await import('../services/seed-hook.service');
        void fireSeedHookForConnection({
          integrationId: integration.id,
          tenantId,
          connectionId: newConnectionId,
        });
      }

      try {
        const { broadcastToTenant } = await import('../ws');
        broadcastToTenant(tenantId, 'integration:connected', { slug: integration.slug });
      } catch {}

      res.json({ ok: true, data: { slug: integration.slug, auth_method: 'api_key' } });
    } catch (err) {
      next(err);
    }
  }
);

// Disconnect. Clears the OAuth/API-key state on the tenant's connection
// row but keeps the row so historical dashboards still reference it.
// Tenant re-connecting later just writes fresh credentials.
router.post(
  '/disconnect/:slug',
  authenticateJWT,
  async (req, res, next) => {
    try {
      const integration = await integrationService.getIntegrationWithSecret(req.params.slug);
      if (!integration) {
        return res.status(404).json({
          ok: false,
          error: { code: 'INTEGRATION_NOT_FOUND', message: 'Integration not found' },
        });
      }
      const tenantId = req.user!.tid;
      await withTenantContext(tenantId, async (client) => {
        await client.query(
          `UPDATE platform.connections
              SET oauth_refresh_token = NULL,
                  oauth_access_token = NULL,
                  oauth_access_token_expires_at = NULL,
                  oauth_last_refreshed_at = NULL,
                  oauth_refresh_failed_count = 0,
                  oauth_last_error = NULL,
                  api_key = NULL,
                  status = 'pending',
                  updated_at = now()
            WHERE tenant_id = $1 AND integration_id = $2`,
          [tenantId, integration.id]
        );
      });
      auditService.log({
        tenantId,
        userId: req.user!.sub,
        action: 'connection.disconnected',
        resourceType: 'connection',
        resourceId: integration.id,
        metadata: { integration_slug: integration.slug },
      });
      try {
        const { broadcastToTenant } = await import('../ws');
        broadcastToTenant(tenantId, 'integration:disconnected', { slug: integration.slug });
      } catch {}
      res.json({ ok: true, data: { slug: integration.slug } });
    } catch (err) {
      next(err);
    }
  }
);

// My Integrations list — visible only to tenant owner + platform admin.
// Returns each active integration plus the tenant's current connection
// state so the frontend can render status pills.
router.get('/my-integrations', authenticateJWT, async (req, res, next) => {
  try {
    if (!req.user!.is_owner && !req.user!.is_platform_admin) {
      return res.status(403).json({
        ok: false,
        error: { code: 'FORBIDDEN', message: 'Only the owner or platform admin can view integrations' },
      });
    }
    const rows = await integrationService.listActiveForTenant(req.user!.tid);
    res.json({ ok: true, data: rows });
  } catch (err) {
    next(err);
  }
});

// GET / - list connections (JWT, connections.view)
router.get('/', authenticateJWT, requirePermission('connections.view'), async (req, res, next) => {
  try {
    const result = await connectionService.listConnections(req.user!.tid);
    res.json({
      ok: true,
      data: result,
      meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

// GET /:id - get connection with tables (JWT, connections.view)
router.get('/:id', authenticateJWT, requirePermission('connections.view'), async (req, res, next) => {
  try {
    const result = await connectionService.getConnection(req.user!.tid, req.params.id);
    res.json({
      ok: true,
      data: result,
      meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

// POST / - create connection (JWT, connections.manage)
router.post('/', authenticateJWT, requirePermission('connections.manage'), async (req, res, next) => {
  try {
    const { createConnection } = await import('../services/admin.service');
    const result = await createConnection({
      tenantId: req.user!.tid,
      name: req.body.name,
      sourceType: req.body.sourceType,
      sourceDetail: req.body.sourceDetail,
      pipelineRef: req.body.pipelineRef,
      description: req.body.description,
      connectionDetails: req.body.details,
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

// POST /:id/comments - add comment (JWT, connections.view)
router.post('/:id/comments', authenticateJWT, requirePermission('connections.view'), async (req, res, next) => {
  try {
    const data = validateBody(commentSchema, req.body);
    const { createConnectionComment } = await import('../services/admin.service');
    const result = await createConnectionComment(req.params.id, req.user!.sub, data.content);
    res.status(201).json({
      ok: true,
      data: result,
      meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

// GET /:id/comments - list comments with pagination (JWT, connections.view)
router.get('/:id/comments', authenticateJWT, requirePermission('connections.view'), async (req, res, next) => {
  try {
    const { listConnectionComments } = await import('../services/admin.service');
    const comments = await listConnectionComments(req.params.id);
    const limit = parseInt(req.query.limit as string, 10) || 50;
    const offset = parseInt(req.query.offset as string, 10) || 0;
    const paginated = comments.slice(offset, offset + limit);
    res.json({
      ok: true,
      data: paginated,
      meta: {
        total: comments.length,
        limit,
        offset,
        request_id: req.headers['x-request-id'] || '',
        timestamp: new Date().toISOString(),
      },
    });
  } catch (err) {
    next(err);
  }
});

export default router;
