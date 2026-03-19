import { Router } from 'express';
import { authenticateJWT } from '../middleware/auth';
import { requirePermission } from '../middleware/rbac';
import { validateBody, tenantUpdateSchema } from '../lib/validation';
import * as tenantService from '../services/tenant.service';

const router = Router();

// GET /current - get current tenant (JWT)
router.get('/current', authenticateJWT, async (req, res, next) => {
  try {
    const result = await tenantService.getTenant(req.user!.tid);
    res.json({
      ok: true,
      data: result,
      meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

// PATCH /current - update current tenant (JWT, billing.manage)
router.patch('/current', authenticateJWT, requirePermission('billing.manage'), async (req, res, next) => {
  try {
    const data = validateBody(tenantUpdateSchema, req.body);
    const result = await tenantService.updateTenant(req.user!.tid, data);
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
