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

// ── GET /api/admin/pipeline/initial-status ──────────────────────
// Returns whether the operator has marked the initial pipeline-DB
// setup as run, and the db_name they entered. Drives the "Initial
// setup" card's pristine vs. completed rendering.
router.get('/initial-status', async (_req, res, next) => {
  try {
    const status = await pipelineSchema.getInitialSetupStatus();
    res.json({ ok: true, data: status });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/admin/pipeline/initial-applied ────────────────────
// Body: { db_name: string }
// Records that the operator has run the initial bootstrap SQL.
// Stores timestamp + db_name in platform_settings — NEVER the
// password. XRay doesn't connect to the pipeline DB; this is a
// pure UX bookkeeping endpoint.
router.post('/initial-applied', async (req, res, next) => {
  try {
    const dbName = req.body && req.body.db_name;
    if (typeof dbName !== 'string') {
      res.status(400).json({
        ok: false,
        error: { code: 'BAD_REQUEST', message: 'db_name (string) required' },
      });
      return;
    }
    const status = await pipelineSchema.markInitialSetupApplied(
      dbName,
      req.user?.sub ?? null,
    );
    res.json({ ok: true, data: status });
  } catch (err: any) {
    if (err && typeof err.message === 'string' && err.message.startsWith('Invalid db_name')) {
      res.status(400).json({ ok: false, error: { code: 'BAD_REQUEST', message: err.message } });
      return;
    }
    next(err);
  }
});

// ── Per-integration schemas ─────────────────────────────────────
// One file per integration under scripts/pipeline-schemas/integrations/.
// Same drift-tracking shape as globals; namespaced under /integrations.

// List of integration directories under scripts/pipeline-schemas/integrations/.
// Each entry carries its `files` array (e.g. ['schema', 'render']) so the
// admin card can render one row per file without a second roundtrip.
router.get('/integrations', async (_req, res, next) => {
  try {
    const slugs = await pipelineSchema.listIntegrationSlugs();
    res.json({ ok: true, data: { slugs } });
  } catch (err) {
    next(err);
  }
});

function isMissingIntegration(err: any): boolean {
  return (
    (err && err.code === 'ENOENT') ||
    (err &&
      typeof err.message === 'string' &&
      (err.message.startsWith('Invalid integration slug') ||
        err.message.startsWith('Invalid integration file')))
  );
}

router.get('/integrations/:slug/files/:file', async (req, res, next) => {
  try {
    const info = await pipelineSchema.getIntegrationFileInfo(
      req.params.slug,
      req.params.file,
    );
    res.json({ ok: true, data: info });
  } catch (err: any) {
    if (isMissingIntegration(err)) {
      res.status(404).json({
        ok: false,
        error: { code: 'NOT_FOUND', message: 'No such integration schema file' },
      });
      return;
    }
    next(err);
  }
});

router.post('/integrations/:slug/files/:file/applied', async (req, res, next) => {
  try {
    const version = req.body && req.body.version;
    if (typeof version !== 'string' || !version) {
      res.status(400).json({
        ok: false,
        error: { code: 'BAD_REQUEST', message: 'version (string) required' },
      });
      return;
    }
    const result = await pipelineSchema.markIntegrationFileApplied(
      req.params.slug,
      req.params.file,
      version,
      req.user?.sub ?? null,
    );
    res.json({ ok: true, data: result });
  } catch (err: any) {
    if (err && typeof err.message === 'string' && err.message.includes('Version mismatch')) {
      res.status(409).json({ ok: false, error: { code: 'VERSION_MISMATCH', message: err.message } });
      return;
    }
    if (isMissingIntegration(err)) {
      res.status(404).json({
        ok: false,
        error: { code: 'NOT_FOUND', message: 'No such integration schema file' },
      });
      return;
    }
    next(err);
  }
});

export default router;