-- housecall_pro_schema_version: 2026-04-30-2
--
-- HouseCall Pro per-integration pipeline schema. Operator-applied
-- to the pipeline DB after the bootstrap (which creates the
-- housecall_pro schema, pipeline_user role, and current_tenant_id()
-- helper) and globals.sql. Idempotent — safe to re-run on bumps.
--
-- Shape: one row per (tenant × job × employee). Per-job columns
-- (line_items, tags, csr_update, totals) are duplicated across
-- rows for multi-tech jobs so the dashboard can read everything
-- in a single SELECT and let JS do the rollups.
--
-- Bump the version header on every change. Same convention as
-- globals.sql:
--
--   YYYY-MM-DD-N where N starts at 1 each day and increments per
--   change in that day. e.g. "2026-04-30-1", "2026-04-30-2".

BEGIN;

-- Schema + role grants. Owned by this file (not the bootstrap) so
-- adding a new integration is a drop-in operation: a fresh n8n
-- workflow + this file, no re-bootstrap.
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

CREATE TABLE IF NOT EXISTS housecall_pro.jobs (
  id                          SERIAL PRIMARY KEY,
  tenant_id                   UUID NOT NULL,

  job_id                      TEXT NOT NULL,
  invoice_number              TEXT,
  description                 TEXT,
  work_status                 TEXT,
  customer_id                 TEXT,
  customer_name               TEXT,
  customer_email              TEXT,
  customer_company            TEXT,
  address_street              TEXT,
  address_city                TEXT,
  address_state               TEXT,
  address_zip                 TEXT,
  scheduled_start             TIMESTAMPTZ,
  scheduled_end               TIMESTAMPTZ,
  on_my_way_at                TIMESTAMPTZ,
  started_at                  TIMESTAMPTZ,
  completed_at                TIMESTAMPTZ,
  hours_worked                NUMERIC(6,2),
  job_total_amount            NUMERIC(10,2) DEFAULT 0,
  job_outstanding_balance     NUMERIC(10,2) DEFAULT 0,
  employee_id                 TEXT NOT NULL,
  employee_first_name         TEXT,
  employee_last_name          TEXT,
  employee_name               TEXT,
  employee_email              TEXT,
  employee_role               TEXT,
  created_at                  TIMESTAMPTZ,
  updated_at                  TIMESTAMPTZ,
  job_tags                    TEXT,
  customer_tags               TEXT,
  employee_tags               TEXT,
  technician_count            INTEGER DEFAULT 0,
  employee_attributed_revenue INTEGER,
  csr_update                  TEXT,
  line_items                  JSONB,

  CONSTRAINT jobs_tenant_job_employee_unique
    UNIQUE (tenant_id, job_id, employee_id)
);

CREATE INDEX IF NOT EXISTS idx_jobs_tenant_completed_at
  ON housecall_pro.jobs (tenant_id, completed_at);
CREATE INDEX IF NOT EXISTS idx_jobs_tenant_work_status
  ON housecall_pro.jobs (tenant_id, work_status);
CREATE INDEX IF NOT EXISTS idx_jobs_tenant_customer_id
  ON housecall_pro.jobs (tenant_id, customer_id);
CREATE INDEX IF NOT EXISTS idx_jobs_tenant_employee_id
  ON housecall_pro.jobs (tenant_id, employee_id);

ALTER TABLE housecall_pro.jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE housecall_pro.jobs FORCE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY tenant_isolation ON housecall_pro.jobs
    USING      (tenant_id = public.current_tenant_id())
    WITH CHECK (tenant_id = public.current_tenant_id());
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

COMMIT;
