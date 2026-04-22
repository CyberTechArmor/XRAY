-- Migration 022: per-tenant OAuth / API-key state on platform.connections.
--
-- Every time a tenant connects their account to an integration (OAuth
-- consent or API-key paste), the resulting credentials land on this row.
-- One row per (tenant, integration) — enforced by the partial unique
-- index below. The existing non-OAuth shape of platform.connections
-- (source_type + connection_details + manual data-source rows for the
-- hardcoded pre-step-4 client) continues to work; these columns are all
-- nullable and default off.
--
-- Auth method branches the row's state:
--   auth_method='oauth'   — oauth_refresh_token / oauth_access_token /
--                            oauth_access_token_expires_at populated;
--                            scheduler keeps access_token fresh.
--   auth_method='api_key' — api_key populated; scheduler ignores the row.
--
-- FK to platform.integrations uses ON DELETE RESTRICT so admins can't
-- accidentally orphan tenant connections by deleting an integration; the
-- admin UI exposes a Disable option (status='disabled') as the safe path.
--
-- All three credential columns (`oauth_refresh_token`, `oauth_access_token`,
-- `api_key`) are guarded by enc:v1: triggers matching migrations 017/019/021.
--
-- Purely additive, pre-rebuild stage. Idempotent.

BEGIN;

-- Integration linkage. NULL means "non-OAuth legacy connection" — the row
-- predates step 4 and carries data via the older source_type / source_detail
-- / connection_details columns. New tenant connections set this.
ALTER TABLE platform.connections
  ADD COLUMN IF NOT EXISTS integration_id UUID
    REFERENCES platform.integrations(id) ON DELETE RESTRICT;

-- Auth method. Default 'oauth' so a row inserted with integration_id set
-- but no explicit auth_method lands in the common case. Legacy rows with
-- integration_id=NULL carry auth_method but it has no effect on them.
ALTER TABLE platform.connections
  ADD COLUMN IF NOT EXISTS auth_method TEXT NOT NULL DEFAULT 'oauth'
    CHECK (auth_method IN ('oauth', 'api_key'));

-- OAuth state. Refresh token is the long-lived grant; access token is
-- rotated by the scheduler. expires_at tracks when the access token stops
-- being valid.
ALTER TABLE platform.connections
  ADD COLUMN IF NOT EXISTS oauth_refresh_token TEXT;
ALTER TABLE platform.connections
  ADD COLUMN IF NOT EXISTS oauth_access_token TEXT;
ALTER TABLE platform.connections
  ADD COLUMN IF NOT EXISTS oauth_access_token_expires_at TIMESTAMPTZ;
ALTER TABLE platform.connections
  ADD COLUMN IF NOT EXISTS oauth_last_refreshed_at TIMESTAMPTZ;

-- Refresh-failure accounting. Scheduler increments on each exhausted
-- retry cycle; at >= 5 the row flips to status='error' and the tenant
-- sees a 'Needs reconnect' pill.
ALTER TABLE platform.connections
  ADD COLUMN IF NOT EXISTS oauth_refresh_failed_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE platform.connections
  ADD COLUMN IF NOT EXISTS oauth_last_error TEXT;

-- API-key state. When auth_method='api_key', this is the tenant-supplied
-- secret (encrypted). api_key_header_name on the integration row tells
-- downstream workflows how to present it.
ALTER TABLE platform.connections
  ADD COLUMN IF NOT EXISTS api_key TEXT;

-- One row per (tenant, integration). Applies only when integration_id is
-- set — legacy non-OAuth rows with integration_id=NULL are free to
-- duplicate.
CREATE UNIQUE INDEX IF NOT EXISTS connections_tenant_integration_unique
  ON platform.connections (tenant_id, integration_id)
  WHERE integration_id IS NOT NULL;

-- enc:v1: trigger — covers three encrypted columns on platform.connections
-- that step 4 introduces. One trigger, three column guards, because
-- triggers are scoped to a table and the column-OF clause on UPDATE means
-- we only re-validate on the specific column write.
DROP TRIGGER IF EXISTS enforce_enc_connections_oauth_refresh_token ON platform.connections;
DROP TRIGGER IF EXISTS enforce_enc_connections_oauth_access_token  ON platform.connections;
DROP TRIGGER IF EXISTS enforce_enc_connections_api_key             ON platform.connections;
DROP FUNCTION IF EXISTS platform.require_enc_connections_oauth_tokens();

CREATE OR REPLACE FUNCTION platform.require_enc_connections_oauth_tokens() RETURNS trigger AS $$
BEGIN
  IF NEW.oauth_refresh_token IS NOT NULL AND NEW.oauth_refresh_token <> ''
     AND position('enc:v1:' in NEW.oauth_refresh_token) <> 1 THEN
    RAISE EXCEPTION 'platform.connections.oauth_refresh_token must be encrypted (enc:v1: prefix)';
  END IF;
  IF NEW.oauth_access_token IS NOT NULL AND NEW.oauth_access_token <> ''
     AND position('enc:v1:' in NEW.oauth_access_token) <> 1 THEN
    RAISE EXCEPTION 'platform.connections.oauth_access_token must be encrypted (enc:v1: prefix)';
  END IF;
  IF NEW.api_key IS NOT NULL AND NEW.api_key <> ''
     AND position('enc:v1:' in NEW.api_key) <> 1 THEN
    RAISE EXCEPTION 'platform.connections.api_key must be encrypted (enc:v1: prefix)';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER enforce_enc_connections_oauth_refresh_token
  BEFORE INSERT OR UPDATE OF oauth_refresh_token ON platform.connections
  FOR EACH ROW EXECUTE FUNCTION platform.require_enc_connections_oauth_tokens();

CREATE TRIGGER enforce_enc_connections_oauth_access_token
  BEFORE INSERT OR UPDATE OF oauth_access_token ON platform.connections
  FOR EACH ROW EXECUTE FUNCTION platform.require_enc_connections_oauth_tokens();

CREATE TRIGGER enforce_enc_connections_api_key
  BEFORE INSERT OR UPDATE OF api_key ON platform.connections
  FOR EACH ROW EXECUTE FUNCTION platform.require_enc_connections_oauth_tokens();

-- Helper index: scheduler query picks up connections whose access token
-- is near expiry. Partial on auth_method='oauth' to keep index small.
CREATE INDEX IF NOT EXISTS idx_connections_oauth_expiry
  ON platform.connections (oauth_access_token_expires_at)
  WHERE auth_method = 'oauth' AND integration_id IS NOT NULL;

COMMIT;
