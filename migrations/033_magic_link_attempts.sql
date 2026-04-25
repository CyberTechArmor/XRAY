-- Migration 033: per-link attempt cap on magic_links.
--
-- platform.magic_links already carries `attempts INT NOT NULL
-- DEFAULT 0` (init.sql:110) — the bump-on-mismatch counter has been
-- in the schema since the original platform DB. What was missing:
-- the cap value itself, so the auth-service consume path could
-- enforce a per-link lockout. This migration adds:
--
--   • max_attempts INT NOT NULL DEFAULT 5
--
-- The 5-attempt-per-link limit is independent of the per-day
-- per-user limit landed in migration 035 — both apply. Per-link
-- locks the specific code immediately on the 5th wrong guess;
-- per-day locks the email regardless of how many fresh codes
-- have been requested in the last 24h.
--
-- Existing rows are populated by the DEFAULT. No data migration
-- required.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS.

BEGIN;

ALTER TABLE platform.magic_links
  ADD COLUMN IF NOT EXISTS max_attempts INT NOT NULL DEFAULT 5;

COMMIT;
