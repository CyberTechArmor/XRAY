-- Migration 051: GRANT CREATE on the database to xray_app.
--
-- The runtime role (xray_app, post-step-12 role split) needs to be
-- able to create per-tenant warehouse schemas (`tn_<uuid>`) during
-- tenant signup / admin tenant create. Those code paths still live
-- in services/{tenant,admin,auth}.service.ts and run at request
-- time; without CREATE on the database, every new-tenant flow 500s
-- with "permission denied for database xray".
--
-- Scope of this grant:
--   - Lets xray_app CREATE SCHEMA in this database.
--   - Does NOT let it touch tables in OTHER schemas (those are
--     gated by per-table ownership / RLS; CREATE on database is
--     orthogonal).
--   - xray_app becomes OWNER of any schema it creates, so the
--     tenant-warehouse cleanup path (DROP SCHEMA …) keeps working.
--
-- Defense-in-depth: xray_app already has full DML on platform.*
-- via the bootstrap setup, so creating new schemas adds negligible
-- blast radius. The alternative (adding a separate "schema-admin"
-- pool with bootstrap creds) is materially more complex.
--
-- Idempotent: GRANT is a no-op if already granted. Skipped if
-- xray_app role doesn't exist yet (installs that haven't picked
-- up the role-split path).

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'xray_app') THEN
    EXECUTE format('GRANT CREATE ON DATABASE %I TO xray_app', current_database());
  END IF;
END $$;
