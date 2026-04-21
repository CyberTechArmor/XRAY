-- Migration 017 — down. Drops the guardrail triggers and their functions.
-- Existing rows stay encrypted; the reverse of "require encrypted writes"
-- is not "rewrite rows as plaintext". To get plaintext back you would
-- decrypt in application code before dropping.

DROP TRIGGER IF EXISTS enforce_enc_webhooks_secret ON platform.webhooks;
DROP TRIGGER IF EXISTS enforce_enc_connections_details ON platform.connections;
DROP TRIGGER IF EXISTS enforce_enc_dashboards_fetch_headers ON platform.dashboards;

DROP FUNCTION IF EXISTS platform.require_encrypted_text();
DROP FUNCTION IF EXISTS platform.require_encrypted_jsonb();
