-- Migration 019: per-dashboard signing secret for the n8n JWT bridge.
--
-- XRay used to carry one platform-wide `N8N_BRIDGE_JWT_SECRET` env var
-- that signed every dashboard's bridge JWT. That design made a single
-- leak compromise every integration on every tenant. This migration
-- replaces it with a per-row secret on `platform.dashboards.bridge_secret`,
-- stored under the same `enc:v1:` envelope used for the other credential
-- columns (migration 017). Each n8n workflow holds its dashboard's
-- secret as its own "JWT Auth" credential; compromising one dashboard's
-- workflow does not give an attacker the signing key for any other.
--
-- The admin UI sets this value at dashboard-create time. See
-- server/src/services/admin.service.ts and the builder view for the
-- generate / paste flow.
--
-- Idempotent. Trigger + function use the same CREATE OR REPLACE /
-- DROP-THEN-CREATE pattern as migration 017.

BEGIN;

ALTER TABLE platform.dashboards
  ADD COLUMN IF NOT EXISTS bridge_secret TEXT;

-- Reject any write whose value is neither null/empty nor prefixed with
-- `enc:v1:`. Same contract as the three columns guarded by migration 017.
DROP TRIGGER IF EXISTS enforce_enc_dashboards_bridge_secret ON platform.dashboards;
DROP FUNCTION IF EXISTS platform.require_enc_dashboards_bridge_secret();

CREATE OR REPLACE FUNCTION platform.require_enc_dashboards_bridge_secret() RETURNS trigger AS $$
BEGIN
  IF NEW.bridge_secret IS NOT NULL AND NEW.bridge_secret <> ''
     AND position('enc:v1:' in NEW.bridge_secret) <> 1 THEN
    RAISE EXCEPTION 'platform.dashboards.bridge_secret must be encrypted (enc:v1: prefix)';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER enforce_enc_dashboards_bridge_secret
  BEFORE INSERT OR UPDATE OF bridge_secret ON platform.dashboards
  FOR EACH ROW EXECUTE FUNCTION platform.require_enc_dashboards_bridge_secret();

COMMIT;
