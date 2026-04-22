import { Router } from 'express';
import { authenticateJWT } from '../middleware/auth';
import { requirePermission } from '../middleware/rbac';
import { validateBody, dashboardAccessSchema, embedCreateSchema } from '../lib/validation';
import { decryptSecret } from '../lib/encrypted-column';
import { mintBridgeJwt } from '../lib/n8n-bridge';
import { mintPipelineJwt, isPipelineJwtConfigured } from '../lib/pipeline-jwt';
import * as dashboardService from '../services/dashboard.service';
import * as aiService from '../services/ai.service';
import * as auditService from '../services/audit.service';
import * as integrationService from '../services/integration.service';
import { getSetting } from '../services/settings.service';
import { config } from '../config';

// Builds the AI bootstrap for a dashboard render response. Returns BOTH a
// prefix (runs before any dashboard markup) and a suffix (loads the SDK
// after). The prefix installs a stub window.XRayAI whose register() call
// just queues configs; the real SDK drains that queue on load. This
// guarantees the dashboard's own <script>window.XRayAI.register(...)</script>
// call works no matter whether it runs before or after the SDK loads.
//
// Why this exists: the bundle's dashboard render inserts the whole HTML blob
// then re-creates every <script> via document.createElement in DOM order.
// The dashboard's register script usually appears before our appended SDK
// script, so at the moment it runs window.XRayAI would otherwise be
// undefined — the registration would silently drop (the documented snippet
// bails with `if (!window.XRayAI) return;`).
async function buildAiBootstrap(
  dashboardId: string,
  userId: string
): Promise<{ ai: Record<string, unknown>; htmlPrefix: string; htmlSuffix: string } | null> {
  try {
    const avail = await aiService.isAiAvailableForUser(userId, dashboardId);
    if (!avail.available) {
      return { ai: { available: false, reason: avail.reason || null }, htmlPrefix: '', htmlSuffix: '' };
    }
    // Dashboard ids are UUIDs but sanitize for defense in depth.
    const safeId = String(dashboardId).replace(/[^a-zA-Z0-9_-]/g, '');
    const htmlPrefix =
      `\n<script>` +
      `window.__xrayCurrentDashboardId=${JSON.stringify(safeId)};` +
      // Stub: register(cfg) queues onto _pending until the real SDK loads
      // and drains it. If the real SDK is already loaded (e.g. user navigates
      // between two dashboards), leave it alone.
      `if(!window.XRayAI||!window.XRayAI._booted){` +
      `window.XRayAI=window.XRayAI||{};` +
      `window.XRayAI._pending=window.XRayAI._pending||[];` +
      `if(typeof window.XRayAI.register!=='function'){` +
      `window.XRayAI.register=function(c){window.XRayAI._pending.push(c);};` +
      `}}` +
      `</script>`;
    const htmlSuffix =
      `\n<link rel="stylesheet" href="/ai/sdk.css">` +
      `\n<script src="/ai/sdk.js" defer></script>`;
    return { ai: { available: true, dashboardId }, htmlPrefix, htmlSuffix };
  } catch {
    return null;
  }
}

const router = Router();

// GET / - list dashboards (JWT, dashboards.view)
router.get('/', authenticateJWT, requirePermission('dashboards.view'), async (req, res, next) => {
  try {
    const hasManage = req.user!.permissions.includes('dashboards.manage') || req.user!.is_platform_admin;
    const result = await dashboardService.listDashboards(req.user!.tid, req.user!.sub, hasManage, req.user!.is_platform_admin);
    res.json({
      ok: true,
      data: result,
      meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

// GET /:id - get dashboard (JWT, dashboards.view)
router.get('/:id', authenticateJWT, requirePermission('dashboards.view'), async (req, res, next) => {
  try {
    const result = await dashboardService.getDashboard(req.params.id, req.user!.tid);

    // Non-admin/owner users must have explicit dashboard_access
    if (!req.user!.is_platform_admin && !req.user!.is_owner && !req.user!.permissions?.includes('dashboards.manage')) {
      const hasAccess = await dashboardService.checkUserAccess(req.params.id, req.user!.sub);
      if (!hasAccess) {
        return res.status(403).json({
          ok: false,
          error: { code: 'FORBIDDEN', message: 'You do not have access to this dashboard' },
          meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
        });
      }
    }

    // Audit log: dashboard opened
    try {
      const auditService = await import('../services/audit.service');
      auditService.log({
        tenantId: req.user!.tid,
        userId: req.user!.sub,
        action: 'dashboard.opened',
        resourceType: 'dashboard',
        resourceId: req.params.id,
        metadata: { name: result.name || '' },
      });
    } catch (_) {}

    // Dispatch dashboard.opened webhook directly (audit dispatch is fire-and-forget, may not complete)
    import('../services/webhook.service').then(wh => {
      return wh.dispatchEvent(req.user!.tid, 'dashboard.opened', {
        dashboardId: req.params.id,
        dashboardName: result.name || '',
        userId: req.user!.sub,
      });
    }).catch(() => {});

    res.json({
      ok: true,
      data: result,
      meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

// POST /:id/render - fetch dashboard content from n8n connection (JWT, dashboards.view)
router.post('/:id/render', authenticateJWT, requirePermission('dashboards.view'), async (req, res, next) => {
  try {
    const { withClient } = await import('../db/connection');

    // Separate SELECT then UPDATE to avoid RLS issues with UPDATE...RETURNING.
    // Step 4b: the SELECT handles BOTH scope='tenant' and scope='global'.
    // - Tenant rows: d.tenant_id is the rendering tenant; JOIN platform.tenants
    //   against d.tenant_id works directly.
    // - Global rows: d.tenant_id is NULL; the rendering tenant is req.user.tid.
    //   JOIN platform.tenants against COALESCE(d.tenant_id, req.user.tid) so
    //   tenant_* JWT claims load the rendering tenant's row.
    // The integration-gated / grant-gated permission check runs AFTER the
    // SELECT — the row SELECT itself doesn't try to encode it in WHERE.
    const dashboard = await withClient(async (client) => {
      await client.query(`SELECT set_config('app.is_platform_admin', $1, true)`, [String(req.user!.is_platform_admin)]);
      if (req.user!.tid) {
        await client.query(`SELECT set_config('app.current_tenant', $1, true)`, [req.user!.tid]);
      }
      const baseSelect = `
        SELECT d.id, d.tenant_id AS dashboard_tenant_id, d.scope,
               d.name AS dashboard_name, d.status AS dashboard_status,
               d.fetch_url, d.fetch_method, d.fetch_body, d.fetch_query_params,
               d.view_html, d.view_css, d.view_js, d.template_id, d.integration, d.params,
               d.bridge_secret, d.is_public,
               COALESCE(d.tenant_id, $3::uuid) AS rendering_tenant_id,
               t.slug AS tenant_slug, t.name AS tenant_name, t.status AS tenant_status,
               t.warehouse_host,
               u.email AS user_email, u.name AS user_name,
               r.slug AS user_role
          FROM platform.dashboards d
          LEFT JOIN platform.tenants t ON t.id = COALESCE(d.tenant_id, $3::uuid)
          LEFT JOIN platform.users u ON u.id = $2
          LEFT JOIN platform.roles r ON r.id = u.role_id`;
      // Tenant users see their own tenant's rows + every Global.
      // Platform admins see every row. Global rows' permission gate
      // (integration / grant) runs post-SELECT.
      const query = req.user!.is_platform_admin
        ? {
            text: `${baseSelect} WHERE d.id = $1 AND d.status = 'active'`,
            values: [req.params.id, req.user!.sub, req.user!.tid],
          }
        : {
            text: `${baseSelect} WHERE d.id = $1 AND d.status = 'active' AND (d.scope = 'global' OR d.tenant_id = $3)`,
            values: [req.params.id, req.user!.sub, req.user!.tid],
          };
      const result = await client.query(query);
      if (result.rows[0]) {
        // Side-effects: update last_viewed_at and track views. last_viewed_at
        // stays on the dashboard row — it's a single "when was this last
        // touched" signal, not per-tenant. View count stays per-user.
        await client.query(
          `UPDATE platform.dashboards SET last_viewed_at = now() WHERE id = $1`,
          [req.params.id]
        ).catch(() => {});
        if (!req.user!.is_platform_admin) {
          await client.query(
            `INSERT INTO platform.dashboard_views (dashboard_id, user_id) VALUES ($1, $2)`,
            [req.params.id, req.user!.sub]
          ).catch(() => {});
        }
      }
      return result.rows[0];
    });

    if (!dashboard) {
      return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Dashboard not found or inactive' } });
    }

    const isGlobal = dashboard.scope === 'global';
    const renderingTenantId: string = dashboard.rendering_tenant_id;
    if (!renderingTenantId) {
      // Admin rendering a Global without a home tenant — nothing to bind
      // credentials to. Preview UI should pass via the admin service
      // with a chosen tenant; the render route itself assumes req.user.tid.
      return res.status(400).json({
        ok: false,
        error: {
          code: 'RENDERING_TENANT_REQUIRED',
          message: 'Rendering a Global dashboard requires a tenant context.',
        },
      });
    }

    // Custom Global (no integration) — tenant must have an explicit
    // grant. Integration-connected Globals skip this branch; the
    // resolveAccessTokenForRender gate below serves as their auth.
    if (isGlobal && !dashboard.integration) {
      const grant = await withClient(async (client) => {
        await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
        const r = await client.query(
          `SELECT 1 FROM platform.dashboard_tenant_grants
            WHERE dashboard_id = $1 AND tenant_id = $2`,
          [dashboard.id, renderingTenantId]
        );
        return r.rows.length > 0;
      });
      if (!grant && !req.user!.is_platform_admin) {
        return res.status(403).json({
          ok: false,
          error: {
            code: 'GLOBAL_NOT_GRANTED',
            message: 'This Global dashboard is not granted to your tenant.',
          },
        });
      }
    }

    // If dashboard has no fetch_url, return static content directly. For
    // Globals this is the Custom Global path — render the stored HTML
    // under the rendering tenant's context. No per-tenant variation on
    // the content itself, but the future might want per-tenant
    // substitution — keyed on the cache table already.
    if (!dashboard.fetch_url) {
      const boot = await buildAiBootstrap(req.params.id, req.user!.sub);
      return res.json({
        ok: true,
        data: {
          html: (boot?.htmlPrefix || '') + (dashboard.view_html || '') + (boot?.htmlSuffix || ''),
          css: dashboard.view_css || '',
          js: dashboard.view_js || '',
          ai: boot?.ai || { available: false },
        },
      });
    }

    // Proxy fetch to n8n through the JWT bridge: mint an HS256 token per
    // render and send it as Authorization: Bearer. The legacy
    // fetch_headers path was dropped in step 3 (migration 020); every
    // dashboard with a fetch_url must now carry an `integration` +
    // encrypted `bridge_secret`. The cutover-safety check in the step-3
    // kickoff guarantees status='active' rows satisfy this before
    // migration 020 applies, and the SELECT above gates on
    // status='active'. A row that reaches here without integration set
    // is a config error, not a legacy path — surface it as 500.
    if (!dashboard.integration) {
      return res.status(500).json({
        ok: false,
        error: {
          code: 'BRIDGE_INTEGRATION_MISSING',
          message: 'This dashboard has a fetch_url but no integration configured. Set Integration + Bridge signing secret in the dashboard builder.',
        },
      });
    }
    const bridgeSecret = decryptSecret(
      dashboard.bridge_secret,
      `dashboards:bridge_secret:${dashboard.id}`
    );
    if (!bridgeSecret) {
      return res.status(500).json({
        ok: false,
        error: {
          code: 'BRIDGE_SECRET_MISSING',
          message: 'This dashboard has an integration but no bridge signing secret. Set one in the dashboard builder.',
        },
      });
    }
    // `via` distinguishes a tenant user rendering their own dashboard
    // (authed_render) from a platform admin rendering someone else's
    // (admin_impersonation). For Global dashboards the rendering tenant
    // IS the admin's own tenant (the Global isn't "owned" by any one
    // tenant), so admin_impersonation only kicks in for Tenant-scoped
    // rows that belong to a different tenant.
    const actingVia: 'authed_render' | 'admin_impersonation' =
      req.user!.is_platform_admin &&
      !isGlobal &&
      dashboard.dashboard_tenant_id !== req.user!.tid
        ? 'admin_impersonation'
        : 'authed_render';

    // Resolve the RENDERING tenant's OAuth / API-key credential for
    // this integration. For Tenant rows this is dashboard.tenant_id
    // (= renderingTenantId). For Globals it's the requester's tenant.
    // Either way the resolver is identical — the 4-state outcome
    // (ready / not_connected / needs_reconnect / unknown_integration)
    // plus the step-4 409 semantics carry over.
    const tokenResult = await integrationService.resolveAccessTokenForRender(
      renderingTenantId,
      dashboard.integration
    );
    if (tokenResult.kind === 'needs_reconnect') {
      return res.status(409).json({
        ok: false,
        error: {
          code: 'OAUTH_NOT_CONNECTED',
          message: 'This integration needs to be reconnected before the dashboard can render.',
          integration: dashboard.integration,
        },
      });
    }
    const accessToken =
      tokenResult.kind === 'ready' ? tokenResult.accessToken : null;
    const authMethod =
      tokenResult.kind === 'ready' ? tokenResult.authMethod : null;

    const minted = mintBridgeJwt({
      tenantId: renderingTenantId,
      tenantSlug: dashboard.tenant_slug,
      tenantName: dashboard.tenant_name,
      tenantStatus: dashboard.tenant_status,
      warehouseHost: dashboard.warehouse_host,
      dashboardId: dashboard.id,
      dashboardName: dashboard.dashboard_name,
      dashboardStatus: dashboard.dashboard_status,
      isPublic: dashboard.is_public,
      templateId: dashboard.template_id || null,
      integration: dashboard.integration,
      params: (dashboard.params as Record<string, unknown>) || {},
      userId: req.user!.sub,
      userEmail: dashboard.user_email,
      userName: dashboard.user_name,
      userRole: dashboard.user_role,
      isPlatformAdmin: !!req.user!.is_platform_admin,
      via: actingVia,
      secret: bridgeSecret,
      accessToken,
      authMethod,
    });
    const parsedHeaders: Record<string, string> = { Authorization: `Bearer ${minted.jwt}` };

    // Mint the RS256 pipeline data-access JWT alongside the bridge JWT
    // and ride it in a sibling header. No consumer on the pipeline DB
    // side yet (Model J lands post-step-6); this is the minting half of
    // that contract. Absent-keypair path skips cleanly.
    let pipelineJti: string | null = null;
    if (isPipelineJwtConfigured()) {
      const pipelineMinted = mintPipelineJwt({
        tenantId: renderingTenantId,
        userId: req.user!.sub,
        isPlatformAdmin: !!req.user!.is_platform_admin,
        via: actingVia,
      });
      pipelineJti = pipelineMinted.jti;
      parsedHeaders['X-XRay-Pipeline-Token'] = `Bearer ${pipelineMinted.jwt}`;
    }

    // Audit-log the mint so a leaked token can be traced back to
    // (tenant, user, dashboard). Fire-and-forget, matches the existing
    // audit pattern elsewhere in this file. `via` mirrors the JWT
    // claim so the audit row is self-contained for SOC 2 review.
    auditService.log({
      tenantId: renderingTenantId,
      userId: req.user!.sub,
      action: 'dashboard.bridge_mint',
      resourceType: 'dashboard',
      resourceId: dashboard.id,
      metadata: {
        jti: minted.jti,
        pipeline_jti: pipelineJti,
        integration: dashboard.integration,
        template_id: dashboard.template_id || null,
        via: actingVia,
        auth_method: authMethod,
        access_token_present: !!accessToken,
        scope: dashboard.scope,
        dashboard_tenant_id: dashboard.dashboard_tenant_id,
      },
    });

    // Build fetch URL with query params
    let fetchUrl = dashboard.fetch_url;
    if (dashboard.fetch_query_params) {
      const qp = typeof dashboard.fetch_query_params === 'string'
        ? JSON.parse(dashboard.fetch_query_params) : dashboard.fetch_query_params;
      if (qp && typeof qp === 'object' && Object.keys(qp).length > 0) {
        const url = new URL(fetchUrl);
        for (const [k, v] of Object.entries(qp)) {
          url.searchParams.set(k, String(v));
        }
        fetchUrl = url.toString();
      }
    }

    // Attempt upstream fetch with up to 3 tries (initial + 2 retries)
    const MAX_ATTEMPTS = 3;
    const RETRY_DELAYS = [1500, 3000]; // ms between retries
    let lastError: string = '';

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const fetchOpts: RequestInit = {
          method: dashboard.fetch_method || 'GET',
          headers: { 'Content-Type': 'application/json', ...parsedHeaders },
          signal: AbortSignal.timeout(30_000),
        };
        if (dashboard.fetch_body && dashboard.fetch_method !== 'GET') {
          fetchOpts.body = typeof dashboard.fetch_body === 'string'
            ? dashboard.fetch_body : JSON.stringify(dashboard.fetch_body);
        }

        const response = await fetch(fetchUrl, fetchOpts);

        if (!response.ok) {
          lastError = `Connection returned ${response.status}`;
          if (attempt < MAX_ATTEMPTS) {
            await new Promise(r => setTimeout(r, RETRY_DELAYS[attempt - 1]));
            continue;
          }
          break;
        }

        // Success — parse the response
        const contentType = response.headers.get('content-type') || '';
        let data: { html?: string; css?: string; js?: string };
        if (contentType.includes('application/json')) {
          data = await response.json();
        } else {
          const html = await response.text();
          data = { html, css: '', js: '' };
        }

        // Cache the successful render. Step 4b: writes to
        // dashboard_render_cache keyed on (dashboard_id, rendering
        // tenant) so Global dashboards get a cache row per rendering
        // tenant (no more racing clobber). Tenant-scoped rows ALSO
        // continue to dual-write the legacy view_html/view_css/view_js
        // columns on platform.dashboards for non-render readers that
        // still expect them (embed, portability, admin preview
        // fallback). Retiring those columns is a post-step cleanup.
        if (data && (data.html || data.css || data.js)) {
          withClient(async (client) => {
            await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
            await client.query(
              `INSERT INTO platform.dashboard_render_cache
                 (dashboard_id, tenant_id, view_html, view_css, view_js, rendered_at)
               VALUES ($1, $2, $3, $4, $5, now())
               ON CONFLICT (dashboard_id, tenant_id) DO UPDATE
                 SET view_html = EXCLUDED.view_html,
                     view_css = EXCLUDED.view_css,
                     view_js = EXCLUDED.view_js,
                     rendered_at = now()`,
              [dashboard.id, renderingTenantId, data.html || '', data.css || '', data.js || '']
            );
            if (dashboard.scope === 'tenant') {
              await client.query(
                `UPDATE platform.dashboards SET view_html = $1, view_css = $2, view_js = $3 WHERE id = $4`,
                [data.html || '', data.css || '', data.js || '', dashboard.id]
              );
            }
          }).catch(() => {}); // fire-and-forget cache write
        }

        // Inject AI SDK bootstrap if AI is enabled for (user, dashboard)
        const boot = await buildAiBootstrap(req.params.id, req.user!.sub);
        const augmented = {
          ...data,
          html: (boot?.htmlPrefix || '') + (data.html || '') + (boot?.htmlSuffix || ''),
          ai: boot?.ai || { available: false },
        };
        return res.json({ ok: true, data: augmented });
      } catch (fetchErr) {
        lastError = 'Connection unreachable';
        if (attempt < MAX_ATTEMPTS) {
          await new Promise(r => setTimeout(r, RETRY_DELAYS[attempt - 1]));
          continue;
        }
      }
    }

    // All attempts failed — fall back to cached static content. Read
    // from dashboard_render_cache keyed on (dashboard, rendering
    // tenant) first. For Tenant-scoped rows, fall back to the legacy
    // view_html/view_css/view_js columns if the cache row hasn't been
    // populated yet (e.g. first render ever, upstream was down).
    const cached = await withClient(async (client) => {
      await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
      const r = await client.query(
        `SELECT view_html, view_css, view_js FROM platform.dashboard_render_cache
          WHERE dashboard_id = $1 AND tenant_id = $2`,
        [dashboard.id, renderingTenantId]
      );
      return r.rows[0] || null;
    });
    const fallbackHtml = cached?.view_html || (dashboard.scope === 'tenant' ? dashboard.view_html : null);
    const fallbackCss = cached?.view_css || (dashboard.scope === 'tenant' ? dashboard.view_css : null);
    const fallbackJs = cached?.view_js || (dashboard.scope === 'tenant' ? dashboard.view_js : null);
    if (fallbackHtml) {
      const boot = await buildAiBootstrap(req.params.id, req.user!.sub);
      return res.json({
        ok: true,
        data: {
          html: (boot?.htmlPrefix || '') + fallbackHtml + (boot?.htmlSuffix || ''),
          css: fallbackCss || '',
          js: fallbackJs || '',
          ai: boot?.ai || { available: false },
        },
        meta: { fallback: true },
      });
    }

    return res.status(502).json({ ok: false, error: { code: 'UPSTREAM_ERROR', message: lastError || 'Connection failed' } });
  } catch (err) {
    next(err);
  }
});

// GET /:id/access - list users with access to dashboard (JWT, dashboards.manage)
router.get('/:id/access', authenticateJWT, requirePermission('dashboards.manage'), async (req, res, next) => {
  try {
    const result = await dashboardService.getAccessList(req.params.id);
    res.json({
      ok: true,
      data: result,
      meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

// GET /:id/team-access - list ALL tenant users with their access status (JWT, dashboards.view)
router.get('/:id/team-access', authenticateJWT, async (req, res, next) => {
  try {
    const { withClient } = await import('../db/connection');
    const result = await withClient(async (client) => {
      await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
      // Get the dashboard's tenant
      const dashRow = await client.query('SELECT tenant_id FROM platform.dashboards WHERE id = $1', [req.params.id]);
      if (dashRow.rows.length === 0) return [];
      const tenantId = dashRow.rows[0].tenant_id;
      // Get all users in this tenant with their access status for this dashboard
      const users = await client.query(
        `SELECT u.id, u.email, u.name, u.is_owner,
                CASE WHEN da.id IS NOT NULL THEN true ELSE false END as has_access
         FROM platform.users u
         LEFT JOIN platform.dashboard_access da ON da.user_id = u.id AND da.dashboard_id = $1
         WHERE u.tenant_id = $2 AND u.status = 'active'
         ORDER BY u.is_owner DESC, u.name ASC`,
        [req.params.id, tenantId]
      );
      return users.rows;
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

// POST /:id/access - grant access to dashboard (JWT, dashboards.manage)
router.post('/:id/access', authenticateJWT, requirePermission('dashboards.manage'), async (req, res, next) => {
  try {
    const data = validateBody(dashboardAccessSchema, req.body);
    await dashboardService.grantAccess(req.params.id, data.userId, req.user!.sub, req.user!.tid);
    // Broadcast visibility change via WebSocket
    try {
      const { sendToUser } = await import('../ws');
      sendToUser(data.userId, 'dashboard:access-granted', { dashboardId: req.params.id });
    } catch {}
    res.status(201).json({
      ok: true,
      data: { message: 'Access granted' },
      meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

// DELETE /:id/access/:uid - revoke access to dashboard (JWT, dashboards.manage)
router.delete('/:id/access/:uid', authenticateJWT, requirePermission('dashboards.manage'), async (req, res, next) => {
  try {
    await dashboardService.revokeAccess(req.params.id, req.params.uid);
    // Broadcast visibility change via WebSocket
    try {
      const { sendToUser } = await import('../ws');
      sendToUser(req.params.uid, 'dashboard:access-revoked', { dashboardId: req.params.id });
    } catch {}
    res.json({
      ok: true,
      data: { message: 'Access revoked' },
      meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

// Helper: resolve the tenant_id for a dashboard (platform admin can access any tenant)
async function resolveDashboardTenant(dashboardId: string, user: any): Promise<string> {
  if (!user.is_platform_admin) return user.tid;
  const { withClient } = await import('../db/connection');
  return withClient(async (client) => {
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
    const result = await client.query(
      'SELECT tenant_id FROM platform.dashboards WHERE id = $1',
      [dashboardId]
    );
    if (result.rows.length === 0) {
      const { AppError } = await import('../middleware/error-handler');
      throw new AppError(404, 'DASHBOARD_NOT_FOUND', 'Dashboard not found');
    }
    return result.rows[0].tenant_id;
  });
}

// POST /:id/share - create share link (default: internal, admin-only access to link)
router.post('/:id/share', authenticateJWT, async (req, res, next) => {
  try {
    if (!req.user!.is_owner && !req.user!.is_platform_admin) {
      return res.status(403).json({ ok: false, error: { code: 'FORBIDDEN', message: 'Only the owner or super admin can share dashboards' } });
    }
    const tenantId = await resolveDashboardTenant(req.params.id, req.user!);
    const result = await dashboardService.makePublic(req.params.id, tenantId);
    const shareDomain = (await getSetting('platform.share_domain')) || (await getSetting('platform.domain')) || config.webauthn.origin;
    const shareUrl = `${shareDomain.replace(/\/+$/, '')}/share/${result.public_token}`;

    // Dispatch dashboard.published webhook event
    import('../services/webhook.service').then(wh => {
      wh.dispatchEvent(tenantId, 'dashboard.published', {
        dashboardId: req.params.id,
        publicToken: result.public_token,
        shareUrl,
        userId: req.user!.sub,
      });
    }).catch(() => {});

    res.json({
      ok: true,
      data: { public_token: result.public_token, share_url: shareUrl, is_public: result.is_public },
      meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

// PATCH /:id/share - toggle internal/public visibility (owner or platform admin only)
router.patch('/:id/share', authenticateJWT, async (req, res, next) => {
  try {
    if (!req.user!.is_owner && !req.user!.is_platform_admin) {
      return res.status(403).json({ ok: false, error: { code: 'FORBIDDEN', message: 'Only the owner or super admin can manage sharing' } });
    }
    const { is_public } = req.body;
    const { withClient } = await import('../db/connection');
    await withClient(async (client) => {
      await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
      await client.query(
        'UPDATE platform.dashboards SET is_public = $1, updated_at = now() WHERE id = $2',
        [!!is_public, req.params.id]
      );
    });
    // Clear share page cache so toggling takes effect immediately
    try { const { clearShareCache } = await import('./share.routes'); clearShareCache(); } catch {}
    // Broadcast to tenant for real-time UI update
    try {
      const tenantId = await resolveDashboardTenant(req.params.id, req.user!);
      const { broadcastToTenant } = await import('../ws');
      broadcastToTenant(tenantId, 'dashboard:share-changed', { dashboardId: req.params.id, is_public: !!is_public });
    } catch {}
    res.json({
      ok: true,
      data: { is_public: !!is_public },
      meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

// DELETE /:id/share - revoke share link entirely (owner or platform admin only)
router.delete('/:id/share', authenticateJWT, async (req, res, next) => {
  try {
    if (!req.user!.is_owner && !req.user!.is_platform_admin) {
      return res.status(403).json({ ok: false, error: { code: 'FORBIDDEN', message: 'Only the owner or super admin can manage public sharing' } });
    }
    const tenantId = await resolveDashboardTenant(req.params.id, req.user!);
    await dashboardService.makePrivate(req.params.id, tenantId);
    // Clear share page cache
    try { const { clearShareCache } = await import('./share.routes'); clearShareCache(); } catch {}
    // Broadcast to tenant
    try {
      const { broadcastToTenant } = await import('../ws');
      broadcastToTenant(tenantId, 'dashboard:share-changed', { dashboardId: req.params.id, is_public: false, revoked: true });
    } catch {}
    res.json({
      ok: true,
      data: { message: 'Dashboard is now private' },
      meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

// GET /:id/share - get share status & URL (owner or platform admin only)
router.get('/:id/share', authenticateJWT, async (req, res, next) => {
  try {
    if (!req.user!.is_owner && !req.user!.is_platform_admin) {
      return res.status(403).json({ ok: false, error: { code: 'FORBIDDEN', message: 'Only the owner or super admin can view share status' } });
    }
    const tenantId = await resolveDashboardTenant(req.params.id, req.user!);
    const dashboard = await dashboardService.getDashboard(req.params.id, tenantId);
    if (!dashboard.public_token) {
      // No share link exists at all
      return res.json({ ok: true, data: { is_public: false, share_url: null, public_token: null } });
    }
    // Link exists — return it regardless of is_public (internal vs public)
    const shareDomain = (await getSetting('platform.share_domain')) || (await getSetting('platform.domain')) || config.webauthn.origin;
    const shareUrl = `${shareDomain.replace(/\/+$/, '')}/share/${dashboard.public_token}`;
    return res.json({
      ok: true,
      data: { is_public: !!dashboard.is_public, share_url: shareUrl, public_token: dashboard.public_token },
      meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

// ─── View History ────────────────────────────────────────────────────────────

// GET /:id/views - list view history for a dashboard (JWT, dashboards.manage)
router.get('/:id/views', authenticateJWT, requirePermission('dashboards.view'), async (req, res, next) => {
  try {
    const result = await dashboardService.getViewHistory(req.params.id);
    res.json({
      ok: true,
      data: result,
      meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

// ─── Comments ───────────────────────────────────────────────────────────────

// GET /:id/comments - list comments with pagination
router.get('/:id/comments', authenticateJWT, requirePermission('dashboards.view'), async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string, 10) || 10, 50);
    const offset = parseInt(req.query.offset as string, 10) || 0;
    const result = await dashboardService.listComments(req.params.id, limit, offset);
    res.json({
      ok: true,
      data: result.comments,
      meta: { total: result.total, limit, offset, request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

// POST /:id/comments - add comment
router.post('/:id/comments', authenticateJWT, requirePermission('dashboards.view'), async (req, res, next) => {
  try {
    const content = (req.body.content || '').trim();
    if (!content || content.length > 10000) {
      return res.status(400).json({ ok: false, error: { code: 'INVALID_INPUT', message: 'Content is required (max 10000 chars)' } });
    }
    const result = await dashboardService.createComment(req.params.id, req.user!.sub, content);
    res.status(201).json({ ok: true, data: result });
  } catch (err) {
    next(err);
  }
});

// DELETE /:id/comments/:cid - delete comment (owner or platform admin)
router.delete('/:id/comments/:cid', authenticateJWT, async (req, res, next) => {
  try {
    if (!req.user!.is_owner && !req.user!.is_platform_admin) {
      return res.status(403).json({ ok: false, error: { code: 'FORBIDDEN', message: 'Not allowed' } });
    }
    await dashboardService.deleteComment(req.params.cid);
    res.json({ ok: true, data: { message: 'Deleted' } });
  } catch (err) {
    next(err);
  }
});

// ─── Connectors ─────────────────────────────────────────────────────────────

// GET /:id/connectors - list attached connectors
router.get('/:id/connectors', authenticateJWT, requirePermission('dashboards.view'), async (req, res, next) => {
  try {
    const result = await dashboardService.listDashboardConnectors(req.params.id);
    res.json({ ok: true, data: result });
  } catch (err) {
    next(err);
  }
});

// POST /:id/connectors - attach connector (owner/platform admin)
router.post('/:id/connectors', authenticateJWT, async (req, res, next) => {
  try {
    if (!req.user!.is_owner && !req.user!.is_platform_admin) {
      return res.status(403).json({ ok: false, error: { code: 'FORBIDDEN', message: 'Not allowed' } });
    }
    const { connectionId, sourceKey, tableName, refreshCadence } = req.body;
    if (!connectionId || !sourceKey || !tableName) {
      return res.status(400).json({ ok: false, error: { code: 'INVALID_INPUT', message: 'connectionId, sourceKey, and tableName are required' } });
    }
    const tenantId = await resolveDashboardTenant(req.params.id, req.user!);
    const result = await dashboardService.attachConnector(req.params.id, connectionId, sourceKey, tableName, tenantId, refreshCadence || 'hourly');
    res.status(201).json({ ok: true, data: result });
  } catch (err) {
    next(err);
  }
});

// DELETE /:id/connectors/:sid - detach connector (owner/platform admin)
router.delete('/:id/connectors/:sid', authenticateJWT, async (req, res, next) => {
  try {
    if (!req.user!.is_owner && !req.user!.is_platform_admin) {
      return res.status(403).json({ ok: false, error: { code: 'FORBIDDEN', message: 'Not allowed' } });
    }
    await dashboardService.detachConnector(req.params.sid);
    res.json({ ok: true, data: { message: 'Detached' } });
  } catch (err) {
    next(err);
  }
});

// GET /:id/available-connectors - list connectors from dashboard's tenant
router.get('/:id/available-connectors', authenticateJWT, async (req, res, next) => {
  try {
    if (!req.user!.is_owner && !req.user!.is_platform_admin) {
      return res.status(403).json({ ok: false, error: { code: 'FORBIDDEN', message: 'Not allowed' } });
    }
    const tenantId = await resolveDashboardTenant(req.params.id, req.user!);
    const { listConnections } = await import('../services/connection.service');
    const connections = await listConnections(tenantId);
    res.json({ ok: true, data: connections });
  } catch (err) {
    next(err);
  }
});

// ─── Image ──────────────────────────────────────────────────────────────────

// PATCH /:id/image - update tile image URL (owner/platform admin)
router.patch('/:id/image', authenticateJWT, async (req, res, next) => {
  try {
    if (!req.user!.is_owner && !req.user!.is_platform_admin) {
      return res.status(403).json({ ok: false, error: { code: 'FORBIDDEN', message: 'Not allowed' } });
    }
    const { imageUrl } = req.body;
    if (!imageUrl) {
      return res.status(400).json({ ok: false, error: { code: 'INVALID_INPUT', message: 'imageUrl is required' } });
    }
    await dashboardService.updateTileImage(req.params.id, imageUrl);
    res.json({ ok: true, data: { message: 'Image updated' } });
  } catch (err) {
    next(err);
  }
});

// POST /:id/image/upload - upload tile image file (owner/platform admin)
router.post('/:id/image/upload', authenticateJWT, async (req, res, next) => {
  try {
    if (!req.user!.is_owner && !req.user!.is_platform_admin) {
      return res.status(403).json({ ok: false, error: { code: 'FORBIDDEN', message: 'Not allowed' } });
    }
    // Use existing upload infrastructure
    const multer = (await import('multer')).default;
    const path = await import('path');
    const crypto = await import('crypto');
    const uploadDir = path.join(process.cwd(), 'uploads');
    const storage = multer.diskStorage({
      destination: uploadDir,
      filename: (_req, file, cb) => {
        const ext = path.extname(file.originalname);
        cb(null, crypto.randomUUID() + ext);
      },
    });
    const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } }).single('image');
    upload(req, res, async (err) => {
      if (err) return res.status(400).json({ ok: false, error: { code: 'UPLOAD_ERROR', message: err.message } });
      if (!req.file) return res.status(400).json({ ok: false, error: { code: 'NO_FILE', message: 'No image file provided' } });
      const imageUrl = `/api/uploads/${req.file.filename}/download`;
      // Store file record
      try {
        const { createFileRecord } = await import('../services/upload.service');
        await createFileRecord({
          tenantId: req.user!.tid,
          uploadedBy: req.user!.sub,
          originalName: req.file.originalname,
          storedName: req.file.filename,
          mimeType: req.file.mimetype,
          sizeBytes: req.file.size,
          contextType: 'general',
          contextId: req.params.id,
        });
      } catch (e) { /* file record optional */ }
      await dashboardService.updateTileImage(req.params.id, imageUrl);
      res.json({ ok: true, data: { imageUrl } });
    });
  } catch (err) {
    next(err);
  }
});

// ─── Embeds ─────────────────────────────────────────────────────────────────

// POST /:id/embed - create embed token (JWT, dashboards.embed)
router.post('/:id/embed', authenticateJWT, requirePermission('dashboards.embed'), async (req, res, next) => {
  try {
    const data = validateBody(embedCreateSchema, req.body);
    const result = await dashboardService.createEmbed(req.params.id, req.user!.tid, data, req.user!.sub);
    res.status(201).json({
      ok: true,
      data: result,
      meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

// DELETE /:id/embed/:eid - revoke embed token (JWT, dashboards.embed)
router.delete('/:id/embed/:eid', authenticateJWT, requirePermission('dashboards.embed'), async (req, res, next) => {
  try {
    await dashboardService.revokeEmbed(req.params.eid, req.params.id, req.user!.tid);
    res.json({
      ok: true,
      data: { message: 'Embed revoked' },
      meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

export default router;
