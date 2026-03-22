import { Router, Response } from 'express';
import { authenticateJWT } from '../middleware/auth';
import { requirePermission } from '../middleware/rbac';
import { validateBody } from '../lib/validation';
import { z } from 'zod';
import * as meetService from '../services/meet.service';
import { sendEmail } from '../services/email.service';

const router = Router();

// ── SSE client tracking for support call notifications ──
const sseClients = new Map<string, Response>(); // keyed by admin user ID

export function broadcastSupportCall(callData: Record<string, unknown>): void {
  const payload = `data: ${JSON.stringify(callData)}\n\n`;
  for (const [, res] of sseClients) {
    try { res.write(payload); } catch { /* client gone */ }
  }
}

function removeSseClient(userId: string): void {
  sseClients.delete(userId);
}

const createRoomSchema = z.object({
  roomId: z.string().min(1).max(100).regex(/^[a-zA-Z0-9_-]+$/).optional(),
  displayName: z.string().min(1).max(255).optional(),
  maxParticipants: z.number().int().min(1).max(500).optional(),
});

const inviteSchema = z.object({
  joinUrl: z.string().url(),
  roomName: z.string().min(1),
  emails: z.array(z.string().email()).min(1).max(50),
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

// POST /invite - send meeting invite emails
router.post('/invite', authenticateJWT, async (req, res, next) => {
  try {
    const data = validateBody(inviteSchema, req.body);
    const senderName = await meetService.getUserDisplayName(req.user!.sub) || 'A team member';
    const subject = `${senderName} invited you to a meeting on XRay`;
    const html = `<h2>You're invited to a meeting</h2>
      <p><strong>${senderName}</strong> has invited you to join a video meeting.</p>
      <p><a href="${data.joinUrl}" style="display:inline-block;padding:12px 24px;background:#3ee8b5;color:#000;border-radius:8px;text-decoration:none;font-weight:600">Join Meeting</a></p>
      <p style="color:#888;font-size:13px">Room: ${data.roomName}</p>
      <p style="color:#888;font-size:13px">Or copy this link: ${data.joinUrl}</p>`;
    const text = `${senderName} invited you to a meeting. Join: ${data.joinUrl}`;

    const results: { email: string; sent: boolean; error?: string }[] = [];
    for (const email of data.emails) {
      try {
        await sendEmail({ to: email, subject, html, text });
        results.push({ email, sent: true });
      } catch (err: any) {
        results.push({ email, sent: false, error: err.code || err.message || 'Send failed' });
      }
    }

    res.json({
      ok: true,
      data: { results },
      meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

// POST /test-connection - test MEET API connectivity with detailed diagnostics
router.post('/test-connection', authenticateJWT, requirePermission('platform.admin'), async (req, res, next) => {
  try {
    const result = await meetService.testConnection();
    res.json({
      ok: true,
      data: result,
      meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

// GET /support-calls/stream - SSE endpoint for real-time support call notifications (platform admin)
// Note: EventSource API doesn't support custom headers, so we accept JWT via ?token= query param
router.get('/support-calls/stream', async (req, res, next) => {
  try {
    // Auth: try header first, then query param (for EventSource)
    const tokenParam = req.query.token as string | undefined;
    if (tokenParam && !req.headers.authorization) {
      req.headers.authorization = `Bearer ${tokenParam}`;
    }
    const authOk = await new Promise<boolean>((resolve) => {
      authenticateJWT(req, res, (err?: any) => {
        if (err) { resolve(false); return; }
        resolve(true);
      });
      // If auth middleware sends a response directly (no next call), we'll never resolve
      // Set a timeout to catch this case
      setTimeout(() => resolve(false), 1000);
    });
    if (!authOk || !req.user) return; // auth middleware already sent 401
    if (!req.user.is_platform_admin) {
      if (!res.headersSent) res.status(403).json({ ok: false, error: { message: 'Platform admin only' } });
      return;
    }

    // Set SSE headers
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no', // disable nginx buffering
    });
    res.flushHeaders();

    // Send initial connected event
    res.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);

    // Send any existing pending support calls
    const pending = await meetService.getPendingSupportCalls();
    for (const call of pending) {
      res.write(`data: ${JSON.stringify({ type: 'support_call', ...call })}\n\n`);
    }

    // Register this client
    const userId = req.user!.sub;
    // Close existing connection for same user
    const existing = sseClients.get(userId);
    if (existing) {
      try { existing.end(); } catch { /* ignore */ }
    }
    sseClients.set(userId, res);

    // Keep-alive ping every 30s
    const keepAlive = setInterval(() => {
      try { res.write(': ping\n\n'); } catch { clearInterval(keepAlive); }
    }, 30000);

    // Clean up on disconnect
    req.on('close', () => {
      clearInterval(keepAlive);
      removeSseClient(userId);
    });
  } catch (err) {
    next(err);
  }
});

// GET /support-config - get support call configuration (any authenticated user)
router.get('/support-config', authenticateJWT, async (req, res, next) => {
  try {
    const config = await meetService.getSupportCallConfig();
    res.json({ ok: true, data: config });
  } catch (err) {
    next(err);
  }
});

// POST /support-call - tenant user requests XRay support (creates room + notifies admin)
router.post('/support-call', authenticateJWT, async (req, res, next) => {
  try {
    // Check if support calls are enabled and within active hours
    const supportConfig = await meetService.getSupportCallConfig();
    if (!supportConfig.enabled) {
      res.status(400).json({ ok: false, error: { code: 'SUPPORT_DISABLED', message: 'XRay Support is currently disabled.' } });
      return;
    }
    if (!meetService.isWithinActiveHours(supportConfig)) {
      res.status(400).json({ ok: false, error: { code: 'OUTSIDE_HOURS', message: `XRay Support is available ${supportConfig.active_hours_start || '00:00'}–${supportConfig.active_hours_end || '23:59'} only.` } });
      return;
    }

    // Generate room code and create room
    const roomCode = `xr-support-${Date.now().toString(36)}`;
    const roomResult = await meetService.createRoom({ roomId: roomCode, displayName: 'XRay Support' });

    // Store support call record
    const supportCall = await meetService.createSupportCall(
      req.user!.sub, req.user!.tid, roomCode, roomResult.joinUrl
    );

    // Get caller info for SSE broadcast
    const callerInfo = await meetService.getUserInfo(req.user!.sub);
    const callData = {
      type: 'support_call',
      id: (supportCall as any).id,
      room_code: roomCode,
      join_url: roomResult.joinUrl,
      caller_id: req.user!.sub,
      tenant_id: req.user!.tid,
      caller_name: callerInfo?.name || null,
      caller_email: callerInfo?.email || null,
      created_at: new Date().toISOString(),
    };

    // Broadcast to all connected SSE admin clients
    broadcastSupportCall(callData);

    // Fire webhook if configured
    const webhookConfig = await meetService.getSupportWebhookConfig();
    if (webhookConfig.enabled && webhookConfig.url) {
      const webhookUrl = new URL(webhookConfig.url);
      webhookUrl.searchParams.set('room', roomCode);
      webhookUrl.searchParams.set('joinUrl', roomResult.joinUrl);
      webhookUrl.searchParams.set('callId', (supportCall as any).id);
      fetch(webhookUrl.toString(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event: 'support_call',
          room: roomCode,
          joinUrl: roomResult.joinUrl,
          callId: (supportCall as any).id,
          callerEmail: req.user!.sub,
          tenantId: req.user!.tid,
          timestamp: new Date().toISOString(),
        }),
      }).catch(() => {});
    }

    res.status(201).json({
      ok: true,
      data: { room: roomResult.room, joinUrl: roomResult.joinUrl, roomCode, supportCallId: (supportCall as any).id },
      meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

// GET /support-calls - list pending support calls (platform admin only)
router.get('/support-calls', authenticateJWT, async (req, res, next) => {
  try {
    if (!req.user!.is_platform_admin) {
      res.json({ ok: true, data: [] });
      return;
    }
    const calls = await meetService.getPendingSupportCalls();
    res.json({
      ok: true,
      data: calls,
      meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

// POST /support-calls/:id/answer - mark support call as answered
router.post('/support-calls/:id/answer', authenticateJWT, async (req, res, next) => {
  try {
    await meetService.answerSupportCall(req.params.id);
    res.json({
      ok: true,
      data: { answered: true },
      meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

// GET /members - list tenant members for meeting invites
router.get('/members', authenticateJWT, async (req, res, next) => {
  try {
    const members = await meetService.getTenantMembers(req.user!.tid);
    res.json({
      ok: true,
      data: members,
      meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

export default router;
