-- Migration 026: per-(dashboard, tenant) render cache.
--
-- Pre-026, the last-rendered HTML/CSS/JS lived on the dashboards row
-- (view_html / view_css / view_js). Tenant-scoped dashboards rendered
-- once, so one set of columns per row was enough. Global dashboards
-- render N times — one per rendering tenant — so caching them on the
-- row becomes racy: tenant A's render clobbers tenant B's.
--
-- This table moves the cache to a per-(dashboard, tenant) row, PK on
-- both. Render code writes here on every successful upstream fetch and
-- reads it on fallback. The legacy columns on platform.dashboards stay
-- for now — tenant-scoped render still dual-writes them so any non-
-- render reader (portability, embed, admin preview fallbacks) keeps
-- seeing fresh content. Retiring the legacy columns is a post-step
-- cleanup (requires auditing every non-render read path).
--
-- Purely additive, pre-rebuild stage. Idempotent.

BEGIN;

CREATE TABLE IF NOT EXISTS platform.dashboard_render_cache (
    dashboard_id UUID NOT NULL REFERENCES platform.dashboards(id) ON DELETE CASCADE,
    tenant_id    UUID NOT NULL REFERENCES platform.tenants(id) ON DELETE CASCADE,
    view_html    TEXT,
    view_css     TEXT,
    view_js      TEXT,
    rendered_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (dashboard_id, tenant_id)
);

-- Partial index for "most recent render per tenant" style queries.
CREATE INDEX IF NOT EXISTS idx_dashboard_render_cache_tenant_recent
    ON platform.dashboard_render_cache (tenant_id, rendered_at DESC);

COMMIT;
