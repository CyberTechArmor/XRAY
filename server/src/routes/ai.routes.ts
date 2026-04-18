import { Router } from 'express';
import { authenticateJWT } from '../middleware/auth';
import { AppError } from '../middleware/error-handler';
import * as aiService from '../services/ai.service';
import * as dashboardService from '../services/dashboard.service';

const router = Router();

// Helper: verify the user has access to the given dashboard
async function assertDashboardAccess(
  user: { sub: string; tid: string; is_owner: boolean; is_platform_admin: boolean; permissions: string[] },
  dashboardId: string
): Promise<void> {
  if (user.is_platform_admin || user.is_owner || (user.permissions || []).includes('dashboards.manage')) return;
  const ok = await dashboardService.checkUserAccess(dashboardId, user.sub);
  if (!ok) {
    throw new AppError(403, 'FORBIDDEN', 'You do not have access to this dashboard');
  }
}

// GET /api/ai/context/:dashboardId — is the AI available here? also returns suggested initial state
router.get('/context/:dashboardId', authenticateJWT, async (req, res, next) => {
  try {
    await assertDashboardAccess(req.user as any, req.params.dashboardId);
    const avail = await aiService.isAiAvailableForUser(req.user!.sub, req.params.dashboardId);
    const settings = avail.available ? await aiService.getCurrentSettings() : null;
    const usage = avail.available ? await aiService.getTodayUsage(req.user!.tid, req.user!.sub) : null;
    res.json({
      ok: true,
      data: {
        available: avail.available,
        reason: avail.reason || null,
        model: settings ? settings.model_id : null,
        usage: usage ? { count: usage.count, cap: usage.cap, remaining: usage.remaining } : null,
      },
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/ai/threads?dashboardId=... — list current user's threads for a dashboard
router.get('/threads', authenticateJWT, async (req, res, next) => {
  try {
    const dashboardId = String(req.query.dashboardId || '');
    if (!dashboardId) {
      return res.status(400).json({ ok: false, error: { code: 'MISSING_DASHBOARD', message: 'dashboardId is required' } });
    }
    await assertDashboardAccess(req.user as any, dashboardId);
    const result = await aiService.listThreads(req.user!.tid, req.user!.sub, dashboardId);
    res.json({ ok: true, data: result });
  } catch (err) {
    next(err);
  }
});

// POST /api/ai/threads — create a thread
router.post('/threads', authenticateJWT, async (req, res, next) => {
  try {
    const { dashboardId, title } = req.body || {};
    if (!dashboardId) {
      return res.status(400).json({ ok: false, error: { code: 'MISSING_DASHBOARD', message: 'dashboardId is required' } });
    }
    await assertDashboardAccess(req.user as any, dashboardId);
    const result = await aiService.createThread(req.user!.tid, req.user!.sub, dashboardId, title);
    res.status(201).json({ ok: true, data: result });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/ai/threads/:id — rename
router.patch('/threads/:id', authenticateJWT, async (req, res, next) => {
  try {
    const { title } = req.body || {};
    await aiService.renameThread(req.params.id, req.user!.tid, req.user!.sub, title || '');
    res.json({ ok: true, data: { message: 'Renamed' } });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/ai/threads/:id — archive
router.delete('/threads/:id', authenticateJWT, async (req, res, next) => {
  try {
    await aiService.archiveThread(req.params.id, req.user!.tid, req.user!.sub);
    res.json({ ok: true, data: { message: 'Archived' } });
  } catch (err) {
    next(err);
  }
});

// GET /api/ai/threads/:id/messages — list messages
router.get('/threads/:id/messages', authenticateJWT, async (req, res, next) => {
  try {
    const result = await aiService.listMessages(req.params.id, req.user!.tid, req.user!.sub);
    res.json({ ok: true, data: result });
  } catch (err) {
    next(err);
  }
});

// POST /api/ai/threads/:id/messages — send a message (SSE stream back)
router.post('/threads/:id/messages', authenticateJWT, async (req, res, next) => {
  try {
    const { content, context } = req.body || {};
    if (!content || typeof content !== 'string') {
      return res.status(400).json({ ok: false, error: { code: 'INVALID_INPUT', message: 'content is required' } });
    }
    // streamReply takes over the response (SSE), do not call res.json after this
    await aiService.streamReply(
      res,
      req.params.id,
      req.user!.tid,
      req.user!.sub,
      content,
      context || {},
    );
  } catch (err) {
    // If headers already sent (SSE started), cannot respond via next() — just end
    if (res.headersSent) {
      try { res.end(); } catch {}
      return;
    }
    next(err);
  }
});

// GET /api/ai/pins?dashboardId=... — list pinned findings for this user + dashboard
router.get('/pins', authenticateJWT, async (req, res, next) => {
  try {
    const dashboardId = String(req.query.dashboardId || '');
    if (!dashboardId) {
      return res.status(400).json({ ok: false, error: { code: 'MISSING_DASHBOARD', message: 'dashboardId is required' } });
    }
    await assertDashboardAccess(req.user as any, dashboardId);
    const result = await aiService.listPins(req.user!.tid, req.user!.sub, dashboardId);
    res.json({ ok: true, data: result });
  } catch (err) {
    next(err);
  }
});

// POST /api/ai/pins — pin a message
router.post('/pins', authenticateJWT, async (req, res, next) => {
  try {
    const { messageId, note } = req.body || {};
    if (!messageId) {
      return res.status(400).json({ ok: false, error: { code: 'MISSING_MESSAGE', message: 'messageId is required' } });
    }
    const result = await aiService.pinMessage(messageId, req.user!.tid, req.user!.sub, note || null);
    res.status(201).json({ ok: true, data: result });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/ai/pins/:id — unpin
router.delete('/pins/:id', authenticateJWT, async (req, res, next) => {
  try {
    await aiService.unpinMessage(req.params.id, req.user!.tid, req.user!.sub);
    res.json({ ok: true, data: { message: 'Unpinned' } });
  } catch (err) {
    next(err);
  }
});

// GET /api/ai/user-prefs/:dashboardId — current user's on/off pref for this dashboard
router.get('/user-prefs/:dashboardId', authenticateJWT, async (req, res, next) => {
  try {
    await assertDashboardAccess(req.user as any, req.params.dashboardId);
    const enabled = await aiService.getUserPref(req.user!.sub, req.params.dashboardId);
    res.json({ ok: true, data: { enabled } });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/ai/user-prefs/:dashboardId — toggle for the current user
router.patch('/user-prefs/:dashboardId', authenticateJWT, async (req, res, next) => {
  try {
    await assertDashboardAccess(req.user as any, req.params.dashboardId);
    const { enabled } = req.body || {};
    await aiService.setUserPref(req.user!.sub, req.params.dashboardId, req.user!.tid, !!enabled);
    res.json({ ok: true, data: { enabled: !!enabled } });
  } catch (err) {
    next(err);
  }
});

export default router;
