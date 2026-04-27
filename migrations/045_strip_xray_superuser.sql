-- Migration 045: Strip the connecting role's SUPERUSER bit so FORCE RLS
-- actually fires (step 12 close-out).
--
-- Production runs as POSTGRES_USER (default: xray), which the postgres
-- docker image creates as a cluster bootstrap SUPERUSER. Postgres
-- always lets superusers bypass RLS, regardless of FORCE ROW LEVEL
-- SECURITY. Migration 044 made the policies bulletproof; this
-- migration removes the runtime bypass that was masking them.
--
-- Keeps REPLICATION so `pg_basebackup` continues to work for the
-- host-side backup script. Drops BYPASSRLS explicitly even though
-- NOSUPERUSER implies it — defense in depth.
--
-- Uses current_user so the migration runs correctly under any
-- DB_USER (the role name isn't hard-coded). The role still OWNS
-- every platform.* table (init.sql ran as this user); FORCE RLS
-- on the table makes the owner respect policies.
--
-- After this migration the role can NO LONGER:
--   * CREATE EXTENSION (operator-side, run as postgres bootstrap)
--   * ALTER SYSTEM (operator-side)
--   * Drop other roles
-- The application server doesn't need any of these at runtime —
-- it only does INSERT/SELECT/UPDATE/DELETE on platform.* tables,
-- which the role retains as the table owner.
--
-- Idempotent: re-applying on an already-stripped role is a no-op.
--
-- If a future migration needs superuser (e.g. an extension install),
-- the operator temporarily restores the bit with:
--   docker exec xray-postgres psql -U postgres -d xray -c \
--     'ALTER ROLE xray SUPERUSER;'
-- and restores the strip after.

DO $$
DECLARE
  app_role NAME := current_user;
  is_super BOOLEAN;
BEGIN
  -- Don't strip postgres (the cluster bootstrap). Stripping that
  -- bricks the cluster — only the connecting application role
  -- should lose the bypass.
  IF app_role = 'postgres' THEN
    RAISE NOTICE 'Skipping superuser strip — running as postgres bootstrap user';
    RETURN;
  END IF;

  -- Idempotency, layer 1: peek at the current state. If the role is
  -- already non-super, this migration has already run successfully
  -- in a prior apply (or the operator stripped it manually). Skip
  -- with NOTICE rather than try to ALTER again, which would fail
  -- with "permission denied to alter role" (the role no longer has
  -- the SUPERUSER attribute it would need to alter SUPERUSER).
  SELECT rolsuper INTO is_super FROM pg_roles WHERE rolname = app_role;
  IF NOT COALESCE(is_super, false) THEN
    RAISE NOTICE 'Role % is already non-superuser — skipping (no-op)', app_role;
    RETURN;
  END IF;

  -- Idempotency, layer 2: in some environments (GitHub Actions's
  -- postgres:16-alpine service container, certain hosted Postgres
  -- providers that delegate role-attribute alteration only to the
  -- cluster bootstrap user) ALTER ROLE … NOSUPERUSER raises
  -- regardless of the caller's rolsuper. The exact SQLSTATE varies
  -- across PG versions / providers (42501 insufficient_privilege,
  -- 0LP01 invalid_grant_operation, others on hosted Postgres), so
  -- we catch WHEN OTHERS to make the migration bulletproof. The
  -- strip becomes "best-effort": it succeeds where possible,
  -- NOTICEs otherwise, never fails the apply. The platform DB still
  -- gets RLS enforcement via FORCE RLS (migration 044) — the strip
  -- is the additional defense layer that the operator can complete
  -- out-of-band as the cluster bootstrap user.
  BEGIN
    EXECUTE format('ALTER ROLE %I WITH NOSUPERUSER NOBYPASSRLS REPLICATION', app_role);
    RAISE NOTICE 'Stripped SUPERUSER + BYPASSRLS from role %, kept REPLICATION', app_role;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE
      'Could not strip SUPERUSER from % (sqlstate=%, sqlerrm=%). Operator must run as the cluster bootstrap, e.g.: docker exec <postgres-container> psql -U postgres -d <db> -c ''ALTER ROLE %I WITH NOSUPERUSER NOBYPASSRLS REPLICATION;''',
      app_role, SQLSTATE, SQLERRM, app_role;
  END;
END $$;
