-- Migration 031: per-user TOTP secret store.
--
-- Step 9 of the platform-hardening track introduces a TOTP second
-- factor alongside the already-shipped passkey path. Each enrolled
-- user has exactly one row here:
--
--   • secret_ciphertext — base32 TOTP secret, stored under the
--     `enc:v1:` envelope (see migration 017 + lib/encrypted-column.ts).
--     A BEFORE INSERT/UPDATE trigger rejects plaintext writes.
--   • confirmed_at — NULL until the first code is verified by the
--     enrollment-confirm flow. Login MFA-gate treats unconfirmed rows
--     as "not enrolled."
--   • tenant_id — duplicated from platform.users so RLS can gate on
--     it directly without a join. ON DELETE CASCADE on both FKs so a
--     user/tenant deletion sweeps the secret with it.
--
-- RLS shape mirrors migration 029: tenant_isolation +
-- platform_admin_bypass. Reads / writes from the application use
-- withTenantContext (per CLAUDE.md "new code defaults to
-- withTenantContext"); admin support paths use withAdminClient.
--
-- Idempotent. No data migration required.

BEGIN;

CREATE TABLE IF NOT EXISTS platform.user_totp_secrets (
  user_id            UUID PRIMARY KEY REFERENCES platform.users(id) ON DELETE CASCADE,
  tenant_id          UUID NOT NULL REFERENCES platform.tenants(id) ON DELETE CASCADE,
  secret_ciphertext  TEXT NOT NULL,
  confirmed_at       TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE platform.user_totp_secrets ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY tenant_isolation ON platform.user_totp_secrets
    USING (tenant_id = current_setting('app.current_tenant', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY platform_admin_bypass ON platform.user_totp_secrets
    USING (current_setting('app.is_platform_admin', true)::boolean = true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Encrypted-column trigger. Same contract as migration 017's columns:
-- non-empty values must carry the `enc:v1:` prefix. The TS layer
-- (services/totp.service.ts) wraps the plaintext base32 secret in
-- encryptSecret() before INSERT.
DROP TRIGGER IF EXISTS enforce_enc_user_totp_secret ON platform.user_totp_secrets;
DROP FUNCTION IF EXISTS platform.require_enc_user_totp_secret();

CREATE OR REPLACE FUNCTION platform.require_enc_user_totp_secret() RETURNS trigger AS $$
BEGIN
  IF NEW.secret_ciphertext IS NOT NULL AND NEW.secret_ciphertext <> ''
     AND position('enc:v1:' in NEW.secret_ciphertext) <> 1 THEN
    RAISE EXCEPTION 'platform.user_totp_secrets.secret_ciphertext must be encrypted (enc:v1: prefix)';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER enforce_enc_user_totp_secret
  BEFORE INSERT OR UPDATE OF secret_ciphertext ON platform.user_totp_secrets
  FOR EACH ROW EXECUTE FUNCTION platform.require_enc_user_totp_secret();

COMMIT;
