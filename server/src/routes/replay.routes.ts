import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { authenticateJWT } from '../middleware/auth';
import { requirePermission } from '../middleware/rbac';
import { config } from '../config';
import * as replayService from '../services/replay.service';

const router = Router();

// ── Sessions ────────────────────────────────────────────────────────────────

// POST /sessions — create a new recording session
router.post('/sessions', authenticateJWT, async (req, res, next) => {
  try {
    const { userAgent, viewportWidth, viewportHeight } = req.body;
    const session = await replayService.createSession(req.user!.sub, req.user!.tid, {
      userAgent,
      viewportWidth,
      viewportHeight,
    });
    res.status(201).json({
      ok: true,
      data: { sessionId: session.id },
      meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

// GET /sessions — list sessions
router.get('/sessions', authenticateJWT, requirePermission('session_replay.view'), async (req, res, next) => {
  try {
    const { userId, tenantId, dateFrom, dateTo, isActive, limit, offset } = req.query;
    const effectiveTenantId = req.user!.is_platform_admin ? (tenantId as string) : req.user!.tid;
    const result = await replayService.listSessions(effectiveTenantId, {
      userId: userId as string,
      dateFrom: dateFrom as string,
      dateTo: dateTo as string,
      isActive: isActive !== undefined ? isActive === 'true' : undefined,
      limit: limit ? parseInt(limit as string, 10) : undefined,
      offset: offset ? parseInt(offset as string, 10) : undefined,
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

// GET /sessions/active — list currently active sessions
router.get('/sessions/active', authenticateJWT, requirePermission('session_replay.view'), async (req, res, next) => {
  try {
    const effectiveTenantId = req.user!.is_platform_admin ? undefined : req.user!.tid;
    const sessions = await replayService.getActiveSessions(effectiveTenantId);
    res.json({
      ok: true,
      data: sessions,
      meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

// POST /sessions/:sessionId/segments — create a segment
router.post('/sessions/:sessionId/segments', authenticateJWT, async (req, res, next) => {
  try {
    const { segmentType, dashboardId } = req.body;
    const segment = await replayService.createSegment(req.params.sessionId, segmentType, dashboardId);
    res.status(201).json({
      ok: true,
      data: { segmentId: segment.id },
      meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

// POST /sessions/:sessionId/segments/:segmentId/close — close a segment
router.post('/sessions/:sessionId/segments/:segmentId/close', authenticateJWT, async (req, res, next) => {
  try {
    const segment = await replayService.closeSegment(req.params.segmentId);
    res.json({
      ok: true,
      data: segment,
      meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

// POST /sessions/:sessionId/events — store events (HTTP fallback)
router.post('/sessions/:sessionId/events', authenticateJWT, async (req, res, next) => {
  try {
    const { segmentId, events } = req.body;
    if (!segmentId || !Array.isArray(events)) {
      res.status(400).json({
        ok: false,
        error: { code: 'VALIDATION_ERROR', message: 'segmentId and events array are required' },
        meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
      });
      return;
    }
    await replayService.storeEvents(segmentId, events);
    res.json({
      ok: true,
      meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

// POST /sessions/:sessionId/finalize — finalize session on logout/tab close
router.post('/sessions/:sessionId/finalize', authenticateJWT, async (req, res, next) => {
  try {
    const session = await replayService.finalizeStaleSession(req.params.sessionId);
    res.json({
      ok: true,
      data: session,
      meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

// POST /sessions/:sessionId/beacon — beacon-friendly finalize (token in body, for sendBeacon)
router.post('/sessions/:sessionId/beacon', async (req, res, next) => {
  try {
    const token = req.body?.token;
    if (token) {
      try { jwt.verify(token, config.jwtSecret); } catch { return res.status(401).json({ ok: false }); }
    }
    // Also store any last events if provided
    if (req.body?.segmentId && Array.isArray(req.body?.events) && req.body.events.length > 0) {
      await replayService.storeEvents(req.body.segmentId, req.body.events);
    }
    const session = await replayService.finalizeStaleSession(req.params.sessionId);
    res.json({ ok: true, data: session });
  } catch (err) {
    next(err);
  }
});

// ── Segments ────────────────────────────────────────────────────────────────

// GET /segments — list segments
router.get('/segments', authenticateJWT, requirePermission('session_replay.view'), async (req, res, next) => {
  try {
    const {
      dashboardId, segmentType, userId, tenantId,
      dateFrom, dateTo, isTraining, limit, offset,
    } = req.query;
    const effectiveTenantId = req.user!.is_platform_admin ? (tenantId as string) : req.user!.tid;
    const result = await replayService.listSegments({
      dashboardId: dashboardId as string,
      segmentType: segmentType as string,
      userId: userId as string,
      tenantId: effectiveTenantId,
      dateFrom: dateFrom as string,
      dateTo: dateTo as string,
      isTraining: isTraining !== undefined ? isTraining === 'true' : undefined,
      limit: limit ? parseInt(limit as string, 10) : undefined,
      offset: offset ? parseInt(offset as string, 10) : undefined,
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

// GET /segments/:segmentId — get segment details
router.get('/segments/:segmentId', authenticateJWT, requirePermission('session_replay.view'), async (req, res, next) => {
  try {
    const segment = await replayService.getSegment(req.params.segmentId);
    res.json({
      ok: true,
      data: segment,
      meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

// GET /segments/:segmentId/events — get recording events for playback
router.get('/segments/:segmentId/events', authenticateJWT, requirePermission('session_replay.view'), async (req, res, next) => {
  try {
    const events = await replayService.getEvents(req.params.segmentId);
    res.json({
      ok: true,
      data: events,
      meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

// PATCH /segments/:segmentId/training — flag as training
router.patch('/segments/:segmentId/training', authenticateJWT, requirePermission('session_replay.manage'), async (req, res, next) => {
  try {
    const segment = await replayService.flagTraining(req.params.segmentId, req.body.is_training);
    res.json({
      ok: true,
      data: segment,
      meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

// PATCH /segments/:segmentId/permanent — flag as permanent
router.patch('/segments/:segmentId/permanent', authenticateJWT, requirePermission('session_replay.manage'), async (req, res, next) => {
  try {
    const segment = await replayService.flagPermanent(req.params.segmentId, req.body.is_permanent);
    res.json({
      ok: true,
      data: segment,
      meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

// ── Tags ────────────────────────────────────────────────────────────────────

// POST /segments/:segmentId/tags — add tag
router.post('/segments/:segmentId/tags', authenticateJWT, requirePermission('session_replay.manage'), async (req, res, next) => {
  try {
    const tag = await replayService.addTag(req.params.segmentId, req.body.tag, req.user!.sub);
    res.status(201).json({
      ok: true,
      data: tag,
      meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

// DELETE /segments/:segmentId/tags/:tagId — remove tag
router.delete('/segments/:segmentId/tags/:tagId', authenticateJWT, requirePermission('session_replay.manage'), async (req, res, next) => {
  try {
    await replayService.removeTag(req.params.tagId);
    res.json({
      ok: true,
      meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

// ── Comments ────────────────────────────────────────────────────────────────

// GET /segments/:segmentId/comments — list comments
router.get('/segments/:segmentId/comments', authenticateJWT, requirePermission('session_replay.view'), async (req, res, next) => {
  try {
    const comments = await replayService.listComments(req.params.segmentId);
    res.json({
      ok: true,
      data: comments,
      meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

// POST /segments/:segmentId/comments — add comment
router.post('/segments/:segmentId/comments', authenticateJWT, requirePermission('session_replay.manage'), async (req, res, next) => {
  try {
    const comment = await replayService.addComment(
      req.params.segmentId,
      req.user!.sub,
      req.body.body,
      req.body.timestamp_seconds
    );
    res.status(201).json({
      ok: true,
      data: comment,
      meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

export default router;
