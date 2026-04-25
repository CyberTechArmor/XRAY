-- Migration 038: seed csrf_signing_secret in platform_settings.
--
-- Step-10 CSRF middleware uses the double-submit cookie pattern:
-- a cookie value AND a matching X-CSRF-Token header are required
-- on every state-changing request. To prevent a forged cookie
-- being paired with an attacker-chosen header value, the cookie
-- payload is `<random>.<hmac(random, csrf_signing_secret)>` —
-- the verify step recomputes the HMAC and rejects mismatches.
--
-- A dedicated secret (rather than reusing JWT_SECRET) keeps the
-- rotation blast radius scoped: rotating CSRF only invalidates
-- in-flight tokens, not outstanding sessions.
--
-- Stored in platform.platform_settings (carve-out, no RLS) under
-- is_secret=true so the existing platform-settings reader/writer
-- redacts it from any UI render. Auto-seeded by this migration
-- so the operator doesn't need to provision it manually on first
-- boot. Operator can rotate via the existing platform-settings
-- UPDATE path (effectively "log everyone's tab out of forms once
-- the cached cookie expires") — never via raw SQL.
--
-- gen_random_bytes is from pgcrypto, which init.sql:1 already
-- enables. encode(..., 'hex') gives a 64-char hex string —
-- 256 bits of entropy, plenty for HMAC-SHA256 keying.
--
-- Idempotent: ON CONFLICT DO NOTHING. A re-run on an existing
-- install preserves the in-use secret.

BEGIN;

INSERT INTO platform.platform_settings (key, value, is_secret)
VALUES (
  'csrf_signing_secret',
  encode(gen_random_bytes(32), 'hex'),
  true
)
ON CONFLICT (key) DO NOTHING;

COMMIT;
