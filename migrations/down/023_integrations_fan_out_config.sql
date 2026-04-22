-- Down migration for 023_integrations_fan_out_config.sql.
-- Dropping the fan-out columns removes the ability to fan out from n8n
-- via the step-4b endpoint; intentionally destructive.

BEGIN;

DROP TRIGGER IF EXISTS enforce_enc_integrations_fan_out_secret ON platform.integrations;
-- Re-install the pre-023 single-column trigger from migration 021 so
-- client_secret stays guarded after the rollback.
DROP TRIGGER IF EXISTS enforce_enc_integrations_client_secret ON platform.integrations;
DROP FUNCTION IF EXISTS platform.require_enc_integrations_secrets();

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

ALTER TABLE platform.integrations DROP COLUMN IF EXISTS fan_out_parallelism;
ALTER TABLE platform.integrations DROP COLUMN IF EXISTS fan_out_secret;

COMMIT;
