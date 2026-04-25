-- Migration 040: per-user-per-version policy acceptances ledger.
--
-- Step 11 — companion to migration 039's append-only
-- policy_documents store. Every time a user accepts a published
-- policy version (initial signup, re-acceptance modal after a
-- version bump, cookie banner choice, …) one row lands here. The
-- (user_id, slug, version) UNIQUE makes recordAcceptance
-- idempotent: clicking "I accept" twice or batching multiple
-- pending slugs in one modal round-trip never duplicates rows.
--
-- Schema:
--
--   • user_id      — FK to platform.users(id). ON DELETE CASCADE so
--                    the step-10 GDPR Art. 17 soft-delete sweep
--                    doesn't leave stranded acceptance rows.
--   • tenant_id    — FK to platform.tenants(id). Duplicated from
--                    users so RLS can gate on it directly without a
--                    join, mirroring the migration 031 / 032 shape.
--   • slug         — free-text key matching policy_documents.slug.
--                    No FK so acceptance rows survive a slug rename
--                    (versions stay tied to the historical name).
--   • version      — INT matching the policy_documents row the user
--                    accepted. The pendingForUser query joins on
--                    (slug, version) to compute the "user is up to
--                    date" predicate.
--   • accepted_at  — when the click landed.
--   • ip_hash      — sha256(req.ip || JWT_SECRET); same shape as
--                    auth_attempts.ip_hash (migration 035) and
--                    magic_links.issuer_ip_hash (migration 037).
--                    Forensic-only — never used for gating.
--   • ua_hash      — sha256(req.headers['user-agent'] || JWT_SECRET);
--                    matches magic_links.issuer_ua_hash shape.
--
-- RLS shape mirrors migration 029: tenant_isolation +
-- platform_admin_bypass. Reads / writes from the application use
-- withTenantContext (per CLAUDE.md "new code defaults to
-- withTenantContext"); admin audit paths use withAdminClient.
--
-- Two indexes:
--
--   • (user_id, slug, version DESC) — backs pendingForUser's "what
--     is this user's latest acceptance per slug" lookup. Index-only
--     scan when the planner picks it.
--   • (slug, version) — backs the admin Policies acceptance-counts
--     query (acceptors per published version).
--
-- Idempotent. No data migration required.

BEGIN;

CREATE TABLE IF NOT EXISTS platform.policy_acceptances (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES platform.users(id) ON DELETE CASCADE,
  tenant_id    UUID NOT NULL REFERENCES platform.tenants(id) ON DELETE CASCADE,
  slug         TEXT NOT NULL,
  version      INT  NOT NULL,
  accepted_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ip_hash      TEXT,
  ua_hash      TEXT,
  UNIQUE (user_id, slug, version)
);

CREATE INDEX IF NOT EXISTS idx_policy_acceptances_user_slug_version
  ON platform.policy_acceptances (user_id, slug, version DESC);

CREATE INDEX IF NOT EXISTS idx_policy_acceptances_slug_version
  ON platform.policy_acceptances (slug, version);

ALTER TABLE platform.policy_acceptances ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY tenant_isolation ON platform.policy_acceptances
    USING (tenant_id = current_setting('app.current_tenant', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY platform_admin_bypass ON platform.policy_acceptances
    USING (current_setting('app.is_platform_admin', true)::boolean = true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

COMMIT;
