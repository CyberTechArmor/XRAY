-- Migration 025: Global vs Tenant dashboard scope.
--
-- A "Global" dashboard lives once in the catalog but renders N times —
-- once per tenant that has the matching integration connected (or an
-- explicit grant for a Custom Global; see migration 027). Each render
-- uses that tenant's own OAuth / API-key credential, so the bridge +
-- pipeline JWTs carry the rendering tenant's id, not the dashboard
-- author's.
--
-- Schema additions (all additive, pre-rebuild stage):
--   1. scope TEXT NOT NULL DEFAULT 'tenant' CHECK ('tenant'|'global').
--      Existing rows keep tenant-scoped behavior by default.
--   2. tenant_id loses NOT NULL. Global rows carry tenant_id=NULL;
--      Tenant rows still require tenant_id.
--   3. Cross-column CHECK: the (scope, tenant_id) pair must be
--      consistent — no Tenant-scoped row without a tenant, no
--      Global-scoped row with one.
--   4. Global rows can never be public — public_token / is_public are
--      per-tenant constructs. CHECK enforces it in addition to the
--      application-layer guard.
--
-- Destructive-looking but actually safe: dropping NOT NULL on tenant_id
-- is additive (existing rows have the value; new rows can omit it).
-- The CHECKs are additive (no existing row violates them because they
-- default to scope='tenant' with NOT NULL tenant_id). Runs in the
-- pre-rebuild stage.

BEGIN;

ALTER TABLE platform.dashboards
  ADD COLUMN IF NOT EXISTS scope TEXT NOT NULL DEFAULT 'tenant'
    CHECK (scope IN ('tenant', 'global'));

-- Drop NOT NULL on tenant_id so Global rows can omit it. Existing
-- rows carry a tenant_id today (NOT NULL pre-025), so this is a
-- permissive relaxation.
ALTER TABLE platform.dashboards ALTER COLUMN tenant_id DROP NOT NULL;

-- Cross-column invariant. Named so a future re-create is a no-op
-- under IF NOT EXISTS equivalents (Postgres doesn't support IF NOT
-- EXISTS on ADD CONSTRAINT; drop-then-create is the idempotent form).
ALTER TABLE platform.dashboards
  DROP CONSTRAINT IF EXISTS dashboards_scope_tenant_id;
ALTER TABLE platform.dashboards
  ADD CONSTRAINT dashboards_scope_tenant_id CHECK (
    (scope = 'tenant' AND tenant_id IS NOT NULL) OR
    (scope = 'global' AND tenant_id IS NULL)
  );

-- Global rows must never be public. Share tokens + is_public are
-- tenant-scoped; a Global with is_public=true would render once per
-- tenant and then be claimed by a share URL with no tenant context.
ALTER TABLE platform.dashboards
  DROP CONSTRAINT IF EXISTS dashboards_global_not_public;
ALTER TABLE platform.dashboards
  ADD CONSTRAINT dashboards_global_not_public CHECK (
    scope = 'tenant' OR (
      COALESCE(is_public, false) = false AND public_token IS NULL
    )
  );

-- Index: tenant dashboard lists filter on (tenant_id, status, scope) —
-- cover the common case.
CREATE INDEX IF NOT EXISTS idx_dashboards_tenant_scope_status
  ON platform.dashboards (tenant_id, scope, status)
  WHERE tenant_id IS NOT NULL;

-- Index: global dashboard lookups filter on (scope, status, integration).
CREATE INDEX IF NOT EXISTS idx_dashboards_global_integration
  ON platform.dashboards (scope, status, integration)
  WHERE scope = 'global';

COMMIT;
