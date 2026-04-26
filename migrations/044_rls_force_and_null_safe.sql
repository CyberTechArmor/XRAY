-- Migration 044: FORCE RLS + NULL-safe RLS context readers (step 12)
--
-- Closes a long-standing gap surfaced when wiring `PROBE_RLS=1` into
-- CI: row-level security has been *decorative* for the connecting
-- application user. Two stacked issues:
--
-- 1. **Owner bypass.** The docker-compose stack creates POSTGRES_USER
--    (xray) as a superuser-equivalent and runs init.sql AS that
--    user, so xray ends up OWNING every platform.* table. Postgres
--    bypasses RLS for table owners by default — the policies attach
--    but never fire on a withTenantContext / withAdminClient
--    checkout. CONTEXT.md step-6's "RLS is decorative no more"
--    framing was true at the application layer (the helpers impose
--    discipline on which tenant_id each query targets) but NOT at
--    the DB layer.
--
-- 2. **Non-NULL-safe policies.** Once owner-bypass is removed and
--    policies actually evaluate, they crash on unset GUCs:
--      * `current_setting('app.current_tenant', true)::uuid` →
--        invalid input syntax for type uuid: "" when unset
--      * `current_setting('app.is_platform_admin', true)::boolean` →
--        invalid input syntax for type boolean: "" when unset
--    `withAdminClient` doesn't set app.current_tenant, so the
--    tenant_isolation USING raises during policy evaluation even
--    though platform_admin_bypass would have permitted the row
--    (Postgres evaluates ALL policies; one raising aborts the query).
--
-- Fix:
--
-- A. Three helper functions in the platform schema centralise the
--    NULL-safe GUC reads:
--      * platform.current_tenant_id() → uuid (nullif → ::uuid)
--      * platform.current_user_id() → uuid (nullif → ::uuid)
--      * platform.is_platform_admin() → boolean (coalesce → '=true')
--    Helpers are STABLE PARALLEL SAFE so the planner can inline them.
--
-- B. ALTER TABLE … FORCE ROW LEVEL SECURITY on every tenant-scoped
--    table so the owner respects the policies. Idempotent — re-runs
--    are no-ops because relrowsecurity / relforcerowsecurity are
--    bool flags.
--
-- C. DROP + CREATE every existing tenant_isolation /
--    platform_admin_bypass / user_scope policy with the helper-call
--    expression. Per-policy because the underlying join shapes
--    differ (simple vs transitive).
--
-- D. Both USING and WITH CHECK are set on every policy so INSERT
--    paths are gated identically to SELECT/UPDATE/DELETE. Previously
--    USING-only meant Postgres defaulted WITH CHECK to USING — same
--    expression but easy to lose track of; setting both explicitly
--    documents intent.
--
-- Idempotent. Re-applying drops + recreates the policies (no schema
-- divergence). Helper functions use OR REPLACE.

BEGIN;

-- ── A. NULL-safe GUC helpers ─────────────────────────────────────
CREATE OR REPLACE FUNCTION platform.current_tenant_id() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE AS
$$ SELECT nullif(current_setting('app.current_tenant', true), '')::uuid $$;

CREATE OR REPLACE FUNCTION platform.current_user_id() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE AS
$$ SELECT nullif(current_setting('app.current_user_id', true), '')::uuid $$;

CREATE OR REPLACE FUNCTION platform.is_platform_admin() RETURNS boolean
  LANGUAGE sql STABLE PARALLEL SAFE AS
$$ SELECT coalesce(current_setting('app.is_platform_admin', true), '') = 'true' $$;

-- ── B. FORCE RLS so the table owner respects policies ────────────
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT c.relname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'platform'
       AND c.relkind = 'r'
       AND c.relrowsecurity = true
  LOOP
    EXECUTE format('ALTER TABLE platform.%I FORCE ROW LEVEL SECURITY', r.relname);
  END LOOP;
END $$;

-- ── C. Recreate policies with helper-based NULL-safe expressions ─

-- C.1  tenant_isolation — simple `tenant_id = ?` shape.
DO $$
DECLARE
  t TEXT;
  simple_tables TEXT[] := ARRAY[
    'users','dashboards','dashboard_access','dashboard_sources','connections',
    'connection_tables','invitations','billing_state','user_passkeys','user_sessions',
    'audit_log','dashboard_embeds','api_keys','webhooks','file_uploads',
    'dashboard_render_cache','dashboard_tenant_grants','dashboard_shares',
    'fan_out_deliveries','policy_acceptances','user_backup_codes','user_totp_secrets',
    'sessions'
  ];
BEGIN
  FOREACH t IN ARRAY simple_tables LOOP
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON platform.%I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON platform.%I '
      ' USING      (tenant_id = platform.current_tenant_id()) '
      ' WITH CHECK (tenant_id = platform.current_tenant_id())', t);
  END LOOP;
END $$;

-- C.2  tenant_isolation — transitive (connection_comments via connections)
DROP POLICY IF EXISTS tenant_isolation ON platform.connection_comments;
CREATE POLICY tenant_isolation ON platform.connection_comments
  USING      (EXISTS (SELECT 1 FROM platform.connections c
                       WHERE c.id = connection_comments.connection_id
                         AND c.tenant_id = platform.current_tenant_id()))
  WITH CHECK (EXISTS (SELECT 1 FROM platform.connections c
                       WHERE c.id = connection_comments.connection_id
                         AND c.tenant_id = platform.current_tenant_id()));

-- C.3  tenant_isolation — transitive (session_segments via sessions)
DROP POLICY IF EXISTS tenant_isolation ON platform.session_segments;
CREATE POLICY tenant_isolation ON platform.session_segments
  USING      (EXISTS (SELECT 1 FROM platform.sessions s
                       WHERE s.id = session_segments.session_id
                         AND s.tenant_id = platform.current_tenant_id()))
  WITH CHECK (EXISTS (SELECT 1 FROM platform.sessions s
                       WHERE s.id = session_segments.session_id
                         AND s.tenant_id = platform.current_tenant_id()));

-- C.4  tenant_isolation — doubly-transitive (segment_* via session_segments → sessions)
DO $$
DECLARE t TEXT;
  segment_tables TEXT[] := ARRAY['segment_recordings','segment_tags','segment_comments'];
BEGIN
  FOREACH t IN ARRAY segment_tables LOOP
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON platform.%I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON platform.%I '
      ' USING      (EXISTS (SELECT 1 FROM platform.session_segments seg '
      '                      JOIN platform.sessions s ON s.id = seg.session_id '
      '                      WHERE seg.id = %I.segment_id '
      '                        AND s.tenant_id = platform.current_tenant_id())) '
      ' WITH CHECK (EXISTS (SELECT 1 FROM platform.session_segments seg '
      '                      JOIN platform.sessions s ON s.id = seg.session_id '
      '                      WHERE seg.id = %I.segment_id '
      '                        AND s.tenant_id = platform.current_tenant_id()))',
      t, t, t);
  END LOOP;
END $$;

-- C.5  user_scope — AI tables (tenant_id + user_id direct)
DO $$
DECLARE t TEXT;
  ai_tables TEXT[] := ARRAY[
    'ai_threads','ai_messages','ai_pins','ai_usage_daily',
    'ai_user_dashboard_prefs','ai_message_feedback'];
BEGIN
  FOREACH t IN ARRAY ai_tables LOOP
    EXECUTE format('DROP POLICY IF EXISTS user_scope ON platform.%I', t);
    EXECUTE format(
      'CREATE POLICY user_scope ON platform.%I '
      ' USING      (tenant_id = platform.current_tenant_id() '
      '             AND user_id = platform.current_user_id()) '
      ' WITH CHECK (tenant_id = platform.current_tenant_id() '
      '             AND user_id = platform.current_user_id())', t);
  END LOOP;
END $$;

-- C.6  user_scope — inbox_thread_participants (user_id direct)
DROP POLICY IF EXISTS user_scope ON platform.inbox_thread_participants;
CREATE POLICY user_scope ON platform.inbox_thread_participants
  USING      (user_id = platform.current_user_id())
  WITH CHECK (user_id = platform.current_user_id());

-- C.7  user_scope — inbox_threads (transitive via participants)
DROP POLICY IF EXISTS user_scope ON platform.inbox_threads;
CREATE POLICY user_scope ON platform.inbox_threads
  USING (EXISTS (SELECT 1 FROM platform.inbox_thread_participants p
                  WHERE p.thread_id = inbox_threads.id
                    AND p.user_id = platform.current_user_id()));

-- C.8  user_scope — inbox_messages (transitive via participants)
DROP POLICY IF EXISTS user_scope ON platform.inbox_messages;
CREATE POLICY user_scope ON platform.inbox_messages
  USING (EXISTS (SELECT 1 FROM platform.inbox_thread_participants p
                  WHERE p.thread_id = inbox_messages.thread_id
                    AND p.user_id = platform.current_user_id()));

-- C.9  platform_admin_bypass — uniform shape across every table that has it.
-- Loop pg_policy and rewrite every existing platform_admin_bypass.
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT c.relname
      FROM pg_policy pol
      JOIN pg_class c ON c.oid = pol.polrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'platform' AND pol.polname = 'platform_admin_bypass'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS platform_admin_bypass ON platform.%I', r.relname);
    EXECUTE format(
      'CREATE POLICY platform_admin_bypass ON platform.%I '
      ' USING      (platform.is_platform_admin()) '
      ' WITH CHECK (platform.is_platform_admin())', r.relname);
  END LOOP;
END $$;

COMMIT;
