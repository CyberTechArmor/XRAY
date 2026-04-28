-- Migration 050: platform.users.preferences (relocated from runtime
-- self-healing).
--
-- Originally added by services/user.service.ts at request time via
-- ALTER TABLE … ADD COLUMN IF NOT EXISTS. After the step-12 role
-- split the runtime user (xray_app) is non-owner of platform.users,
-- so the ALTER errors with "must be owner of table users" — every
-- /api/users/me/settings request 500s.
--
-- Move the column to a proper migration owned by the bootstrap user.
-- IF NOT EXISTS makes it a no-op for installs where the runtime
-- self-heal already added the column under the old role.

BEGIN;

ALTER TABLE platform.users
  ADD COLUMN IF NOT EXISTS preferences JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMIT;
