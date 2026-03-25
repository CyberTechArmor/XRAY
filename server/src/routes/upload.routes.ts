import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { authenticateJWT } from '../middleware/auth';
import * as uploadService from '../services/upload.service';
import { z } from 'zod';
import { AppError } from '../middleware/error-handler';
import { config } from '../config';

// In Docker: __dirname=/app/dist/routes → resolve to /app/uploads
// In dev: __dirname=.../server/src/routes → resolve to .../server/uploads
const UPLOAD_DIR = path.resolve(__dirname, '../../uploads');

// Ensure upload directory exists
try {
  if (!fs.existsSync(UPLOAD_DIR)) {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  }
} catch (e) {
  console.warn('Could not create uploads directory:', (e as Error).message);
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, UPLOAD_DIR);
  },
  filename: (_req, file, cb) => {
    const uniqueSuffix = crypto.randomUUID();
    const ext = path.extname(file.originalname);
    cb(null, `${uniqueSuffix}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
});

const contextTypeSchema = z.enum(['connection', 'inbox', 'invoice', 'general']);

const router = Router();

// GET / - list files (platform admin: all tenants with optional filter; others: own tenant)
router.get('/', authenticateJWT, async (req, res, next) => {
  try {
    const contextType = req.query.contextType as string | undefined;
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);
    const offset = parseInt(req.query.offset as string) || 0;

    if (req.user!.is_platform_admin) {
      // Platform admin: list across all tenants with optional tenant filter
      const tenantId = req.query.tenantId as string | undefined;
      const result = await uploadService.listAllFilesAdmin({ contextType, tenantId, limit, offset });
      res.json({
        ok: true,
        data: result.rows,
        meta: {
          total: result.total,
          limit,
          offset,
          request_id: req.headers['x-request-id'] || '',
          timestamp: new Date().toISOString(),
        },
      });
      return;
    }

    const result = await uploadService.listAllFiles(req.user!.tid, { contextType, limit, offset });
    res.json({
      ok: true,
      data: result.rows,
      meta: {
        total: result.total,
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

// POST / - upload files
router.post('/', authenticateJWT, upload.array('files', 10), async (req, res, next) => {
  try {
    const files = req.files as Express.Multer.File[];
    if (!files || files.length === 0) {
      throw new AppError(400, 'BAD_REQUEST', 'No files provided');
    }

    const contextType = contextTypeSchema.parse(req.body.contextType);
    const contextId = req.body.contextId || undefined;

    // Platform admin can upload to a specific tenant
    const targetTenant = (req.user!.is_platform_admin && req.body.tenantId) ? req.body.tenantId : req.user!.tid;

    const records: any[] = [];
    for (const file of files) {
      const record = await uploadService.createFileRecord({
        tenantId: targetTenant,
        uploadedBy: req.user!.sub,
        originalName: file.originalname,
        storedName: file.filename,
        mimeType: file.mimetype,
        sizeBytes: file.size,
        contextType,
        contextId,
      });
      records.push(record);
    }

    // Dispatch file.uploaded webhook event
    import('../services/webhook.service').then(wh => {
      wh.dispatchEvent(req.user!.tid, 'file.uploaded', {
        files: records.map((r: any) => ({ id: r.id, name: r.original_name, mimeType: r.mime_type, size: r.size_bytes })),
        userId: req.user!.sub,
        contextType,
        contextId,
      });
    }).catch(() => {});

    res.status(201).json({
      ok: true,
      data: records,
      meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

// GET /billing-files - list all billing files across tenants (platform admin only)
router.get('/billing-files', authenticateJWT, async (req, res, next) => {
  try {
    if (!req.user!.is_platform_admin) {
      throw new AppError(403, 'FORBIDDEN', 'Platform admin access required');
    }
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);
    const offset = parseInt(req.query.offset as string) || 0;
    const result = await uploadService.listAllBillingFiles({ limit, offset });
    res.json({
      ok: true,
      data: result.rows,
      meta: {
        total: result.total,
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

// GET /:id - get file info
router.get('/:id', authenticateJWT, async (req, res, next) => {
  try {
    const file = await uploadService.getFileById(req.params.id);
    res.json({
      ok: true,
      data: file,
      meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

// POST /:id/token - generate short-lived token for browser-direct access
router.post('/:id/token', authenticateJWT, async (req, res, next) => {
  try {
    // Verify file exists and user has access
    await uploadService.getFileById(req.params.id);
    // Create a short-lived token (5 minutes) with file id + user id
    const token = jwt.sign(
      { fid: req.params.id, sub: req.user!.sub },
      config.jwtSecret,
      { expiresIn: '5m' }
    );
    res.json({ ok: true, data: { token } });
  } catch (err) {
    next(err);
  }
});

// GET /:id/download - download/serve file (supports JWT header or ?token= query param)
router.get('/:id/download', async (req, res, next) => {
  try {
    // Try token query param for browser-direct access (Open in new tab / Download)
    const tokenParam = req.query.token as string | undefined;
    if (tokenParam) {
      try {
        const payload = jwt.verify(tokenParam, config.jwtSecret) as { fid: string; sub: string };
        if (payload.fid !== req.params.id) {
          throw new AppError(403, 'FORBIDDEN', 'Token does not match file');
        }
      } catch (e) {
        if (e instanceof AppError) throw e;
        throw new AppError(401, 'UNAUTHORIZED', 'Invalid or expired file token');
      }
    } else {
      // Fall back to JWT header auth for in-app fetches (images, CSV, text preview)
      await new Promise<void>((resolve, reject) => {
        authenticateJWT(req, res, (err?: any) => err ? reject(err) : resolve());
      });
    }

    const file = await uploadService.getFileById(req.params.id);
    const filePath = path.join(UPLOAD_DIR, file.stored_name);

    if (!fs.existsSync(filePath)) {
      throw new AppError(404, 'NOT_FOUND', 'File not found on disk');
    }

    res.setHeader('Content-Type', file.mime_type);
    res.setHeader('Content-Disposition', `inline; filename="${file.original_name}"`);
    res.sendFile(filePath);
  } catch (err) {
    next(err);
  }
});

// DELETE /:id - delete file
router.delete('/:id', authenticateJWT, async (req, res, next) => {
  try {
    const deleted = await uploadService.deleteFileRecord(req.params.id);

    // Remove file from disk
    const filePath = path.join(UPLOAD_DIR, (deleted as any).stored_name);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }

    res.json({
      ok: true,
      data: { id: deleted.id },
      meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

// POST /:id/share - share file to a tenant (platform admin only)
router.post('/:id/share', authenticateJWT, async (req, res, next) => {
  try {
    if (!req.user!.is_platform_admin) {
      throw new AppError(403, 'FORBIDDEN', 'Platform admin access required');
    }
    const tenantId = req.body.tenantId;
    if (!tenantId) {
      throw new AppError(400, 'BAD_REQUEST', 'tenantId is required');
    }
    const shared = await uploadService.shareFileToTenant(req.params.id, tenantId, req.user!.sub);
    res.status(201).json({
      ok: true,
      data: shared,
      meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

// GET /context/:contextType/:contextId - list files for a context
router.get('/context/:contextType/:contextId', authenticateJWT, async (req, res, next) => {
  try {
    const contextType = contextTypeSchema.parse(req.params.contextType);

    // For inbox files: verify user is a thread participant (cross-tenant threads are normal)
    // Platform admins can also see all inbox thread files
    if (contextType === 'inbox') {
      if (!req.user!.is_platform_admin) {
        const { getThreadParticipants } = await import('../services/inbox.service');
        const participants = await getThreadParticipants(req.params.contextId);
        if (!participants.includes(req.user!.sub)) {
          throw new AppError(403, 'FORBIDDEN', 'Not a participant of this thread');
        }
      }
      // Don't filter by tenant — inbox threads are cross-tenant
      const files = await uploadService.listFilesByContext(contextType, req.params.contextId);
      res.json({
        ok: true,
        data: files,
        meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
      });
      return;
    }

    // For non-inbox contexts: filter by tenant so users only see their own files
    const files = await uploadService.listFilesByContext(contextType, req.params.contextId, req.user!.tid);
    res.json({
      ok: true,
      data: files,
      meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

export default router;
