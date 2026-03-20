-- Migration: Add connection fields to dashboards for n8n HTTP fetch
-- Run against a live database that already has init.sql applied

ALTER TABLE platform.dashboards
    ADD COLUMN IF NOT EXISTS fetch_url     TEXT,
    ADD COLUMN IF NOT EXISTS fetch_method  TEXT DEFAULT 'GET',
    ADD COLUMN IF NOT EXISTS fetch_headers JSONB DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS fetch_body    JSONB;

-- Add check constraint for fetch_method (only if not already present)
DO $$ BEGIN
  ALTER TABLE platform.dashboards ADD CONSTRAINT chk_fetch_method
    CHECK (fetch_method IN ('GET', 'POST', 'PUT', 'PATCH', 'DELETE'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Change default status to 'draft' for new dashboards
ALTER TABLE platform.dashboards ALTER COLUMN status SET DEFAULT 'draft';

-- Connection templates for reusable HTTP request patterns
CREATE TABLE IF NOT EXISTS platform.connection_templates (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            TEXT NOT NULL,
    description     TEXT,
    fetch_method    TEXT DEFAULT 'GET',
    fetch_url       TEXT,
    fetch_headers   JSONB DEFAULT '{}',
    fetch_body      JSONB,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
