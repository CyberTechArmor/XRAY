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

// GET / - list all files for tenant
router.get('/', authenticateJWT, async (req, res, next) => {
  try {
    const contextType = req.query.contextType as string | undefined;
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);
    const offset = parseInt(req.query.offset as string) || 0;
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

    const records = [];
    for (const file of files) {
      const record = await uploadService.createFileRecord({
        tenantId: req.user!.tid,
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

    res.status(201).json({
      ok: true,
      data: records,
      meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
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

// GET /context/:contextType/:contextId - list files for a context
router.get('/context/:contextType/:contextId', authenticateJWT, async (req, res, next) => {
  try {
    const contextType = contextTypeSchema.parse(req.params.contextType);
    const files = await uploadService.listFilesByContext(contextType, req.params.contextId);
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
