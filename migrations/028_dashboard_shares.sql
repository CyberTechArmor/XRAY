-- Migration 028: per-(dashboard, tenant) share tokens for Global dashboards.
--
-- Step 4b-followup. The pre-028 share model — platform.dashboards.
-- public_token (a single token per dashboard row) — can't express
-- "tenant A's share of a Global" vs "tenant B's share of the same
-- Global": each share renders under the sharing tenant's credentials,
-- so tokens must be tenant-scoped.
--
-- Tenant-scoped dashboards keep using platform.dashboards.public_token
-- unchanged — avoids breaking existing share links and keeps the
-- migration data-safe. Global dashboards use this new table.
--
-- Lookup model (see dashboard.service.getPublicDashboard):
--   1. Try platform.dashboards.public_token = :token AND scope='tenant'.
--   2. Fall back to dashboard_shares.public_token = :token — returns
--      (dashboard, sharing tenant) and the render uses the sharing
--      tenant's credentials.
--
-- Purely additive, pre-rebuild stage. Idempotent.

BEGIN;

CREATE TABLE IF NOT EXISTS platform.dashboard_shares (
    dashboard_id  UUID NOT NULL REFERENCES platform.dashboards(id) ON DELETE CASCADE,
    tenant_id     UUID NOT NULL REFERENCES platform.tenants(id)    ON DELETE CASCADE,
    public_token  TEXT NOT NULL,
    is_public     BOOLEAN NOT NULL DEFAULT false,
    created_by    UUID REFERENCES platform.users(id),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (dashboard_id, tenant_id)
);

-- Token uniqueness: the /share/:token resolver looks tokens up across
-- BOTH dashboards.public_token and dashboard_shares.public_token, so
-- globally unique tokens keep the resolution path unambiguous.
CREATE UNIQUE INDEX IF NOT EXISTS dashboard_shares_public_token_unique
    ON platform.dashboard_shares (public_token);

COMMIT;
