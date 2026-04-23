-- Rollback migration 029: drop the policies added and disable RLS on
-- the tables where this migration enabled it. connection_comments
-- stays on (RLS was enabled in init.sql, not by this migration) — we
-- only drop the tenant_isolation policy we added.

BEGIN;

DO $$ BEGIN DROP POLICY IF EXISTS tenant_isolation ON platform.fan_out_deliveries; EXCEPTION WHEN undefined_object THEN NULL; END $$;
DO $$ BEGIN DROP POLICY IF EXISTS platform_admin_bypass ON platform.fan_out_deliveries; EXCEPTION WHEN undefined_object THEN NULL; END $$;
ALTER TABLE platform.fan_out_deliveries DISABLE ROW LEVEL SECURITY;

DO $$ BEGIN DROP POLICY IF EXISTS tenant_isolation ON platform.dashboard_render_cache; EXCEPTION WHEN undefined_object THEN NULL; END $$;
DO $$ BEGIN DROP POLICY IF EXISTS platform_admin_bypass ON platform.dashboard_render_cache; EXCEPTION WHEN undefined_object THEN NULL; END $$;
ALTER TABLE platform.dashboard_render_cache DISABLE ROW LEVEL SECURITY;

DO $$ BEGIN DROP POLICY IF EXISTS tenant_isolation ON platform.dashboard_tenant_grants; EXCEPTION WHEN undefined_object THEN NULL; END $$;
DO $$ BEGIN DROP POLICY IF EXISTS platform_admin_bypass ON platform.dashboard_tenant_grants; EXCEPTION WHEN undefined_object THEN NULL; END $$;
ALTER TABLE platform.dashboard_tenant_grants DISABLE ROW LEVEL SECURITY;

DO $$ BEGIN DROP POLICY IF EXISTS tenant_isolation ON platform.dashboard_shares; EXCEPTION WHEN undefined_object THEN NULL; END $$;
DO $$ BEGIN DROP POLICY IF EXISTS platform_admin_bypass ON platform.dashboard_shares; EXCEPTION WHEN undefined_object THEN NULL; END $$;
ALTER TABLE platform.dashboard_shares DISABLE ROW LEVEL SECURITY;

DO $$ BEGIN DROP POLICY IF EXISTS platform_admin_bypass ON platform.tenant_notes; EXCEPTION WHEN undefined_object THEN NULL; END $$;
ALTER TABLE platform.tenant_notes DISABLE ROW LEVEL SECURITY;

DO $$ BEGIN DROP POLICY IF EXISTS tenant_isolation ON platform.connection_comments; EXCEPTION WHEN undefined_object THEN NULL; END $$;

COMMIT;
