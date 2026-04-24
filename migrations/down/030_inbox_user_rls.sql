-- Rollback migration 030: drop user_scope + platform_admin_bypass
-- policies on the inbox tables and disable RLS.

BEGIN;

DO $$ BEGIN DROP POLICY IF EXISTS user_scope ON platform.inbox_threads; EXCEPTION WHEN undefined_object THEN NULL; END $$;
DO $$ BEGIN DROP POLICY IF EXISTS user_scope ON platform.inbox_thread_participants; EXCEPTION WHEN undefined_object THEN NULL; END $$;
DO $$ BEGIN DROP POLICY IF EXISTS user_scope ON platform.inbox_messages; EXCEPTION WHEN undefined_object THEN NULL; END $$;

DO $$ BEGIN DROP POLICY IF EXISTS platform_admin_bypass ON platform.inbox_threads; EXCEPTION WHEN undefined_object THEN NULL; END $$;
DO $$ BEGIN DROP POLICY IF EXISTS platform_admin_bypass ON platform.inbox_thread_participants; EXCEPTION WHEN undefined_object THEN NULL; END $$;
DO $$ BEGIN DROP POLICY IF EXISTS platform_admin_bypass ON platform.inbox_messages; EXCEPTION WHEN undefined_object THEN NULL; END $$;

ALTER TABLE platform.inbox_threads DISABLE ROW LEVEL SECURITY;
ALTER TABLE platform.inbox_thread_participants DISABLE ROW LEVEL SECURITY;
ALTER TABLE platform.inbox_messages DISABLE ROW LEVEL SECURITY;

COMMIT;
