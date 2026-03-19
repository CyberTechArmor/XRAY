import { Router } from 'express';
import { authenticateJWT } from '../middleware/auth';
import { requirePermission } from '../middleware/rbac';
import { validateQuery, auditQuerySchema } from '../lib/validation';
import * as auditService from '../services/audit.service';

const router = Router();

// GET / - query audit log (JWT, audit.view)
router.get('/', authenticateJWT, requirePermission('audit.view'), async (req, res, next) => {
  try {
    const query = validateQuery(auditQuerySchema, req.query);
    const result = await auditService.queryAuditLog(req.user!.tid, query);
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
