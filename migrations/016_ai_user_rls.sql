-- Migration 016: Per-user row-level security on AI tables (idempotent).
--
-- Drops the old tenant-only tenant_isolation policy on each user-scoped AI
-- table and replaces it with user_scope, which enforces BOTH tenant_id and
-- user_id match the per-connection GUCs. Platform admin bypass stays intact.

DO $$ BEGIN DROP POLICY IF EXISTS tenant_isolation ON platform.ai_threads; EXCEPTION WHEN undefined_object THEN NULL; END $$;
DO $$ BEGIN DROP POLICY IF EXISTS tenant_isolation ON platform.ai_messages; EXCEPTION WHEN undefined_object THEN NULL; END $$;
DO $$ BEGIN DROP POLICY IF EXISTS tenant_isolation ON platform.ai_pins; EXCEPTION WHEN undefined_object THEN NULL; END $$;
DO $$ BEGIN DROP POLICY IF EXISTS tenant_isolation ON platform.ai_user_dashboard_prefs; EXCEPTION WHEN undefined_object THEN NULL; END $$;
DO $$ BEGIN DROP POLICY IF EXISTS tenant_isolation ON platform.ai_usage_daily; EXCEPTION WHEN undefined_object THEN NULL; END $$;
DO $$ BEGIN DROP POLICY IF EXISTS tenant_isolation ON platform.ai_message_feedback; EXCEPTION WHEN undefined_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE POLICY user_scope ON platform.ai_threads
      USING (
        tenant_id = current_setting('app.current_tenant', true)::uuid
        AND user_id = current_setting('app.current_user_id', true)::uuid
      );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE POLICY user_scope ON platform.ai_messages
      USING (
        tenant_id = current_setting('app.current_tenant', true)::uuid
        AND user_id = current_setting('app.current_user_id', true)::uuid
      );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE POLICY user_scope ON platform.ai_pins
      USING (
        tenant_id = current_setting('app.current_tenant', true)::uuid
        AND user_id = current_setting('app.current_user_id', true)::uuid
      );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE POLICY user_scope ON platform.ai_user_dashboard_prefs
      USING (
        tenant_id = current_setting('app.current_tenant', true)::uuid
        AND user_id = current_setting('app.current_user_id', true)::uuid
      );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE POLICY user_scope ON platform.ai_usage_daily
      USING (
        tenant_id = current_setting('app.current_tenant', true)::uuid
        AND user_id = current_setting('app.current_user_id', true)::uuid
      );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE POLICY user_scope ON platform.ai_message_feedback
      USING (
        tenant_id = current_setting('app.current_tenant', true)::uuid
        AND user_id = current_setting('app.current_user_id', true)::uuid
      );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
