import { Router } from 'express';
import { authenticateJWT } from '../middleware/auth';
import { requirePermission } from '../middleware/rbac';
import * as pipelineSchema from '../services/pipeline-schema.service';

const router = Router();
router.use(authenticateJWT, requirePermission('platform.admin'));

// ── GET /api/admin/pipeline/globals-sql ─────────────────────────
// Returns the current globals.sql contents + parsed version + the
// last-applied version recorded in platform_settings. Admin UI uses
// this to decide whether to show "update available".
router.get('/globals-sql', async (_req, res, next) => {
  try {
    const info = await pipelineSchema.getGlobalsSchemaInfo();
    res.json({ ok: true, data: info });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/admin/pipeline/globals-applied ────────────────────
// Body: { version: string }
// Records that the operator has applied this version of globals.sql
// to their pipeline DB. The server validates the version matches the
// .sql file's current header (defensive against stale-tab clicks).
router.post('/globals-applied', async (req, res, next) => {
  try {
    const version = req.body && req.body.version;
    if (typeof version !== 'string' || !version) {
      res.status(400).json({
        ok: false,
        error: { code: 'BAD_REQUEST', message: 'version (string) required' },
      });
      return;
    }
    const result = await pipelineSchema.markGlobalsSchemaApplied(
      version,
      req.user?.sub ?? null,
    );
    res.json({ ok: true, data: result });
  } catch (err: any) {
    // Surface the version-mismatch + missing-header errors as 409
    // rather than 500 so the admin UI can show the message.
    if (err && typeof err.message === 'string' && err.message.includes('Version mismatch')) {
      res.status(409).json({ ok: false, error: { code: 'VERSION_MISMATCH', message: err.message } });
      return;
    }
    next(err);
  }
});

export default router;
