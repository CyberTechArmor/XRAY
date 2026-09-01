-- 055 — allow the 'prune_wal' backup job kind.
--
-- WHY
-- ---
-- WAL archiving (scripts/wal-archive.sh) is append-only: Postgres
-- hands it every completed segment and it copies that segment into
-- the archive. The only code that ever deleted archived WAL was the
-- prune step at the tail of scripts/backup-platform.sh, so an install
-- that never ran a base backup — the shipped default, since every
-- schedule in Admin -> Backups starts disabled — accumulated every
-- 16 MB segment it had ever written, without bound, for the life of
-- the deployment.
--
-- scripts/prune-wal.sh decouples the prune from the base backup. This
-- migration widens the backup_jobs kind CHECK so the Backups admin UI
-- can enqueue it through the same queue as every other operation,
-- rather than requiring the operator to SSH in.
--
-- Idempotent: safe to re-run. Matches the DROP-then-ADD shape used by
-- migration 047 when it folded in 'delete_base'.

DO $$ BEGIN
  ALTER TABLE platform.backup_jobs
    DROP CONSTRAINT IF EXISTS backup_jobs_kind_check;
  ALTER TABLE platform.backup_jobs
    ADD CONSTRAINT backup_jobs_kind_check
    CHECK (kind IN ('base','s3sync','drill','delete_base','prune_wal'));
END $$;
