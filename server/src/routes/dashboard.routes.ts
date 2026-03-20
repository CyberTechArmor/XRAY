import { Router } from 'express';
import { authenticateJWT } from '../middleware/auth';
import { requirePermission } from '../middleware/rbac';
import { validateBody, dashboardAccessSchema, embedCreateSchema } from '../lib/validation';
import * as dashboardService from '../services/dashboard.service';

const router = Router();

// GET / - list dashboards (JWT, dashboards.view)
router.get('/', authenticateJWT, requirePermission('dashboards.view'), async (req, res, next) => {
  try {
    const hasManage = req.user!.permissions.includes('dashboards.manage') || req.user!.is_platform_admin;
    const result = await dashboardService.listDashboards(req.user!.tid, req.user!.sub, hasManage);
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
    const dashboard = await withClient(async (client) => {
      await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
      const result = await client.query(
        `SELECT d.id, d.fetch_url, d.fetch_method, d.fetch_headers, d.fetch_body, d.status, d.tenant_id,
                d.view_html, d.view_css, d.view_js
         FROM platform.dashboards d
         WHERE d.id = $1 AND d.tenant_id = $2 AND d.status = 'active'`,
        [req.params.id, req.user!.tid]
      );
      return result.rows[0];
    });

    if (!dashboard) {
      return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Dashboard not found or inactive' } });
    }

    // Track last viewed
    await withClient(async (c) => {
      await c.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
      await c.query('UPDATE platform.dashboards SET last_viewed_at = now() WHERE id = $1', [req.params.id]);
    });

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

// POST /:id/public - toggle public access (JWT, dashboards.embed)
router.post('/:id/public', authenticateJWT, requirePermission('dashboards.embed'), async (req, res, next) => {
  try {
    const dashboard = await dashboardService.getDashboard(req.params.id, req.user!.tid);
    const result = await dashboardService.updateDashboard(req.params.id, { is_public: !dashboard.is_public });
    res.json({
      ok: true,
      data: result,
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
