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
  settingsUpdateSchema,
  emailTemplateUpdateSchema,
  paginationSchema,
} from '../lib/validation';
import * as adminService from '../services/admin.service';

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

export default router;
