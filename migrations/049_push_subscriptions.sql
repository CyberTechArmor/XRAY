-- Migration 049: push_subscriptions (relocated from runtime self-healing).
--
-- Originally created by services/push.service.ts at request time via
-- CREATE TABLE IF NOT EXISTS. That worked when the runtime DB user
-- (xray) was the schema owner, but post-step-12 the runtime is the
-- non-owner xray_app role, which can't run DDL — every push/subscribe
-- request 500s with "permission denied for schema platform".
--
-- Move the table to a proper migration owned by the bootstrap user.
-- IF NOT EXISTS makes it a no-op for installs where push.service
-- already created the table under the old runtime role; FORCE RLS +
-- the user_isolation policy land it in the same shape every other
-- platform.* table has.

BEGIN;

CREATE TABLE IF NOT EXISTS platform.push_subscriptions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES platform.users(id) ON DELETE CASCADE,
  endpoint    TEXT NOT NULL,
  keys_p256dh TEXT NOT NULL,
  keys_auth   TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, endpoint)
);

CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user
  ON platform.push_subscriptions (user_id);

-- RLS: each user sees only their own subscriptions. Platform admins
-- bypass for cross-user push delivery audits.
ALTER TABLE platform.push_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.push_subscriptions FORCE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY user_scope ON platform.push_subscriptions
    USING      (user_id = platform.current_user_id())
    WITH CHECK (user_id = platform.current_user_id());
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY platform_admin_bypass ON platform.push_subscriptions
    USING      (platform.is_platform_admin())
    WITH CHECK (platform.is_platform_admin());
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

COMMIT;
