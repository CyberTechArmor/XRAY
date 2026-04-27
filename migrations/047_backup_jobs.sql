-- Migration 047: Backup jobs queue (step 12 close-out — Backups admin UI Phase B)
--
-- Queue table consumed by the backup-worker sidecar container. The
-- server enqueues a row when an admin clicks "Backup now" / "Sync to
-- S3" / "Run drill" in Admin → Backups; the worker polls, claims
-- the oldest pending job via SELECT … FOR UPDATE SKIP LOCKED,
-- shells out to the matching script, and writes back exit_code +
-- output. The frontend polls GET /api/admin/backups/jobs/:id until
-- status terminates.
--
-- Why a queue (and not docker.sock-from-server):
--   - The server runs as a non-owner non-super DB role (xray_app,
--     migration 045 close-out); it has no shell-out path to
--     pg_basebackup or `docker exec`.
--   - Mounting /var/run/docker.sock into the server container would
--     turn server compromise into host compromise. The worker
--     sidecar IS allowed docker.sock (it can only spawn the same
--     three scripts the server enqueues), but the application
--     server itself stays clean.
--
-- Schema:
--   id            UUID PK
--   kind          'base' | 's3sync' | 'drill'  (CHECK enforced)
--   status        'pending' | 'running' | 'completed' | 'failed'
--                  - pending  → just enqueued
--                  - running  → worker claimed; started_at set
--                  - completed → exit_code = 0
--                  - failed   → exit_code != 0 (or worker crashed)
--   args          JSONB — kind-specific:
--                  base    : {}
--                  s3sync  : { mode: 'wal'|'base'|'all'|'prune' }
--                  drill   : { from_s3?: boolean, target_time?: ISO }
--   exit_code     SMALLINT (NULL until terminal)
--   output        TEXT — capped at 1MB by the worker
--   requested_by  FK platform.users.id (NULL for cron-triggered jobs)
--   created_at    when the row was inserted
--   started_at    when the worker claimed it (NULL until claimed)
--   finished_at   when the worker wrote terminal status
--
-- RLS: platform-admin-only (mirrors backup_drill_runs / tenant_notes).
-- The worker connects as the bootstrap super (xray) so it bypasses
-- RLS via rolsuper=true; the application server uses withAdminClient
-- to set app.is_platform_admin and pass the policy.
--
-- Idempotent.

BEGIN;

CREATE TABLE IF NOT EXISTS platform.backup_jobs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind          TEXT NOT NULL
                  CHECK (kind IN ('base','s3sync','drill')),
  status        TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','running','completed','failed')),
  args          JSONB NOT NULL DEFAULT '{}'::jsonb,
  exit_code     SMALLINT,
  output        TEXT,
  requested_by  UUID REFERENCES platform.users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at    TIMESTAMPTZ,
  finished_at   TIMESTAMPTZ
);

-- Worker's claim query orders by (status, created_at) to find the
-- oldest pending job. Status-then-time index keeps that planner-friendly.
CREATE INDEX IF NOT EXISTS idx_backup_jobs_status_created
  ON platform.backup_jobs (status, created_at);

-- Listing endpoint orders newest-first by created_at; covered by the
-- existing index for the descending case (Postgres can scan an asc
-- index backwards), no separate index needed.

ALTER TABLE platform.backup_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.backup_jobs FORCE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY platform_admin_bypass ON platform.backup_jobs
    USING      (platform.is_platform_admin())
    WITH CHECK (platform.is_platform_admin());
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

COMMIT;
