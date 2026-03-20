import { Router } from 'express';
import { authenticateJWT } from '../middleware/auth';
import { requirePermission } from '../middleware/rbac';
import { validateBody, dashboardAccessSchema, embedCreateSchema } from '../lib/validation';
import * as dashboardService from '../services/dashboard.service';
import { getSetting } from '../services/settings.service';
import { config } from '../config';

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

    // Separate SELECT then UPDATE to avoid RLS issues with UPDATE...RETURNING
    const dashboard = await withClient(async (client) => {
      await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
      // Platform admin can render any dashboard regardless of tenant
      const query = req.user!.is_platform_admin
        ? {
            text: `SELECT id, fetch_url, fetch_method, fetch_headers, fetch_body,
                    view_html, view_css, view_js
             FROM platform.dashboards
             WHERE id = $1 AND status = 'active'`,
            values: [req.params.id],
          }
        : {
            text: `SELECT id, fetch_url, fetch_method, fetch_headers, fetch_body,
                    view_html, view_css, view_js
             FROM platform.dashboards
             WHERE id = $1 AND tenant_id = $2 AND status = 'active'`,
            values: [req.params.id, req.user!.tid],
          };
      const result = await client.query(query);
      if (result.rows[0]) {
        client.query(
          `UPDATE platform.dashboards SET last_viewed_at = now() WHERE id = $1`,
          [req.params.id]
        );
      }
      return result.rows[0];
    });

    if (!dashboard) {
      return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Dashboard not found or inactive' } });
    }

    // If dashboard has static content, return it directly
    if (!dashboard.fetch_url) {
      return res.json({
        ok: true,
        data: { html: dashboard.view_html || '', css: dashboard.view_css || '', js: dashboard.view_js || '' },
      });
    }

    // Proxy fetch to n8n
    const headers: Record<string, string> = typeof dashboard.fetch_headers === 'string'
      ? JSON.parse(dashboard.fetch_headers) : (dashboard.fetch_headers || {});
    const fetchOpts: RequestInit = {
      method: dashboard.fetch_method || 'GET',
      headers: { 'Content-Type': 'application/json', ...headers },
    };
    if (dashboard.fetch_body && dashboard.fetch_method !== 'GET') {
      fetchOpts.body = typeof dashboard.fetch_body === 'string'
        ? dashboard.fetch_body : JSON.stringify(dashboard.fetch_body);
    }

    // 90-second timeout for upstream fetches (some data flows take time)
    fetchOpts.signal = AbortSignal.timeout(90_000);

    const response = await fetch(dashboard.fetch_url, fetchOpts);
    if (!response.ok) {
      return res.status(502).json({ ok: false, error: { code: 'UPSTREAM_ERROR', message: `Connection returned ${response.status}` } });
    }

    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      const data = await response.json();
      res.json({ ok: true, data });
    } else {
      const html = await response.text();
      res.json({ ok: true, data: { html, css: '', js: '' } });
    }
  } catch (err) {
    next(err);
  }
});

// POST /:id/access - grant access to dashboard (JWT, dashboards.manage)
router.post('/:id/access', authenticateJWT, requirePermission('dashboards.manage'), async (req, res, next) => {
  try {
    const data = validateBody(dashboardAccessSchema, req.body);
    await dashboardService.grantAccess(req.params.id, data.userId, req.user!.sub, req.user!.tid);
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
    res.json({
      ok: true,
      data: { message: 'Access revoked' },
      meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

// POST /:id/share - make dashboard public (owner or platform admin only)
router.post('/:id/share', authenticateJWT, async (req, res, next) => {
  try {
    if (!req.user!.is_owner && !req.user!.is_platform_admin) {
      return res.status(403).json({ ok: false, error: { code: 'FORBIDDEN', message: 'Only the owner or super admin can share dashboards publicly' } });
    }
    const result = await dashboardService.makePublic(req.params.id, req.user!.tid);
    const shareDomain = (await getSetting('platform.share_domain')) || (await getSetting('platform.domain')) || config.webauthn.origin;
    const shareUrl = `${shareDomain.replace(/\/+$/, '')}/share/${result.public_token}`;
    res.json({
      ok: true,
      data: { public_token: result.public_token, share_url: shareUrl },
      meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

// DELETE /:id/share - make dashboard private / delist (owner or platform admin only)
router.delete('/:id/share', authenticateJWT, async (req, res, next) => {
  try {
    if (!req.user!.is_owner && !req.user!.is_platform_admin) {
      return res.status(403).json({ ok: false, error: { code: 'FORBIDDEN', message: 'Only the owner or super admin can manage public sharing' } });
    }
    await dashboardService.makePrivate(req.params.id, req.user!.tid);
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
    const dashboard = await dashboardService.getDashboard(req.params.id, req.user!.tid);
    if (!dashboard.is_public || !dashboard.public_token) {
      return res.json({ ok: true, data: { is_public: false, share_url: null, public_token: null } });
    }
    const shareDomain = (await getSetting('platform.share_domain')) || (await getSetting('platform.domain')) || config.webauthn.origin;
    const shareUrl = `${shareDomain.replace(/\/+$/, '')}/share/${dashboard.public_token}`;
    return res.json({
      ok: true,
      data: { is_public: true, share_url: shareUrl, public_token: dashboard.public_token },
      meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

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
