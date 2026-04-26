-- Migration 039: append-only policy_documents store.
--
-- Step 11 of the platform-hardening track introduces versioned
-- legal-policy storage backing the public /legal/<slug> pages and
-- the re-acceptance modal. Every published version of every slug
-- is one row here; editing a published policy in the admin UI mints
-- a NEW row with version = max(version) + 1 (never UPDATE in place).
--
-- Schema:
--
--   • slug          — TEXT, e.g. terms_of_service / privacy_policy /
--                     cookie_policy / dpa / subprocessors /
--                     acceptable_use. The migration treats this as a
--                     free-text key (no enum) so the operator can
--                     introduce new slugs without a follow-up
--                     migration. Six are seeded in migration 041.
--   • version       — monotonically increasing per slug (1, 2, 3 …).
--                     publishVersion takes max(version)+1 inside
--                     withAdminClient; UNIQUE (slug, version) gates
--                     the race when two admins click Publish at the
--                     same instant.
--   • title         — display title for the public page header.
--   • body_md       — markdown source of truth. Public pages render
--                     it client-side via `marked`. Sanitisation is
--                     the renderer's responsibility, not the DB's.
--   • is_required   — gates the re-acceptance modal. Required slugs
--                     whose latest version is newer than the user's
--                     latest acceptance force a blocking modal at
--                     app boot. Operator can flip a slug to false
--                     (e.g., subprocessors) so its bumps don't
--                     gate the app, while still showing the page.
--   • published_at  — display + sort key.
--   • published_by  — UUID FK to platform.users(id) with ON DELETE
--                     SET NULL so a deactivated admin's identity
--                     survives the published-by attribution
--                     getting NULLed.
--
-- Carve-out — no RLS. Every logged-out visitor needs read access
-- via /api/legal/<slug>; the public surface mirrors the
-- magic_links / platform_settings shape. Reads run under plain
-- withClient from policy.service (allow-listed in
-- scripts/check-withclient-allowlist.sh per CLAUDE.md).
-- Cross-tenant admin writes (publishVersion) run under
-- withAdminClient.
--
-- Index on (slug, version DESC) so the canonical "latest version
-- per slug" lookup is index-only.
--
-- Idempotent. No data migration required.

BEGIN;

CREATE TABLE IF NOT EXISTS platform.policy_documents (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug          TEXT NOT NULL,
  version       INT  NOT NULL,
  title         TEXT NOT NULL,
  body_md       TEXT NOT NULL,
  is_required   BOOLEAN NOT NULL DEFAULT TRUE,
  published_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  published_by  UUID REFERENCES platform.users(id) ON DELETE SET NULL,
  UNIQUE (slug, version)
);

CREATE INDEX IF NOT EXISTS idx_policy_documents_slug_version
  ON platform.policy_documents (slug, version DESC);

-- No RLS — public-read carve-out. Documented above.

COMMIT;
