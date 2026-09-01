-- 056 — turn the backup + WAL prune schedules on by default.
--
-- WHY
-- ---
-- Every backup schedule shipped disabled, waiting for an operator to
-- opt in. On an install where nobody did, the consequences compound
-- quietly:
--
--   * no base backup is ever taken, so there is no recovery point;
--   * the WAL prune only ran as the tail of a base backup, so nothing
--     ever reclaimed archived WAL either;
--   * WAL archiving runs from first boot regardless.
--
-- The result is a backup volume that grows every day, holds no
-- restorable backup, and reports no error — because nothing failed.
-- Nothing ran.
--
-- Safe defaults are the fix. A backup that runs unasked is a far
-- smaller problem than a recovery point that never existed.
--
-- WHAT THIS DOES NOT DO
-- ---------------------
-- ON CONFLICT DO NOTHING: an operator who has already made a choice
-- keeps it. A row that is present and set to 'false' was set that way
-- deliberately and is left alone. Only installs that never touched
-- these settings are changed.
--
-- Two schedules, deliberately separate:
--
--   base  (02:00 UTC daily) — creates the recovery point. Prunes WAL
--                             on its way out.
--   prune (03:30 UTC daily) — prunes WAL independently. This exists
--                             so reclaiming disk does not depend on
--                             base backups succeeding. If base backups
--                             start failing, the archive still gets
--                             trimmed against the newest base that DID
--                             succeed, instead of growing unbounded
--                             until someone notices.
--
-- scripts/prune-wal.sh anchors on the oldest retained base backup's
-- START WAL LOCATION and refuses to delete anything when no base
-- backup exists, so a scheduled prune is safe in every state.
--
-- Idempotent.

BEGIN;

INSERT INTO platform.platform_settings (key, value) VALUES
  ('backup_schedule_base',           '0 2 * * *'),
  ('backup_schedule_base_enabled',   'true'),
  ('backup_schedule_prune',          '30 3 * * *'),
  ('backup_schedule_prune_enabled',  'true')
ON CONFLICT (key) DO NOTHING;

COMMIT;
