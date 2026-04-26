-- Migration 042: cookie-banner platform-settings seed.
--
-- Step 11 — operator-flippable controls for the landing-page
-- cookie banner. Two keys:
--
--   • cookie_banner_enabled — 'true' (default) | 'false'. Default
--     on so the legal posture is correct out of the box. Operator
--     can flip to 'false' if they front the site with a separate
--     consent layer (their own GTM CMP, OneTrust, …) and don't
--     want the built-in banner to double up.
--
--   • cookie_banner_essential_only_default — 'false' (default) |
--     'true'. Controls which radio option the Manage panel opens
--     pre-selected. Default 'false' so the user explicitly opts
--     in to the more permissive choice; operators in jurisdictions
--     with stricter defaults can flip to 'true' so non-essential
--     cookies start unchecked.
--
-- Both rows are non-secret (is_secret = false) — they're
-- read by the public /api/legal endpoint so the landing page can
-- decide whether to render the banner before the user
-- authenticates. No PII; no secret value.
--
-- ON CONFLICT (key) DO NOTHING so re-runs preserve any operator
-- override applied via the Admin → Platform Settings UI.
--
-- Idempotent. No data migration required.

BEGIN;

INSERT INTO platform.platform_settings (key, value, is_secret)
VALUES
  ('cookie_banner_enabled', 'true', false),
  ('cookie_banner_essential_only_default', 'false', false)
ON CONFLICT (key) DO NOTHING;

COMMIT;
