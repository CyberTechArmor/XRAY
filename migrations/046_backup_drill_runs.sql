-- Migration 046: Backup drill runs ledger (step 12 close-out — Backups admin UI Phase A)
--
-- Persists the verbatim output of every restore-drill execution so
-- the Backups admin view can render history without re-running the
-- drill. Also surfaces "we ran a drill on date X, it passed/failed"
-- as compliance evidence (SOC 2 evidence-of-tested-backups).
--
-- Phase A populates this table from two write paths:
--   1. Operator runs scripts/restore-drill.sh manually. The script
--      gets a `--log-to-db` flag (added later) that posts the
--      output back to /api/admin/backups/drill-log.
--   2. Phase B (next session) wires a "Run drill" button in the
--      admin UI that spawns the script server-side and writes the
--      result here directly.
--
-- This table is platform-admin-only — no tenant_id, no
-- tenant_isolation policy. Mirrors the tenant_notes shape from
-- migration 029: ENABLE ROW LEVEL SECURITY + platform_admin_bypass
-- only. Any code path that somehow runs under withTenantContext
-- (no one does today) returns zero rows by default-deny.
--
-- Schema:
--   id              UUID PK
--   started_at      when the drill kicked off
--   finished_at     when it completed (NULL if still running / aborted)
--   exit_code       SMALLINT — 0 = pass, 1 = fail, 64 = usage error
--   base_used       which base backup the drill restored from (filename)
--   target_time     PITR target if --target-time was passed (NULL otherwise)
--   from_s3         did the drill stage from S3 first (cold-restore dry-run)
--   schema_check_ok did `\d platform.tenants` find the table?
--   smoke_query_rows tenant count from the restored DB (NULL on fail)
--   tarball_sha256  SHA-256 of the base backup tarball (provenance evidence)
--   output          verbatim stdout+stderr of the drill (TEXT — capped at 1MB
--                   in application code so a runaway drill doesn't bloat the row)
--   triggered_by    'cron' | 'operator' | 'admin_ui' — provenance of who started it
--   user_id         FK to platform.users when triggered_by='admin_ui',
--                   NULL otherwise (cron / SSH operator have no session)
--
-- Idempotent.

BEGIN;

CREATE TABLE IF NOT EXISTS platform.backup_drill_runs (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at      TIMESTAMPTZ,
  exit_code        SMALLINT,
  base_used        TEXT,
  target_time      TIMESTAMPTZ,
  from_s3          BOOLEAN NOT NULL DEFAULT false,
  schema_check_ok  BOOLEAN,
  smoke_query_rows INTEGER,
  tarball_sha256   TEXT,
  output           TEXT,
  triggered_by     TEXT NOT NULL DEFAULT 'operator'
                     CHECK (triggered_by IN ('cron','operator','admin_ui')),
  user_id          UUID REFERENCES platform.users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_backup_drill_runs_started_at
  ON platform.backup_drill_runs (started_at DESC);

ALTER TABLE platform.backup_drill_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.backup_drill_runs FORCE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY platform_admin_bypass ON platform.backup_drill_runs
    USING      (platform.is_platform_admin())
    WITH CHECK (platform.is_platform_admin());
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

COMMIT;
