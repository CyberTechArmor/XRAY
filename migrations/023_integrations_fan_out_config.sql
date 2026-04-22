-- Migration 023: per-integration fan-out config.
--
-- Step 4b's fan-out endpoint (POST /api/integrations/:slug/fan-out) lets
-- n8n — not XRay — own the per-integration sync schedule. n8n's cron
-- hits the endpoint; XRay resolves each tenant's live access token and
-- POSTs once per connected tenant to the target URL the caller supplied.
--
-- Two additive columns on platform.integrations:
--   fan_out_secret      — shared secret used BOTH to authenticate the
--                         incoming n8n-→-XRay call (Bearer header) AND
--                         to sign the outgoing envelope JWT that XRay
--                         POSTs to the target URL. One secret keeps
--                         admin UI and n8n credential config simple;
--                         rotation is per-integration. Encrypted at
--                         rest via the enc:v1: envelope (same contract
--                         as migrations 017/019/021).
--   fan_out_parallelism — maximum concurrent deliveries per run. Small
--                         integer; defaults to 5. Admin can raise for
--                         integrations with higher-throughput targets.
--
-- Extend the existing integrations enc trigger (migration 021) to
-- guard fan_out_secret under the same envelope contract. The trigger
-- function is re-created with both columns checked; the trigger is
-- re-bound to fire on INSERT OR UPDATE OF either secret column.
--
-- Purely additive, pre-rebuild stage. Idempotent.

BEGIN;

ALTER TABLE platform.integrations
  ADD COLUMN IF NOT EXISTS fan_out_secret TEXT;
ALTER TABLE platform.integrations
  ADD COLUMN IF NOT EXISTS fan_out_parallelism INTEGER NOT NULL DEFAULT 5
    CHECK (fan_out_parallelism BETWEEN 1 AND 50);

-- Re-create the integration secret enforcement trigger covering BOTH
-- client_secret (from migration 021) and the new fan_out_secret.
DROP TRIGGER IF EXISTS enforce_enc_integrations_client_secret ON platform.integrations;
DROP TRIGGER IF EXISTS enforce_enc_integrations_fan_out_secret ON platform.integrations;
DROP FUNCTION IF EXISTS platform.require_enc_integrations_client_secret();
DROP FUNCTION IF EXISTS platform.require_enc_integrations_secrets();

CREATE OR REPLACE FUNCTION platform.require_enc_integrations_secrets() RETURNS trigger AS $$
BEGIN
  IF NEW.client_secret IS NOT NULL AND NEW.client_secret <> ''
     AND position('enc:v1:' in NEW.client_secret) <> 1 THEN
    RAISE EXCEPTION 'platform.integrations.client_secret must be encrypted (enc:v1: prefix)';
  END IF;
  IF NEW.fan_out_secret IS NOT NULL AND NEW.fan_out_secret <> ''
     AND position('enc:v1:' in NEW.fan_out_secret) <> 1 THEN
    RAISE EXCEPTION 'platform.integrations.fan_out_secret must be encrypted (enc:v1: prefix)';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER enforce_enc_integrations_client_secret
  BEFORE INSERT OR UPDATE OF client_secret ON platform.integrations
  FOR EACH ROW EXECUTE FUNCTION platform.require_enc_integrations_secrets();

CREATE TRIGGER enforce_enc_integrations_fan_out_secret
  BEFORE INSERT OR UPDATE OF fan_out_secret ON platform.integrations
  FOR EACH ROW EXECUTE FUNCTION platform.require_enc_integrations_secrets();

COMMIT;
