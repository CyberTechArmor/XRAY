-- housecall_pro_schema_version: 2026-04-30-1
--
-- Platform-shipped per-integration stub. Provisions the schema +
-- pipeline_user grants only — NO table DDL, NO RLS policies, NO
-- indexes. The actual data shape (housecall_pro.jobs etc.) is
-- operator-held and applied separately against the pipeline DB.
--
-- The ALTER DEFAULT PRIVILEGES lines mean any tables the
-- operator's expand SQL creates later automatically inherit
-- pipeline_user permissions — no need to re-grant per table.
--
-- Bump the version header on every change. Same convention as
-- globals.sql:
--
--   YYYY-MM-DD-N where N starts at 1 each day and increments per
--   change in that day. e.g. "2026-04-30-1", "2026-04-30-2".

BEGIN;

CREATE SCHEMA IF NOT EXISTS housecall_pro;

GRANT USAGE ON SCHEMA housecall_pro TO pipeline_user;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON ALL TABLES IN SCHEMA housecall_pro TO pipeline_user;
GRANT USAGE, SELECT, UPDATE
  ON ALL SEQUENCES IN SCHEMA housecall_pro TO pipeline_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA housecall_pro
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO pipeline_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA housecall_pro
  GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO pipeline_user;

COMMIT;
