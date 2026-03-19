import { Router } from 'express';
import { authenticateJWT } from '../middleware/auth';
import { requirePermission } from '../middleware/rbac';
import { validateBody, roleCreateSchema, roleUpdateSchema } from '../lib/validation';
import * as roleService from '../services/role.service';

const router = Router();

// GET /assignable - get assignable roles (JWT, users.manage)
router.get('/assignable', authenticateJWT, requirePermission('users.manage'), async (req, res, next) => {
  try {
    const result = await roleService.getAssignableRoles();
    res.json({
      ok: true,
      data: result,
      meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

// GET / - list roles (JWT, platform.admin)
router.get('/', authenticateJWT, requirePermission('platform.admin'), async (req, res, next) => {
  try {
    const result = await roleService.listRoles();
    res.json({
      ok: true,
      data: result,
      meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

// POST / - create role (JWT, platform.admin)
router.post('/', authenticateJWT, requirePermission('platform.admin'), async (req, res, next) => {
  try {
    const data = validateBody(roleCreateSchema, req.body);
    const result = await roleService.createRole(data);
    res.status(201).json({
      ok: true,
      data: result,
      meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

// PATCH /:id - update role (JWT, platform.admin)
router.patch('/:id', authenticateJWT, requirePermission('platform.admin'), async (req, res, next) => {
  try {
    const data = validateBody(roleUpdateSchema, req.body);
    const result = await roleService.updateRole(req.params.id, data);
    res.json({
      ok: true,
      data: result,
      meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

// DELETE /:id - delete role (JWT, platform.admin)
router.delete('/:id', authenticateJWT, requirePermission('platform.admin'), async (req, res, next) => {
  try {
    await roleService.deleteRole(req.params.id);
    res.json({
      ok: true,
      data: { message: 'Role deleted' },
      meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

export default router;
