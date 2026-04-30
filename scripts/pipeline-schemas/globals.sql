-- globals_schema_version: 2026-04-30-1
--
-- Pipeline DB — cross-integration / dashboard-template tables.
-- Lives separately from any specific integration so it can stay
-- stable while per-integration schemas churn. When/if these tables
-- eventually promote to xray.platform.*, the path is a one-time
-- INSERT-SELECT — they're already RLS-shaped to match the platform
-- DB convention.
--
-- Idempotent. Safe to re-run on every deploy.
--
-- The line above (`-- globals_schema_version: …`) is parsed by the
-- platform's GET /api/admin/pipeline/globals-sql endpoint to surface
-- the current canonical version in Admin → Pipeline. Bump the
-- version string whenever you alter the file:
--
--   YYYY-MM-DD-N where N starts at 1 each day and increments per
--   change in that day. e.g. "2026-04-28-1", "2026-04-28-2".
--
-- The "applied version" per pipeline DB is recorded in
-- platform.platform_settings under key 'globals_schema_version_applied'
-- once the operator has run this against their pipeline DB and
-- clicked "Mark as applied" in the admin UI.

BEGIN;

-- Schema + role grants. Owned by this file (not the bootstrap) so
-- globals.sql can be applied on top of a bare bootstrapped DB
-- without depending on the bootstrap pre-creating anything
-- schema-specific.
CREATE SCHEMA IF NOT EXISTS globals;

GRANT USAGE ON SCHEMA globals TO pipeline_user;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON ALL TABLES IN SCHEMA globals TO pipeline_user;
GRANT USAGE, SELECT, UPDATE
  ON ALL SEQUENCES IN SCHEMA globals TO pipeline_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA globals
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO pipeline_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA globals
  GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO pipeline_user;

-- revenue_goals — per-month revenue target. Source: customer's
-- existing abch.revenue_goals table. 0-indexed month CHECK
-- preserved verbatim so existing dashboard queries don't have
-- to remap (Jan=0, Dec=11).
CREATE TABLE IF NOT EXISTS globals.revenue_goals (
  goal_id         TEXT NOT NULL,
  tenant_id       UUID NOT NULL,
  year            SMALLINT NOT NULL,
  month           SMALLINT NOT NULL CHECK (month >= 0 AND month <= 11),
  month_name      TEXT NOT NULL,
  revenue_target  INTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, goal_id),
  CONSTRAINT revenue_goals_tenant_year_month_unique
    UNIQUE (tenant_id, year, month)
);

CREATE INDEX IF NOT EXISTS idx_revenue_goals_tenant_year
  ON globals.revenue_goals (tenant_id, year);
CREATE INDEX IF NOT EXISTS idx_revenue_goals_tenant_year_month
  ON globals.revenue_goals (tenant_id, year, month);

ALTER TABLE globals.revenue_goals ENABLE ROW LEVEL SECURITY;
ALTER TABLE globals.revenue_goals FORCE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY tenant_isolation ON globals.revenue_goals
    USING      (tenant_id = public.current_tenant_id())
    WITH CHECK (tenant_id = public.current_tenant_id());
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

COMMIT;
