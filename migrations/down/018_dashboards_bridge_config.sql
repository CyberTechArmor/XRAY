-- Migration 018 — down. Drops the three bridge-config columns.
-- Data in these columns is lost on drop; there is no encrypted-at-rest
-- concern (they're routing data, not credentials), so this is just a
-- straight DDL reversal.
--
-- Lives under migrations/down/ so deploy.sh/update.sh/install.sh — which
-- glob migrations/*.sql non-recursively — do not execute it on every deploy.

ALTER TABLE platform.dashboards DROP COLUMN IF EXISTS params;
ALTER TABLE platform.dashboards DROP COLUMN IF EXISTS integration;
ALTER TABLE platform.dashboards DROP COLUMN IF EXISTS template_id;
