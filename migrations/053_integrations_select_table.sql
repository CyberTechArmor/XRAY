-- Migration 053: integrations.select_table
--
-- Per-integration configuration of which table the dashboard render
-- query reads from. The platform-shipped select.sql template
-- references this as a `{{table}}` placeholder; the admin UI
-- substitutes it client-side at copy time using the value stored
-- in this column.
--
-- Column is operator-managed and free-form (whatever table name
-- the operator's expand SQL created inside the integration's
-- schema). Empty string is treated as unset (validated app-side).
-- Pure additive. Idempotent.

BEGIN;

ALTER TABLE platform.integrations
  ADD COLUMN IF NOT EXISTS select_table TEXT;

COMMIT;
