-- Migration 018: per-dashboard config for the n8n JWT bridge.
--
-- Adds three columns that XRay passes to n8n inside the short-lived HS256
-- JWT minted on every render call (server/src/lib/n8n-bridge.ts):
--   template_id  — opaque string telling n8n which template to run.
--   integration  — opaque string (e.g. 'housecall_pro', 'qbo') used both to
--                  route inside the n8n workflow and to gate the JWT path in
--                  XRay: a row with integration IS NULL stays on the legacy
--                  fetch_headers path; non-null flips it onto the JWT path.
--   params       — JSONB bag of per-tenant params. Defaults to '{}' so every
--                  existing row gets a sane value without a rewrite pass.
--
-- None of the three are credentials — they're routing data — so no encryption
-- or guardrail trigger is required (contrast with migration 017).
--
-- Idempotent via ADD COLUMN IF NOT EXISTS. Down migration lives in
-- migrations/down/ so deploy.sh's non-recursive glob does not execute it.

BEGIN;

ALTER TABLE platform.dashboards
  ADD COLUMN IF NOT EXISTS template_id TEXT,
  ADD COLUMN IF NOT EXISTS integration TEXT,
  ADD COLUMN IF NOT EXISTS params JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMIT;
