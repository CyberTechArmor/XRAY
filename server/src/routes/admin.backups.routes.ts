import { Router } from 'express';
import { authenticateJWT } from '../middleware/auth';
import { requirePermission } from '../middleware/rbac';
import * as backupService from '../services/backup.service';

const router = Router();

// All routes require platform admin. Backups expose volume sizes,
// retention windows, and operator-initiated drill output — none of
// which should be visible to a non-admin tenant user.
router.use(authenticateJWT, requirePermission('platform.admin'));

// ── GET /api/admin/backups/status ───────────────────────────────
// Aggregated snapshot for the Backups admin landing card. Reads the
// pg_backups RO mount (compose-mounted in docker-compose.yml) plus
// the BACKUP_S3_* env vars. Always returns 200 — when the mount is
// missing or empty, the response carries available=false / empty
// arrays so the UI can render an explicit no-data state.
router.get('/status', async (_req, res, next) => {
  try {
    const status = await backupService.getBackupStatus();
    res.json({ ok: true, data: status });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/admin/backups/drill-history ────────────────────────
// Newest-first list of drill runs. Output preview is capped at 4 KB
// per row in backup.service so the listing payload stays small;
// the full output for any single run is fetched via
// /api/admin/backups/drill/:id.
router.get('/drill-history', async (req, res, next) => {
  try {
    const limitRaw = req.query.limit;
    const limit = typeof limitRaw === 'string' ? parseInt(limitRaw, 10) : 25;
    const safe = Number.isFinite(limit) ? Math.max(1, Math.min(100, limit)) : 25;
    const runs = await backupService.listDrillRuns(safe);
    res.json({ ok: true, data: runs });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/admin/backups/drill/:id ────────────────────────────
// Full output for a single drill run. Returns 404 when the id
// doesn't exist (or is from a different ledger that got truncated).
router.get('/drill/:id', async (req, res, next) => {
  try {
    const run = await backupService.getDrillRun(req.params.id);
    if (!run) {
      res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Drill run not found' } });
      return;
    }
    res.json({ ok: true, data: run });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/admin/backups/drill-log ───────────────────────────
// Append a drill-run record. Used today by:
//   - operator-run scripts/restore-drill.sh with the --log-to-db flag
//     (next session adds that flag); triggered_by='operator' or
//     'cron' depending on how the script was invoked.
//   - Phase B's "Run drill" button when that ships;
//     triggered_by='admin_ui', user_id captured from req.user.
//
// Body: DrillLogInput shape. Validated server-side; no SQL injection
// surface (parameterised insert).
router.post('/drill-log', async (req, res, next) => {
  try {
    const b = req.body || {};
    if (!b.started_at || typeof b.started_at !== 'string') {
      res.status(400).json({ ok: false, error: { code: 'BAD_REQUEST', message: 'started_at (ISO string) required' } });
      return;
    }
    if (typeof b.exit_code !== 'number') {
      res.status(400).json({ ok: false, error: { code: 'BAD_REQUEST', message: 'exit_code (number) required' } });
      return;
    }
    if (typeof b.output !== 'string') {
      res.status(400).json({ ok: false, error: { code: 'BAD_REQUEST', message: 'output (string) required' } });
      return;
    }
    const tb: string = b.triggered_by;
    if (tb !== 'cron' && tb !== 'operator' && tb !== 'admin_ui') {
      res.status(400).json({ ok: false, error: { code: 'BAD_REQUEST', message: "triggered_by must be 'cron' | 'operator' | 'admin_ui'" } });
      return;
    }
    const userId = tb === 'admin_ui' ? req.user?.sub ?? null : null;
    const result = await backupService.logDrillRun({
      started_at: b.started_at,
      finished_at: b.finished_at ?? null,
      exit_code: b.exit_code,
      base_used: b.base_used ?? null,
      target_time: b.target_time ?? null,
      from_s3: b.from_s3 ?? false,
      schema_check_ok: b.schema_check_ok ?? null,
      smoke_query_rows: b.smoke_query_rows ?? null,
      tarball_sha256: b.tarball_sha256 ?? null,
      output: b.output,
      triggered_by: tb,
      user_id: userId,
    });
    res.json({ ok: true, data: result });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/admin/backups/run ─────────────────────────────────
// Enqueue a base-backup job. The backup-worker sidecar will pick
// it up on its next poll and run scripts/backup-platform.sh.
// Returns the job row so the frontend can immediately start polling
// /jobs/:id.
router.post('/run', async (req, res, next) => {
  try {
    const job = await backupService.enqueueJob({
      kind: 'base',
      args: {},
      requested_by: req.user?.sub ?? null,
    });
    res.json({ ok: true, data: job });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/admin/backups/s3-sync ─────────────────────────────
// Body: { mode?: 'wal' | 'base' | 'all' | 'prune' }
// Default mode is 'all' — operator usually wants a full reconcile
// when triggering manually. Mode is validated server-side; an
// invalid value returns 400 (don't let it sit pending in the queue).
router.post('/s3-sync', async (req, res, next) => {
  try {
    const mode = (req.body && req.body.mode) || 'all';
    if (!['wal', 'base', 'all', 'prune'].includes(mode)) {
      res.status(400).json({
        ok: false,
        error: { code: 'BAD_REQUEST', message: "mode must be 'wal' | 'base' | 'all' | 'prune'" },
      });
      return;
    }
    const job = await backupService.enqueueJob({
      kind: 's3sync',
      args: { mode },
      requested_by: req.user?.sub ?? null,
    });
    res.json({ ok: true, data: job });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/admin/backups/drill ───────────────────────────────
// Body: { from_s3?: boolean, target_time?: ISO }
// from_s3 stages from S3 first (cold-restore-from-S3 dry-run);
// target_time enables PITR. Both optional.
router.post('/drill', async (req, res, next) => {
  try {
    const args: Record<string, unknown> = {};
    const b = req.body || {};
    if (typeof b.from_s3 === 'boolean') args.from_s3 = b.from_s3;
    if (typeof b.target_time === 'string') args.target_time = b.target_time;
    const job = await backupService.enqueueJob({
      kind: 'drill',
      args,
      requested_by: req.user?.sub ?? null,
    });
    res.json({ ok: true, data: job });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/admin/backups/jobs ─────────────────────────────────
// Listing of recent jobs (newest first). Useful for the admin UI's
// "what just ran?" row and for catching stuck-running jobs.
router.get('/jobs', async (req, res, next) => {
  try {
    const limitRaw = req.query.limit;
    const limit = typeof limitRaw === 'string' ? parseInt(limitRaw, 10) : 25;
    const safe = Number.isFinite(limit) ? Math.max(1, Math.min(100, limit)) : 25;
    const jobs = await backupService.listJobs(safe);
    res.json({ ok: true, data: jobs });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/admin/backups/jobs/:id ─────────────────────────────
// Single job — full output. Frontend polls this every ~2s after
// enqueuing until status terminates ('completed' or 'failed').
router.get('/jobs/:id', async (req, res, next) => {
  try {
    const job = await backupService.getJob(req.params.id);
    if (!job) {
      res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Job not found' } });
      return;
    }
    res.json({ ok: true, data: job });
  } catch (err) {
    next(err);
  }
});

export default router;
