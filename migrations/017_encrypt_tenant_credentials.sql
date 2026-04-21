-- Migration 017: Enforce encrypted-at-rest for tenant credentials.
--
-- Installs BEFORE INSERT/UPDATE triggers that reject writes to three
-- credential-bearing columns unless the value is null, empty, or carries
-- the `enc:v1:` envelope written by server/src/lib/encrypted-column.ts.
--
-- Deploy order (see CONTEXT.md):
--   1. Deploy server code that encrypts on write and decrypts on read.
--   2. Apply this migration (deploy.sh/update.sh pick it up via
--      migrations/*.sql; the companion down migration lives in
--      migrations/down/ so the glob does not re-apply it).
--   3. Run scripts/backfill-encrypt-credentials.ts to rewrite any
--      plaintext rows still in place.
--
-- Idempotent: trigger functions are CREATE OR REPLACE, triggers are
-- wrapped in DO $$ ... duplicate_object blocks. One function per
-- column so NEW.<col> is resolved statically — no dynamic field access.

CREATE OR REPLACE FUNCTION platform.require_enc_webhooks_secret() RETURNS trigger AS $$
BEGIN
  IF NEW.secret IS NOT NULL AND NEW.secret <> ''
     AND position('enc:v1:' in NEW.secret) <> 1 THEN
    RAISE EXCEPTION 'platform.webhooks.secret must be encrypted (enc:v1: prefix)';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION platform.require_enc_connections_details() RETURNS trigger AS $$
BEGIN
  IF NEW.connection_details IS NOT NULL AND NEW.connection_details <> ''
     AND position('enc:v1:' in NEW.connection_details) <> 1 THEN
    RAISE EXCEPTION 'platform.connections.connection_details must be encrypted (enc:v1: prefix)';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION platform.require_enc_dashboards_fetch_headers() RETURNS trigger AS $$
DECLARE
  enc_val TEXT;
BEGIN
  IF NEW.fetch_headers IS NULL OR NEW.fetch_headers = '{}'::jsonb THEN
    RETURN NEW;
  END IF;
  IF jsonb_typeof(NEW.fetch_headers) <> 'object'
     OR NOT (NEW.fetch_headers ? '_enc')
     OR (SELECT count(*) FROM jsonb_object_keys(NEW.fetch_headers)) <> 1 THEN
    RAISE EXCEPTION 'platform.dashboards.fetch_headers must be encrypted (single _enc key)';
  END IF;
  enc_val := NEW.fetch_headers->>'_enc';
  IF enc_val IS NULL OR position('enc:v1:' in enc_val) <> 1 THEN
    RAISE EXCEPTION 'platform.dashboards.fetch_headers._enc must start with enc:v1:';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$ BEGIN
  CREATE TRIGGER enforce_enc_webhooks_secret
    BEFORE INSERT OR UPDATE OF secret ON platform.webhooks
    FOR EACH ROW EXECUTE FUNCTION platform.require_enc_webhooks_secret();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TRIGGER enforce_enc_connections_details
    BEFORE INSERT OR UPDATE OF connection_details ON platform.connections
    FOR EACH ROW EXECUTE FUNCTION platform.require_enc_connections_details();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TRIGGER enforce_enc_dashboards_fetch_headers
    BEFORE INSERT OR UPDATE OF fetch_headers ON platform.dashboards
    FOR EACH ROW EXECUTE FUNCTION platform.require_enc_dashboards_fetch_headers();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
