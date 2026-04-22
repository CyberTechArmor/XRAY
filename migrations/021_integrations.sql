-- Migration 021: platform.integrations — platform-admin-managed catalog of
-- external systems XRay can connect tenant dashboards to (HouseCall Pro,
-- QuickBooks, etc.). One row per integration; admin fills it in through the
-- Integrations tab under Manage.
--
-- An integration can advertise one or both auth methods — `supports_oauth`
-- and `supports_api_key`. The CHECK guarantees at least one is enabled.
-- Rationale: HCP offers both (admin enables API Key today, flips on OAuth
-- when their dev-account approval lands); QBO only offers OAuth.
--
-- Every secret column (`client_secret`) is stored under the `enc:v1:`
-- envelope and guarded by an enforcement trigger, matching the pattern
-- established by migrations 017/019.
--
-- Table is empty at ship. Admin creates rows through the UI when
-- integrations become available. A row with `status='pending'` is visible
-- to the admin but hidden from tenants and the scheduler — lets admins
-- pre-create rows while awaiting provider approvals.
--
-- Purely additive, pre-rebuild stage. Idempotent (`IF NOT EXISTS` + trigger
-- DROP-then-CREATE).

BEGIN;

CREATE TABLE IF NOT EXISTS platform.integrations (
    id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    slug                      TEXT NOT NULL UNIQUE,
    display_name              TEXT NOT NULL,
    icon_url                  TEXT,
    status                    TEXT NOT NULL DEFAULT 'pending'
                              CHECK (status IN ('active', 'disabled', 'pending')),

    -- Auth-method advertisement. At least one must be enabled.
    supports_oauth            BOOLEAN NOT NULL DEFAULT false,
    supports_api_key          BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT integrations_auth_method_required
      CHECK (supports_oauth OR supports_api_key),

    -- OAuth 2.0 authorization-code-grant config. Required when
    -- supports_oauth=true; nullable otherwise. Application-layer enforces
    -- the "required when enabled" contract (DB CHECKs on cross-column
    -- requirements get messy fast).
    auth_url                  TEXT,
    token_url                 TEXT,
    client_id                 TEXT,
    client_secret             TEXT,
    scopes                    TEXT,
    -- Provider-specific extras merged into the authorize URL querystring.
    -- Example: {"access_type": "offline", "prompt": "consent"} for Google.
    -- Keeps the common case generic while unlocking provider quirks
    -- without a code change.
    extra_authorize_params    JSONB NOT NULL DEFAULT '{}'::jsonb,

    -- API-key config. Required when supports_api_key=true.
    -- api_key_header_name defaults to 'Authorization'; the stored value is
    -- prefixed with the scheme (e.g. "Bearer <key>", "Token <key>") by
    -- whatever workflow consumes it. Providers vary wildly here — this is
    -- a hint for the tenant UI / downstream fetch.
    api_key_header_name       TEXT,
    api_key_instructions      TEXT,

    created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_integrations_status
    ON platform.integrations(status) WHERE status = 'active';

-- Reject plaintext writes to client_secret. Same contract as migration 017.
DROP TRIGGER IF EXISTS enforce_enc_integrations_client_secret ON platform.integrations;
DROP FUNCTION IF EXISTS platform.require_enc_integrations_client_secret();

CREATE OR REPLACE FUNCTION platform.require_enc_integrations_client_secret() RETURNS trigger AS $$
BEGIN
  IF NEW.client_secret IS NOT NULL AND NEW.client_secret <> ''
     AND position('enc:v1:' in NEW.client_secret) <> 1 THEN
    RAISE EXCEPTION 'platform.integrations.client_secret must be encrypted (enc:v1: prefix)';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER enforce_enc_integrations_client_secret
  BEFORE INSERT OR UPDATE OF client_secret ON platform.integrations
  FOR EACH ROW EXECUTE FUNCTION platform.require_enc_integrations_client_secret();

COMMIT;
