-- Down migration for 022. Drops triggers, function, indexes, columns.
-- Run BEFORE 021/down if both are being rolled back (this one references
-- platform.integrations via FK).

BEGIN;

DROP TRIGGER IF EXISTS enforce_enc_connections_oauth_refresh_token ON platform.connections;
DROP TRIGGER IF EXISTS enforce_enc_connections_oauth_access_token  ON platform.connections;
DROP TRIGGER IF EXISTS enforce_enc_connections_api_key             ON platform.connections;
DROP FUNCTION IF EXISTS platform.require_enc_connections_oauth_tokens();

DROP INDEX IF EXISTS platform.idx_connections_oauth_expiry;
DROP INDEX IF EXISTS platform.connections_tenant_integration_unique;

ALTER TABLE platform.connections DROP COLUMN IF EXISTS api_key;
ALTER TABLE platform.connections DROP COLUMN IF EXISTS oauth_last_error;
ALTER TABLE platform.connections DROP COLUMN IF EXISTS oauth_refresh_failed_count;
ALTER TABLE platform.connections DROP COLUMN IF EXISTS oauth_last_refreshed_at;
ALTER TABLE platform.connections DROP COLUMN IF EXISTS oauth_access_token_expires_at;
ALTER TABLE platform.connections DROP COLUMN IF EXISTS oauth_access_token;
ALTER TABLE platform.connections DROP COLUMN IF EXISTS oauth_refresh_token;
ALTER TABLE platform.connections DROP COLUMN IF EXISTS auth_method;
ALTER TABLE platform.connections DROP COLUMN IF EXISTS integration_id;

COMMIT;
