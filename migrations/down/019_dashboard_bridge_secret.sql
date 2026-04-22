-- Migration 019 — down. Drops the trigger, function, and column.
-- Any stored secret is destroyed on column drop — the reverse of this
-- migration is not data-preserving. Operators rotating away from the
-- bridge should clear individual rows via the admin UI first.
--
-- Lives under migrations/down/ so deploy.sh/update.sh/install.sh —
-- which glob migrations/*.sql non-recursively — do not execute it as
-- part of every deploy.

DROP TRIGGER IF EXISTS enforce_enc_dashboards_bridge_secret ON platform.dashboards;
DROP FUNCTION IF EXISTS platform.require_enc_dashboards_bridge_secret();
ALTER TABLE platform.dashboards DROP COLUMN IF EXISTS bridge_secret;
