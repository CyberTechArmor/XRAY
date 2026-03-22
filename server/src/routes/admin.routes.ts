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
    const result = await adminService.createDashboard(data);
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
    const result = await adminService.fetchDashboardContent(req.params.id);
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
    const { withClient } = await import('../db/connection');
    const conn = await withClient(async (client) => {
      await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
      const result = await client.query(
        `SELECT c.*, t.name AS tenant_name, o.email AS owner_email
         FROM platform.connections c
         LEFT JOIN platform.tenants t ON t.id = c.tenant_id
         LEFT JOIN platform.users o ON o.id = t.owner_user_id
         WHERE c.id = $1`,
        [req.params.id]
      );
      return result.rows[0];
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
      const user = await import('../db/connection').then(m => m.withClient(async (client) => {
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

export default router;
