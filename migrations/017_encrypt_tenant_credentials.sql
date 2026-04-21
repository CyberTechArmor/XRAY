-- Migration 017: Enforce encrypted-at-rest for tenant credentials.
--
-- Installs BEFORE INSERT/UPDATE triggers that reject writes to three
-- credential-bearing columns unless the value is null, empty, or carries
-- the `enc:v1:` envelope written by server/src/lib/encrypted-column.ts.
--
-- Deploy order (see CONTEXT.md):
--   1. Deploy server code that encrypts on write and decrypts on read.
--   2. Apply this migration.
--   3. Run scripts/backfill-encrypt-credentials.ts to rewrite any
--      plaintext rows still in place.
--
-- Idempotent: trigger functions are CREATE OR REPLACE, triggers are
-- wrapped in DO $$ ... duplicate_object blocks.

CREATE OR REPLACE FUNCTION platform.require_encrypted_text() RETURNS trigger AS $$
DECLARE
  col_name TEXT := TG_ARGV[0];
  val      TEXT;
BEGIN
  EXECUTE format('SELECT ($1).%I::text', col_name) INTO val USING NEW;
  IF val IS NOT NULL AND val <> '' AND position('enc:v1:' in val) <> 1 THEN
    RAISE EXCEPTION 'column %.% must be encrypted (enc:v1: prefix)', TG_TABLE_NAME, col_name;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION platform.require_encrypted_jsonb() RETURNS trigger AS $$
DECLARE
  col_name TEXT := TG_ARGV[0];
  val      JSONB;
  enc_val  TEXT;
BEGIN
  EXECUTE format('SELECT ($1).%I::jsonb', col_name) INTO val USING NEW;
  IF val IS NULL OR val = '{}'::jsonb THEN
    RETURN NEW;
  END IF;
  IF jsonb_typeof(val) <> 'object'
     OR NOT (val ? '_enc')
     OR (SELECT count(*) FROM jsonb_object_keys(val)) <> 1 THEN
    RAISE EXCEPTION 'column %.% must be encrypted (single _enc key)', TG_TABLE_NAME, col_name;
  END IF;
  enc_val := val->>'_enc';
  IF enc_val IS NULL OR position('enc:v1:' in enc_val) <> 1 THEN
    RAISE EXCEPTION 'column %.%._enc must start with enc:v1:', TG_TABLE_NAME, col_name;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$ BEGIN
  CREATE TRIGGER enforce_enc_webhooks_secret
    BEFORE INSERT OR UPDATE OF secret ON platform.webhooks
    FOR EACH ROW EXECUTE FUNCTION platform.require_encrypted_text('secret');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TRIGGER enforce_enc_connections_details
    BEFORE INSERT OR UPDATE OF connection_details ON platform.connections
    FOR EACH ROW EXECUTE FUNCTION platform.require_encrypted_text('connection_details');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TRIGGER enforce_enc_dashboards_fetch_headers
    BEFORE INSERT OR UPDATE OF fetch_headers ON platform.dashboards
    FOR EACH ROW EXECUTE FUNCTION platform.require_encrypted_jsonb('fetch_headers');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
