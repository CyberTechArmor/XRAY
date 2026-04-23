-- Migration 029: platform-DB RLS policy audit + fill-in.
--
-- Step 6 of the tenant-capture bridge. The RLS audit in
-- .claude/withclient-audit.md found five tables that carry a
-- tenant_id column but have no tenant_isolation policy — so any
-- query that switches into tenant context (via withTenantContext,
-- new in step 6 (ii)) returned zero rows regardless of the tenant
-- scope. This migration adds the missing policies so the
-- application-layer migration in step 6 (iii) actually gates
-- cross-tenant access at the DB.
--
-- Tables and rationale:
--
-- • fan_out_deliveries (mig 024) — per-(run, tenant) delivery rows.
--   tenant_id is the recipient tenant. RLS + tenant_isolation +
--   platform_admin_bypass. Writes still flow through
--   withAdminClient for the iteration case (fan-out.service runs
--   across all connected tenants) and through withTenantContext
--   for per-tenant delivery attempt updates.
--
-- • dashboard_render_cache (mig 026) — per-(dashboard, tenant)
--   cached render. tenant_id is the rendering tenant. RLS +
--   tenant_isolation + platform_admin_bypass. Admin preview paths
--   keep working via the bypass.
--
-- • dashboard_tenant_grants (mig 027) — tenant_id is the grant
--   recipient. A tenant should only see grants pointing at
--   themselves. Admin surface manages the full list via bypass.
--
-- • dashboard_shares (mig 028) — tenant_id is the sharing tenant.
--   /share/:token lookup happens unauthenticated but must cross
--   tenants (the token is the capability). The resolver runs
--   under withAdminClient so admin_bypass handles it; no
--   special public-token policy is needed.
--
-- • tenant_notes (init.sql:198) — platform-admin-only today, may
--   be removed entirely later. Does NOT get tenant_isolation —
--   tenants are never meant to see notes. Gets RLS enabled +
--   platform_admin_bypass only. Any code path that somehow runs
--   in tenant context (no one does today) returns zero rows by
--   default-deny.
--
-- Special case:
--
-- • connection_comments (init.sql:138) — ENABLE ROW LEVEL
--   SECURITY is set in init.sql but no tenant_isolation policy
--   exists; only platform_admin_bypass. The table has
--   connection_id (not tenant_id) so isolation must join through
--   platform.connections. This migration adds the transitive
--   tenant_isolation policy.
--
-- Not covered (documented carve-outs that stay bypass-only or
-- global):
--
-- • magic_links — queried pre-login by token; unauth path needs
--   bypass-equivalent access. Leaves RLS off.
-- • platform_settings, email_templates, integrations,
--   fan_out_runs, roles, permissions, role_permissions,
--   connection_templates, tenants — true globals.
-- • inbox_threads / inbox_thread_participants / inbox_messages —
--   user-scoped, not tenant-scoped. Deferred to a future
--   migration that mirrors mig 016's user_scope shape.
-- • ai_* — already handled by migration 016.
--
-- Purely additive. Idempotent. No data migration required.

BEGIN;

-- ── fan_out_deliveries ──────────────────────────────────────────
ALTER TABLE platform.fan_out_deliveries ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY tenant_isolation ON platform.fan_out_deliveries
    USING (tenant_id = current_setting('app.current_tenant', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY platform_admin_bypass ON platform.fan_out_deliveries
    USING (current_setting('app.is_platform_admin', true)::boolean = true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── dashboard_render_cache ──────────────────────────────────────
ALTER TABLE platform.dashboard_render_cache ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY tenant_isolation ON platform.dashboard_render_cache
    USING (tenant_id = current_setting('app.current_tenant', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY platform_admin_bypass ON platform.dashboard_render_cache
    USING (current_setting('app.is_platform_admin', true)::boolean = true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── dashboard_tenant_grants ─────────────────────────────────────
ALTER TABLE platform.dashboard_tenant_grants ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY tenant_isolation ON platform.dashboard_tenant_grants
    USING (tenant_id = current_setting('app.current_tenant', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY platform_admin_bypass ON platform.dashboard_tenant_grants
    USING (current_setting('app.is_platform_admin', true)::boolean = true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── dashboard_shares ────────────────────────────────────────────
ALTER TABLE platform.dashboard_shares ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY tenant_isolation ON platform.dashboard_shares
    USING (tenant_id = current_setting('app.current_tenant', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY platform_admin_bypass ON platform.dashboard_shares
    USING (current_setting('app.is_platform_admin', true)::boolean = true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── tenant_notes (admin-only; NO tenant_isolation) ──────────────
ALTER TABLE platform.tenant_notes ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY platform_admin_bypass ON platform.tenant_notes
    USING (current_setting('app.is_platform_admin', true)::boolean = true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── connection_comments (transitive tenant_isolation) ──────────
-- RLS is already enabled (init.sql:406) and platform_admin_bypass
-- exists (init.sql:536). Add tenant_isolation that joins through
-- platform.connections since this table has no tenant_id column
-- of its own. Kept as EXISTS (not JOIN) so the policy evaluates
-- per-row without needing a rewrite rule.
DO $$ BEGIN
  CREATE POLICY tenant_isolation ON platform.connection_comments
    USING (EXISTS (
      SELECT 1 FROM platform.connections c
       WHERE c.id = connection_comments.connection_id
         AND c.tenant_id = current_setting('app.current_tenant', true)::uuid
    ));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

COMMIT;
