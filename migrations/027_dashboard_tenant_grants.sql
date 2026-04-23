-- Migration 027: per-tenant grants for Custom Globals.
--
-- Integration-connected Global dashboards are integration-gated: a
-- tenant can render iff they have an active connection to the
-- dashboard's integration. That's sufficient because the render
-- semantically needs the tenant's own credential.
--
-- Custom (no-auth) Globals don't have an integration, so the gate
-- would be empty — any tenant could render any Custom Global by
-- default. That's surprising exposure for static-HTML content. This
-- table makes Custom Globals opt-in: a tenant can render a Custom
-- Global iff a grant row exists for (dashboard_id, tenant_id).
--
-- Integration-connected Globals do NOT need a grant row; the
-- connection is the grant. Application-layer enforces the branching.
--
-- Purely additive, pre-rebuild stage. Idempotent.

BEGIN;

CREATE TABLE IF NOT EXISTS platform.dashboard_tenant_grants (
    dashboard_id UUID NOT NULL REFERENCES platform.dashboards(id) ON DELETE CASCADE,
    tenant_id    UUID NOT NULL REFERENCES platform.tenants(id)    ON DELETE CASCADE,
    granted_by   UUID REFERENCES platform.users(id),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (dashboard_id, tenant_id)
);

CREATE INDEX IF NOT EXISTS idx_dashboard_tenant_grants_tenant
    ON platform.dashboard_tenant_grants (tenant_id);

COMMIT;
