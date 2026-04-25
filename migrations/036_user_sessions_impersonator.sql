-- Migration 036: impersonator_user_id on user_sessions.
--
-- Step-10 audit metadata for platform-admin impersonation. When a
-- platform admin POSTs /api/admin/impersonate/:tenantId/:userId, we
-- mint a NEW session row owned by the target user (target's
-- user_id + tenant_id) and stamp this column with the calling
-- admin's user_id. The /stop endpoint reads this column to find
-- the original admin and rotate a fresh session for them.
--
--   • impersonator_user_id NULL  → ordinary session.
--   • impersonator_user_id NOT NULL → impersonation session;
--     access-token JWT carries an `imp` claim so the app shell
--     can render the persistent red banner without a follow-up
--     /me call.
--
-- ON DELETE SET NULL on the FK — if the admin user is later
-- deleted, the impersonation row stays for audit (the tenant
-- audit_log row is the durable record; this column is the
-- live-session pointer).
--
-- RLS already enabled on platform.user_sessions (init.sql:410).
-- tenant_isolation + platform_admin_bypass policies are unchanged
-- — impersonation sessions live in the TARGET tenant's row set,
-- which is the correct scope for tenant-side visibility.
--
-- Existing rows are populated NULL by the ADD COLUMN — no data
-- migration required.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT
-- EXISTS.

BEGIN;

ALTER TABLE platform.user_sessions
  ADD COLUMN IF NOT EXISTS impersonator_user_id UUID
    REFERENCES platform.users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_user_sessions_impersonator
  ON platform.user_sessions (impersonator_user_id)
  WHERE impersonator_user_id IS NOT NULL;

COMMIT;
