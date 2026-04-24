-- Migration 030: Per-user row-level security on inbox tables.
--
-- Inbox threads cross tenant boundaries (support conversations between
-- a platform admin in one tenant and a regular user in another), so
-- the scope key is `user_id`, not `tenant_id`. Mirrors migration 016's
-- user_scope shape for AI tables but uses a transitive join through
-- inbox_thread_participants for the threads + messages tables
-- (inbox_threads and inbox_messages don't carry user_id directly).
--
-- Purely additive + idempotent. No data migration. No write-path
-- breakage because every cross-user write (new thread, new
-- participant, mark-others-unread, thread tag / subject update) goes
-- through withAdminClient — the platform_admin_bypass policy covers it.
-- Under withUserContext, reads filter to the acting user's threads
-- only, and writes to the acting user's own participant row (e.g.
-- toggleStar / toggleArchive) are allowed by the USING clause.

BEGIN;

-- Enable RLS. ALTER TABLE ENABLE ROW LEVEL SECURITY is idempotent.
ALTER TABLE platform.inbox_threads ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.inbox_thread_participants ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.inbox_messages ENABLE ROW LEVEL SECURITY;

-- Participants: direct user_id match.
DO $$ BEGIN
    CREATE POLICY user_scope ON platform.inbox_thread_participants
      USING (
        user_id = current_setting('app.current_user_id', true)::uuid
      );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Threads: visible when the acting user is a participant.
DO $$ BEGIN
    CREATE POLICY user_scope ON platform.inbox_threads
      USING (
        EXISTS (
          SELECT 1 FROM platform.inbox_thread_participants p
           WHERE p.thread_id = inbox_threads.id
             AND p.user_id = current_setting('app.current_user_id', true)::uuid
        )
      );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Messages: visible when the acting user is a participant of the
-- owning thread.
DO $$ BEGIN
    CREATE POLICY user_scope ON platform.inbox_messages
      USING (
        EXISTS (
          SELECT 1 FROM platform.inbox_thread_participants p
           WHERE p.thread_id = inbox_messages.thread_id
             AND p.user_id = current_setting('app.current_user_id', true)::uuid
        )
      );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Platform admin bypass — support staff need visibility into every
-- thread for moderation / tenant support.
DO $$ BEGIN
    CREATE POLICY platform_admin_bypass ON platform.inbox_threads
      USING (current_setting('app.is_platform_admin', true)::boolean = true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE POLICY platform_admin_bypass ON platform.inbox_thread_participants
      USING (current_setting('app.is_platform_admin', true)::boolean = true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE POLICY platform_admin_bypass ON platform.inbox_messages
      USING (current_setting('app.is_platform_admin', true)::boolean = true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

COMMIT;
