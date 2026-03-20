import { Router } from 'express';
import { authenticateJWT } from '../middleware/auth';
import { requirePermission } from '../middleware/rbac';
import * as connectionService from '../services/connection.service';

const router = Router();

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

export default router;
