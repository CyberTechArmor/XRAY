import { Router } from 'express';
import { authenticateJWT } from '../middleware/auth';
import { requirePermission } from '../middleware/rbac';
import { validateBody } from '../lib/validation';
import { z } from 'zod';
import * as meetService from '../services/meet.service';
import { sendEmail } from '../services/email.service';

const router = Router();

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
