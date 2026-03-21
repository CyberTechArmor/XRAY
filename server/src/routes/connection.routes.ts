import { Router } from 'express';
import { authenticateJWT } from '../middleware/auth';
import { requirePermission } from '../middleware/rbac';
import * as connectionService from '../services/connection.service';
import { z } from 'zod';
import { validateBody } from '../lib/validation';

const commentSchema = z.object({
  content: z.string().min(1).max(10000),
});

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
