-- Migration 017 — down. Drops the guardrail triggers and their functions.
-- Existing rows stay encrypted; the reverse of "require encrypted writes"
-- is not "rewrite rows as plaintext". To get plaintext back you would
-- decrypt in application code before dropping.
--
-- Lives under migrations/down/ so deploy.sh/update.sh/install.sh —
-- which glob migrations/*.sql non-recursively — do not execute it as
-- part of every deploy.

DROP TRIGGER IF EXISTS enforce_enc_webhooks_secret ON platform.webhooks;
DROP TRIGGER IF EXISTS enforce_enc_connections_details ON platform.connections;
DROP TRIGGER IF EXISTS enforce_enc_dashboards_fetch_headers ON platform.dashboards;

DROP FUNCTION IF EXISTS platform.require_enc_webhooks_secret();
DROP FUNCTION IF EXISTS platform.require_enc_connections_details();
DROP FUNCTION IF EXISTS platform.require_enc_dashboards_fetch_headers();

-- Historical function names from the initial v1 of this migration (EXECUTE
-- format() pattern). Dropped defensively in case an older up ran first.
DROP FUNCTION IF EXISTS platform.require_encrypted_text();
DROP FUNCTION IF EXISTS platform.require_encrypted_jsonb();
