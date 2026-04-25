import { Router } from 'express';
import { authenticateJWT } from '../middleware/auth';
import { requirePermission } from '../middleware/rbac';
import {
  validateBody,
  validateQuery,
  tenantCreateSchema,
  dashboardCreateSchema,
  dashboardUpdateSchema,
  connectionCreateSchema,
  connectionUpdateSchema,
  connectionTableCreateSchema,
  connectionTemplateCreateSchema,
  connectionCommentCreateSchema,
  tenantNoteCreateSchema,
  settingsUpdateSchema,
  emailTemplateUpdateSchema,
  paginationSchema,
} from '../lib/validation';
import * as adminService from '../services/admin.service';
import * as auditService from '../services/audit.service';
import * as integrationService from '../services/integration.service';
import * as fanOutService from '../services/fan-out.service';
import * as impersonationService from '../services/impersonation.service';
import { issueCsrfCookie } from '../middleware/csrf';
import { hashRefreshToken } from '../lib/crypto';
import { config } from '../config';

const router = Router();

// All admin routes require JWT + platform.admin
router.use(authenticateJWT, requirePermission('platform.admin'));

// GET /tenants - list all tenants
router.get('/tenants', async (req, res, next) => {
  try {
    const query = validateQuery(paginationSchema, req.query);
    const result = await adminService.listAllTenants(query);
    res.json({
      ok: true,
      data: result,
      meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

// POST /tenants - create tenant
router.post('/tenants', async (req, res, next) => {
  try {
    const data = validateBody(tenantCreateSchema, req.body);
    const result = await adminService.createTenant(data);
    res.status(201).json({
      ok: true,
      data: result,
      meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

// GET /tenants/:id - get tenant detail
router.get('/tenants/:id', async (req, res, next) => {
  try {
    const result = await adminService.getTenantDetail(req.params.id);
    res.json({
      ok: true,
      data: result,
      meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

// PATCH /tenants/:id/plan - manually set tenant plan tier (super admin override)
router.patch('/tenants/:id/plan', async (req, res, next) => {
  try {
    const { planTier, dashboardLimit, connectorLimit, paymentStatus } = req.body;
    if (!planTier) {
      return res.status(400).json({ ok: false, error: { code: 'MISSING_FIELD', message: 'planTier is required' } });
    }
    const result = await adminService.updateTenantPlan(req.params.id, {
      planTier,
      dashboardLimit: dashboardLimit !== undefined ? dashboardLimit : undefined,
      connectorLimit: connectorLimit !== undefined ? connectorLimit : undefined,
      paymentStatus: paymentStatus || undefined,
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

// PATCH /tenants/:id/replay - toggle replay recording and/or visibility for a tenant
router.patch('/tenants/:id/replay', async (req, res, next) => {
  try {
    const { replay_enabled, replay_visible } = req.body;
    if (typeof replay_enabled !== 'boolean' && typeof replay_visible !== 'boolean') {
      return res.status(400).json({ ok: false, error: { code: 'INVALID_FIELD', message: 'replay_enabled or replay_visible (boolean) required' } });
    }
    const { withAdminClient } = await import('../db/connection');
    const result = await withAdminClient(async (client) => {
      const sets: string[] = [];
      const vals: any[] = [];
      let idx = 1;
      if (typeof replay_enabled === 'boolean') { sets.push(`replay_enabled = $${idx++}`); vals.push(replay_enabled); }
      if (typeof replay_visible === 'boolean') { sets.push(`replay_visible = $${idx++}`); vals.push(replay_visible); }
      sets.push('updated_at = now()');
      vals.push(req.params.id);
      const r = await client.query(
        `UPDATE platform.tenants SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`,
        vals
      );
      return r.rows[0];
    });
    if (!result) {
      return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Tenant not found' } });
    }
    // Broadcast to all users in this tenant so sidebar updates in real-time
    try {
      const { broadcastToTenant } = await import('../ws');
      broadcastToTenant(req.params.id, 'tenant:replay-changed', {
        replay_enabled: result.replay_enabled,
        replay_visible: result.replay_visible,
      });
    } catch (e) { /* non-fatal */ }
    res.json({
      ok: true,
      data: result,
      meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

// PATCH /tenants/:id/status - archive/activate tenant
router.patch('/tenants/:id/status', async (req, res, next) => {
  try {
    const { status } = req.body;
    if (!status || !['active', 'suspended', 'archived'].includes(status)) {
      return res.status(400).json({ ok: false, error: { code: 'INVALID_STATUS', message: 'Status must be active, suspended, or archived' } });
    }
    const result = await adminService.updateTenantStatus(req.params.id, status);
    res.json({
      ok: true,
      data: result,
      meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

// ─── Step 10: platform-admin impersonation ──────────────────────────────────
//
// Start: POST /api/admin/impersonate/:tenantId/:userId mints a NEW
// session as the target user with impersonator_user_id set to the
// caller. Browser swaps to the new tokens; the access-token JWT
// carries an `imp` claim so the SPA renders a persistent red banner.
//
// Stop: POST /api/admin/impersonate/stop tears down the impersonation
// session row, mints a fresh session for the original admin from the
// `imp` claim, and returns the admin tokens. The browser swaps back.

function setRefreshCookie(res: any, refreshToken: string) {
  res.cookie('refresh_token', refreshToken, {
    httpOnly: true,
    secure: config.nodeEnv === 'production',
    sameSite: 'lax',
    path: '/api/auth',
    maxAge: config.jwt.refreshTokenExpiry,
  });
}

router.post('/impersonate/stop', async (req, res, next) => {
  try {
    if (!req.user!.imp || !req.user!.imp.admin_id) {
      return res.status(400).json({
        ok: false,
        error: { code: 'NOT_IMPERSONATING', message: 'Current session is not an impersonation session' },
      });
    }
    const rawToken = req.cookies?.refresh_token;
    if (!rawToken) {
      return res.status(401).json({
        ok: false,
        error: { code: 'NO_TOKEN', message: 'No refresh token' },
      });
    }
    const tokens = await impersonationService.stopImpersonation({
      impersonationRefreshTokenHash: hashRefreshToken(rawToken),
      adminUserId: req.user!.imp.admin_id,
    });
    setRefreshCookie(res, tokens.refreshToken);
    await issueCsrfCookie(res);
    res.json({
      ok: true,
      data: { accessToken: tokens.accessToken, sessionId: tokens.sessionId },
      meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

router.post('/impersonate/:tenantId/:userId', async (req, res, next) => {
  try {
    if (req.user!.imp) {
      // Block nested impersonation. The operator should /stop first.
      return res.status(409).json({
        ok: false,
        error: { code: 'ALREADY_IMPERSONATING', message: 'Stop the current impersonation before starting another' },
      });
    }
    const tokens = await impersonationService.startImpersonation({
      adminUserId: req.user!.sub,
      targetTenantId: req.params.tenantId,
      targetUserId: req.params.userId,
    });
    setRefreshCookie(res, tokens.refreshToken);
    await issueCsrfCookie(res);
    res.json({
      ok: true,
      data: { accessToken: tokens.accessToken, sessionId: tokens.sessionId },
      meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

// POST /invite-tenant-owner - send a branded tenant-owner invite. The
// recipient clicks through a signup magic link pre-populated with the
// proposed owner name and tenant name; completeSignup creates the
// tenant with them as the first user. Useful when an operator wants
// to hand a paying customer a one-click onboarding link.
router.post('/invite-tenant-owner', async (req, res, next) => {
  try {
    const { email, name, tenantName } = req.body || {};
    if (typeof email !== 'string' || !email.trim()) {
      return res.status(400).json({ ok: false, error: { code: 'MISSING_EMAIL', message: 'Recipient email is required' } });
    }
    if (typeof tenantName !== 'string' || !tenantName.trim()) {
      return res.status(400).json({ ok: false, error: { code: 'MISSING_TENANT_NAME', message: 'Proposed organization name is required' } });
    }
    const result = await adminService.inviteTenantOwner({
      email: email.trim(),
      name: (typeof name === 'string' ? name : '').trim() || email.trim().split('@')[0],
      tenantName: tenantName.trim(),
      invitedByUserId: req.user!.sub,
      invitedByTenantId: req.user!.tid,
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

// GET /tenants/:id/members - list tenant members
router.get('/tenants/:id/members', async (req, res, next) => {
  try {
    const result = await adminService.listTenantMembers(req.params.id);
    res.json({
      ok: true,
      data: result,
      meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

// POST /tenants/:id/members - add user to tenant
router.post('/tenants/:id/members', async (req, res, next) => {
  try {
    const { name, email, role } = req.body;
    if (!name || !email) {
      return res.status(400).json({ ok: false, error: { code: 'MISSING_FIELDS', message: 'Name and email are required' } });
    }
    const result = await adminService.addTenantMember(req.params.id, {
      name,
      email,
      role: role || 'member',
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

// DELETE /tenants/:id/members/:userId - remove user from tenant
router.delete('/tenants/:id/members/:userId', async (req, res, next) => {
  try {
    await adminService.removeTenantMember(req.params.id, req.params.userId);
    res.json({
      ok: true,
      data: { deleted: true },
      meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

// GET /dashboards - list all dashboards
router.get('/dashboards', async (req, res, next) => {
  try {
    const query = validateQuery(paginationSchema, req.query);
    const result = await adminService.listAllDashboards(query);
    res.json({
      ok: true,
      data: result,
      meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

// GET /dashboards/:id - get dashboard detail
router.get('/dashboards/:id', async (req, res, next) => {
  try {
    const result = await adminService.getDashboardDetail(req.params.id);
    res.json({
      ok: true,
      data: result,
      meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

// POST /dashboards - create dashboard
router.post('/dashboards', async (req, res, next) => {
  try {
    const data = validateBody(dashboardCreateSchema, req.body);
    const result = await adminService.createDashboard(data, {
      isPlatformAdmin: !!req.user?.is_platform_admin,
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

// PATCH /dashboards/:id - update dashboard
router.patch('/dashboards/:id', async (req, res, next) => {
  try {
    const data = validateBody(dashboardUpdateSchema, req.body);
    const result = await adminService.updateDashboard(req.params.id, data);
    res.json({
      ok: true,
      data: result,
      meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

// GET /dashboards/:id/grants - list tenants that have been granted
// access to a Custom Global. Returns []` for non-custom dashboards.
router.get('/dashboards/:id/grants', async (req, res, next) => {
  try {
    const result = await adminService.listDashboardGrants(req.params.id);
    res.json({
      ok: true,
      data: result,
      meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

// POST /dashboards/:id/grants - grant a tenant access to a Custom
// Global. Body: { tenantId }. Idempotent; re-granting is a no-op.
router.post('/dashboards/:id/grants', async (req, res, next) => {
  try {
    const { tenantId } = req.body || {};
    if (typeof tenantId !== 'string' || !tenantId) {
      return res.status(400).json({ ok: false, error: { code: 'MISSING_TENANT_ID', message: 'tenantId is required' } });
    }
    const result = await adminService.grantDashboardToTenant(req.params.id, tenantId, req.user!.sub);
    res.status(201).json({
      ok: true,
      data: result,
      meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

// DELETE /dashboards/:id/grants/:tenantId - revoke grant
router.delete('/dashboards/:id/grants/:tenantId', async (req, res, next) => {
  try {
    await adminService.revokeDashboardGrant(req.params.id, req.params.tenantId, req.user!.sub);
    res.json({
      ok: true,
      data: { revoked: true },
      meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

// DELETE /dashboards/:id - delete dashboard (platform admin only)
router.delete('/dashboards/:id', async (req, res, next) => {
  try {
    const result = await adminService.deleteDashboard(req.params.id);
    res.json({
      ok: true,
      data: result,
      meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

// GET /connections - list all connections
router.get('/connections', async (req, res, next) => {
  try {
    const query = validateQuery(paginationSchema, req.query);
    const result = await adminService.listAllConnections(query);
    res.json({
      ok: true,
      data: result,
      meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

// POST /connections - create connection
router.post('/connections', async (req, res, next) => {
  try {
    const data = validateBody(connectionCreateSchema, req.body);
    const result = await adminService.createConnection(data);
    res.status(201).json({
      ok: true,
      data: result,
      meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

// PATCH /connections/:id - update connection
router.patch('/connections/:id', async (req, res, next) => {
  try {
    const data = validateBody(connectionUpdateSchema, req.body);
    const result = await adminService.updateConnection(req.params.id, data);
    res.json({
      ok: true,
      data: result,
      meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

// POST /dashboards/:id/fetch - proxy fetch dashboard content from connection
router.post('/dashboards/:id/fetch', async (req, res, next) => {
  try {
    // targetTenantId is required when previewing a Global dashboard.
    // Comes from either the JSON body (preferred) or the query string.
    const targetTenantId =
      (typeof req.body?.target_tenant_id === 'string' && req.body.target_tenant_id) ||
      (typeof req.query?.target_tenant_id === 'string' && req.query.target_tenant_id) ||
      undefined;
    const result = await adminService.fetchDashboardContent(req.params.id, req.user?.sub, {
      targetTenantId: targetTenantId || undefined,
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

// GET /connection-templates - list connection templates
router.get('/connection-templates', async (req, res, next) => {
  try {
    const result = await adminService.listConnectionTemplates();
    res.json({
      ok: true,
      data: result,
      meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

// POST /connection-templates - create connection template
router.post('/connection-templates', async (req, res, next) => {
  try {
    const data = validateBody(connectionTemplateCreateSchema, req.body);
    const result = await adminService.createConnectionTemplate(data);
    res.status(201).json({
      ok: true,
      data: result,
      meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

// DELETE /connection-templates/:id - delete connection template
router.delete('/connection-templates/:id', async (req, res, next) => {
  try {
    const result = await adminService.deleteConnectionTemplate(req.params.id);
    res.json({
      ok: true,
      data: result,
      meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

// DELETE /connections/:id - delete connection
router.delete('/connections/:id', async (req, res, next) => {
  try {
    const result = await adminService.deleteConnection(req.params.id);
    res.json({
      ok: true,
      data: result,
      meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

// GET /connections/:id - get connection detail
router.get('/connections/:id', async (req, res, next) => {
  try {
    const { withAdminClient } = await import('../db/connection');
    const { decryptSecret } = await import('../lib/encrypted-column');
    const conn = await withAdminClient(async (client) => {
      const result = await client.query(
        `SELECT c.*, t.name AS tenant_name, o.email AS owner_email
         FROM platform.connections c
         LEFT JOIN platform.tenants t ON t.id = c.tenant_id
         LEFT JOIN platform.users o ON o.id = t.owner_user_id
         WHERE c.id = $1`,
        [req.params.id]
      );
      const row = result.rows[0];
      if (row && row.connection_details !== undefined) {
        row.connection_details = decryptSecret(row.connection_details, `connections:connection_details:${row.id}`);
      }
      return row;
    });
    if (!conn) return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Connection not found' } });
    res.json({
      ok: true,
      data: conn,
      meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

// GET /connections/:id/comments - list comments
router.get('/connections/:id/comments', async (req, res, next) => {
  try {
    const result = await adminService.listConnectionComments(req.params.id);
    res.json({
      ok: true,
      data: result,
      meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

// POST /connections/:id/comments - add comment
router.post('/connections/:id/comments', async (req, res, next) => {
  try {
    const data = validateBody(connectionCommentCreateSchema, req.body);
    const result = await adminService.createConnectionComment(req.params.id, req.user!.sub, data.content);
    res.status(201).json({
      ok: true,
      data: result,
      meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

// DELETE /connections/:id/comments/:cid - delete comment
router.delete('/connections/:id/comments/:cid', async (req, res, next) => {
  try {
    const result = await adminService.deleteConnectionComment(req.params.cid);
    res.json({
      ok: true,
      data: result,
      meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

// POST /connections/:id/tables - register table
router.post('/connections/:id/tables', async (req, res, next) => {
  try {
    const data = validateBody(connectionTableCreateSchema, req.body);
    const result = await adminService.registerTable(req.params.id, data);
    res.status(201).json({
      ok: true,
      data: result,
      meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

// GET /tenants/:id/notes - list notes for a tenant
router.get('/tenants/:id/notes', async (req, res, next) => {
  try {
    const result = await adminService.listTenantNotes(req.params.id);
    res.json({
      ok: true,
      data: result,
      meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

// POST /tenants/:id/notes - add a note
router.post('/tenants/:id/notes', async (req, res, next) => {
  try {
    const data = validateBody(tenantNoteCreateSchema, req.body);
    const result = await adminService.createTenantNote(req.params.id, req.user!.sub, data.content);
    res.status(201).json({
      ok: true,
      data: result,
      meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

// PATCH /tenants/:id/notes/:noteId - edit a note
router.patch('/tenants/:id/notes/:noteId', async (req, res, next) => {
  try {
    const data = validateBody(tenantNoteCreateSchema, req.body);
    const result = await adminService.updateTenantNote(req.params.noteId, data.content);
    res.json({
      ok: true,
      data: result,
      meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

// DELETE /tenants/:id/notes/:noteId - delete a note
router.delete('/tenants/:id/notes/:noteId', async (req, res, next) => {
  try {
    const result = await adminService.deleteTenantNote(req.params.noteId);
    res.json({
      ok: true,
      data: result,
      meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

// GET /audit - platform-wide audit log
router.get('/audit', async (req, res, next) => {
  try {
    const page = parseInt(req.query.page as string, 10) || 1;
    const limit = parseInt(req.query.limit as string, 10) || 50;
    const action = req.query.action as string | undefined;
    const resourceType = req.query.resourceType as string | undefined;
    const result = await auditService.queryAll({ page, limit, action, resourceType });
    res.json({
      ok: true,
      data: result.data,
      meta: { total: result.total, page: result.page, limit: result.limit, request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

// GET /settings - get all settings
router.get('/settings', async (req, res, next) => {
  try {
    const result = await adminService.getAllSettings();
    res.json({
      ok: true,
      data: result,
      meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

// PATCH /settings - update settings
router.patch('/settings', async (req, res, next) => {
  try {
    const data = validateBody(settingsUpdateSchema, req.body);
    const result = await adminService.updateSettings(data);
    res.json({
      ok: true,
      data: result,
      meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

// GET /email-templates - list email templates
router.get('/email-templates', async (req, res, next) => {
  try {
    const result = await adminService.listEmailTemplates();
    res.json({
      ok: true,
      data: result,
      meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

// GET /email-templates/:key - get single email template with full body
router.get('/email-templates/:key', async (req, res, next) => {
  try {
    const result = await adminService.getEmailTemplate(req.params.key);
    res.json({
      ok: true,
      data: result,
      meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

// PATCH /email-templates/:key - update email template
router.patch('/email-templates/:key', async (req, res, next) => {
  try {
    const data = validateBody(emailTemplateUpdateSchema, req.body);
    const result = await adminService.updateEmailTemplate(req.params.key, data);
    res.json({
      ok: true,
      data: result,
      meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

// POST /email-templates/:key/reset - replace the template body with
// the current step-5 default (rebranded HTML). Admin-driven; does
// not run automatically on upgrade.
router.post('/email-templates/:key/reset', async (req, res, next) => {
  try {
    const result = await adminService.resetEmailTemplate(req.params.key);
    res.json({
      ok: true,
      data: result,
      meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

// POST /email-templates/:key/test - send test email
router.post('/email-templates/:key/test', async (req, res, next) => {
  try {
    const result = await adminService.sendTestEmail(req.params.key, req.user!.sub);
    res.json({
      ok: true,
      data: result,
      meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

// POST /email/test - send a test email to the requesting admin
router.post('/email/test', async (req, res, next) => {
  try {
    const { sendEmail } = await import('../services/email.service');
    const to = req.body.to || req.user!.sub;

    // Look up user email if `to` is a UUID
    let recipientEmail = to;
    if (to.includes('-') && !to.includes('@')) {
      // Admin test-email route — admin looks up any tenant's user by id.
      const user = await import('../db/connection').then(m => m.withAdminClient(async (client) => {
        const result = await client.query('SELECT email FROM platform.users WHERE id = $1', [to]);
        return result.rows[0];
      }));
      if (user) recipientEmail = user.email;
    }

    await sendEmail({
      to: recipientEmail,
      subject: 'XRay — Test Email',
      html: '<h2>Test Email</h2><p>This is a test email from your XRay platform. If you received this, your SMTP configuration is working correctly.</p><p style="color:#666;font-size:12px">Sent at ' + new Date().toISOString() + '</p>',
      text: 'Test Email\n\nThis is a test email from your XRay platform. If you received this, your SMTP configuration is working correctly.\n\nSent at ' + new Date().toISOString(),
    });

    res.json({
      ok: true,
      data: { sent: true, to: recipientEmail },
      meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

// ─── Import / Export ───────────────────────────────────────

// POST /export - export platform data as ZIP
router.post('/export', async (req, res, next) => {
  try {
    const { exportPlatform } = await import('../services/portability.service');
    const options = req.body || {};
    const zipBuffer = await exportPlatform(options, req.user!.sub);

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="xray-export-${new Date().toISOString().slice(0, 10)}.zip"`);
    res.setHeader('Content-Length', zipBuffer.length.toString());
    res.send(zipBuffer);
  } catch (err) {
    next(err);
  }
});

// POST /import - import platform data from ZIP
// Accepts: application/zip (raw body via express.raw in index.ts) or application/json with base64 data
router.post('/import', async (req, res, next) => {
  try {
    let zipBuffer: Buffer;

    if (Buffer.isBuffer(req.body)) {
      // Raw binary upload (application/zip)
      zipBuffer = req.body;
    } else if (req.body && req.body.data) {
      // Base64 encoded in JSON body
      zipBuffer = Buffer.from(req.body.data, 'base64');
    } else {
      return res.status(400).json({
        ok: false,
        error: { code: 'MISSING_DATA', message: 'Send ZIP as binary body (Content-Type: application/zip) or as base64 in { "data": "..." }' },
      });
    }

    if (zipBuffer.length === 0) {
      return res.status(400).json({
        ok: false,
        error: { code: 'EMPTY_ARCHIVE', message: 'Upload is empty' },
      });
    }

    const { importPlatform } = await import('../services/portability.service');
    const result = await importPlatform(zipBuffer, req.user!.sub);

    res.json({
      ok: true,
      data: result,
      meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

// ─── Integrations (OAuth providers + API-key providers) ─────────────────────
// Backs the "Integrations" admin tab. platform.integrations catalog CRUD.

router.get('/integrations', async (_req, res, next) => {
  try {
    const [rows, lastFanOut] = await Promise.all([
      integrationService.listAllIntegrations(),
      fanOutService.listLastFanOutByIntegration(),
    ]);
    // Surface the redirect URI so the admin UI can show it next to each
    // provider's config ("Register this URL with HouseCall Pro"). Same
    // value for every provider — platform-wide callback.
    // fan_out_last is keyed by integration id — admin UI merges onto
    // each row to render the "Last fan-out: N dispatched, M skipped"
    // status line.
    res.json({
      ok: true,
      data: rows,
      meta: {
        oauth_redirect_uri: config.oauth.redirectUri,
        fan_out_last: lastFanOut,
      },
    });
  } catch (err) {
    next(err);
  }
});

router.get('/integrations/:id', async (req, res, next) => {
  try {
    const row = await integrationService.getIntegration(req.params.id);
    res.json({ ok: true, data: row, meta: { oauth_redirect_uri: config.oauth.redirectUri } });
  } catch (err) {
    next(err);
  }
});

router.post('/integrations', async (req, res, next) => {
  try {
    const row = await integrationService.createIntegration(req.body, req.user!.sub);
    res.status(201).json({ ok: true, data: row });
  } catch (err) {
    next(err);
  }
});

router.patch('/integrations/:id', async (req, res, next) => {
  try {
    const row = await integrationService.updateIntegration(req.params.id, req.body, req.user!.sub);
    res.json({ ok: true, data: row });
  } catch (err) {
    next(err);
  }
});

router.delete('/integrations/:id', async (req, res, next) => {
  try {
    await integrationService.deleteIntegration(req.params.id, req.user!.sub);
    res.json({ ok: true, data: { message: 'Integration deleted' } });
  } catch (err) {
    next(err);
  }
});

export default router;
