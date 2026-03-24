import { Router } from 'express';
import { authenticateJWT } from '../middleware/auth';
import * as inboxService from '../services/inbox.service';
import { z } from 'zod';
import { validateBody } from '../lib/validation';

const router = Router();

// recipientIds accepts UUIDs or the special 'support' token (resolves to platform admin IDs)
const recipientIdSchema = z.string().refine(
  (val) => val === 'support' || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(val),
  { message: 'Must be a valid UUID or "support"' }
);

const sendSchema = z.object({
  threadId: z.string().uuid().optional(),
  recipientIds: z.array(recipientIdSchema).optional(),
  subject: z.string().min(1).max(200).optional(),
  body: z.string().min(1).max(10000),
  tag: z.string().max(50).optional(),
});

const tagSchema = z.object({
  tag: z.string().max(50).nullable(),
});

// GET / - list threads
router.get('/', authenticateJWT, async (req, res, next) => {
  try {
    const search = typeof req.query.search === 'string' ? req.query.search : undefined;
    const archived = req.query.archived === 'true';
    const limit = parseInt(req.query.limit as string, 10) || 50;
    const offset = parseInt(req.query.offset as string, 10) || 0;
    const threads = await inboxService.listThreads(
      req.user!.sub, req.user!.tid, req.user!.is_platform_admin, search, limit, offset, archived
    );
    res.json({
      ok: true,
      data: threads,
      meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

// GET /unread - get unread count
router.get('/unread', authenticateJWT, async (req, res, next) => {
  try {
    const count = await inboxService.getUnreadCount(req.user!.sub);
    res.json({
      ok: true,
      data: { count },
      meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

// GET /recipients - get available recipients for compose
router.get('/recipients', authenticateJWT, async (req, res, next) => {
  try {
    const result = await inboxService.getRecipients(
      req.user!.sub, req.user!.tid, req.user!.is_platform_admin
    );
    res.json({
      ok: true,
      data: result,
      meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

// GET /recipients/:tenantId - get members of a specific tenant (platform admin only)
router.get('/recipients/:tenantId', authenticateJWT, async (req, res, next) => {
  try {
    if (!req.user!.is_platform_admin) {
      return res.status(403).json({ ok: false, error: { code: 'FORBIDDEN', message: 'Platform admin only' } });
    }
    const members = await inboxService.getTenantMembers(req.params.tenantId);
    res.json({
      ok: true,
      data: members,
      meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

// GET /:threadId - get thread messages
router.get('/:threadId', authenticateJWT, async (req, res, next) => {
  try {
    const messages = await inboxService.getThreadMessages(req.params.threadId, req.user!.sub);
    res.json({
      ok: true,
      data: messages,
      meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

// POST / - send message (new thread or reply)
router.post('/', authenticateJWT, async (req, res, next) => {
  try {
    const data = validateBody(sendSchema, req.body);

    // Resolve 'support' token to actual platform admin user IDs
    if (data.recipientIds && data.recipientIds.includes('support')) {
      const adminIds = await inboxService.getPlatformAdminIds();
      data.recipientIds = data.recipientIds
        .filter((id: string) => id !== 'support')
        .concat(adminIds);
    }

    const result = await inboxService.sendMessage(
      req.user!.sub, req.user!.tid, req.user!.is_platform_admin, data
    );

    // Notify all thread participants via WebSocket (except sender)
    try {
      const { sendToUser } = await import('../ws');
      const participants = await inboxService.getThreadParticipants(result.threadId);
      for (const pid of participants) {
        if (pid === req.user!.sub) continue; // don't notify sender
        const unreadCount = await inboxService.getUnreadCount(pid);
        sendToUser(pid, 'inbox:new-message', {
          threadId: result.threadId,
          messageId: result.messageId,
          subject: data.subject || null,
          senderName: req.user!.sub,
          preview: data.body.substring(0, 120),
          unreadCount,
        });
      }
    } catch {}

    res.status(201).json({
      ok: true,
      data: result,
      meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

// PATCH /:threadId/archive - toggle archive
router.patch('/:threadId/archive', authenticateJWT, async (req, res, next) => {
  try {
    const isArchived = await inboxService.toggleArchive(req.params.threadId, req.user!.sub);
    res.json({
      ok: true,
      data: { is_archived: isArchived },
      meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

// PATCH /:threadId/tag - set tag on thread
router.patch('/:threadId/tag', authenticateJWT, async (req, res, next) => {
  try {
    const data = validateBody(tagSchema, req.body);
    const tag = await inboxService.setThreadTag(req.params.threadId, data.tag);
    res.json({
      ok: true,
      data: { tag },
      meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

// PATCH /:threadId/star - toggle star
router.patch('/:threadId/star', authenticateJWT, async (req, res, next) => {
  try {
    const isStarred = await inboxService.toggleStar(req.params.threadId, req.user!.sub);
    res.json({
      ok: true,
      data: { is_starred: isStarred },
      meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

export default router;
