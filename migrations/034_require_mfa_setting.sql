-- Migration 034: seed `require_mfa_for_platform_admins` setting.
--
-- Adds the platform_settings row that gates the MFA-required-for-
-- admins enforcement. Default `false` so existing installs are not
-- disrupted by the upgrade — the operator flips it to `true` via
-- Admin → Platform Settings (UI shipped in step 9) once every
-- platform admin has TOTP enrolled.
--
-- When `true`, auth.service blocks login for any platform admin
-- without a confirmed TOTP secret, redirecting them through the
-- enrollment flow before issuing a session.
--
-- Idempotent: ON CONFLICT DO NOTHING.

BEGIN;

INSERT INTO platform.platform_settings (key, value, is_secret)
VALUES ('require_mfa_for_platform_admins', 'false', false)
ON CONFLICT (key) DO NOTHING;

COMMIT;
