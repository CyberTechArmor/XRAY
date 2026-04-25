-- Migration 032: per-user TOTP backup codes.
--
-- Companion to migration 031. When a user enrolls TOTP they receive
-- 8 single-use backup codes — viewable once at enrollment, then
-- recoverable only by regeneration (which invalidates the previous
-- batch). Each row stores a bcrypt hash, never the plaintext code;
-- verification re-hashes the input and compares.
--
-- Format on the wire (services/backup-codes.service.ts): three
-- 4-character base32-ish groups joined with hyphens, e.g.
-- "abcd-efgh-ijkl". Hash on insert, plaintext is shown to the
-- user once and discarded server-side.
--
-- ON DELETE CASCADE on user_id matches the parent
-- platform.user_totp_secrets cascade — deleting a user's TOTP row
-- (disable flow) sweeps the backup codes too.
--
-- RLS shape mirrors migration 029: tenant_isolation +
-- platform_admin_bypass.
--
-- Idempotent. No data migration required.

BEGIN;

CREATE TABLE IF NOT EXISTS platform.user_backup_codes (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES platform.users(id) ON DELETE CASCADE,
  tenant_id   UUID NOT NULL REFERENCES platform.tenants(id) ON DELETE CASCADE,
  code_hash   TEXT NOT NULL,
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Hot path: count remaining unused codes for a user, and find the
-- candidate set to scan during verify. Filtering on `used_at IS NULL`
-- via the partial index keeps the verify scan tight.
CREATE INDEX IF NOT EXISTS idx_user_backup_codes_user_unused
  ON platform.user_backup_codes (user_id)
  WHERE used_at IS NULL;

ALTER TABLE platform.user_backup_codes ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY tenant_isolation ON platform.user_backup_codes
    USING (tenant_id = current_setting('app.current_tenant', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY platform_admin_bypass ON platform.user_backup_codes
    USING (current_setting('app.is_platform_admin', true)::boolean = true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

COMMIT;
