import { Router } from 'express';
import { authenticateJWT } from '../middleware/auth';
import { requirePermission } from '../middleware/rbac';
import { validateBody } from '../lib/validation';
import { z } from 'zod';
import * as meetService from '../services/meet.service';

const router = Router();

const createRoomSchema = z.object({
  roomId: z.string().min(1).max(100).regex(/^[a-zA-Z0-9_-]+$/).optional(),
  displayName: z.string().min(1).max(255).optional(),
  maxParticipants: z.number().int().min(1).max(500).optional(),
});

// GET /config - get MEET server URL (any authenticated user)
router.get('/config', authenticateJWT, async (req, res, next) => {
  try {
    const result = await meetService.getMeetSettings();
    res.json({
      ok: true,
      data: result,
      meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

// POST /rooms - create a meeting room (any authenticated user)
router.post('/rooms', authenticateJWT, async (req, res, next) => {
  try {
    const data = validateBody(createRoomSchema, req.body);
    const result = await meetService.createRoom(data);
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
