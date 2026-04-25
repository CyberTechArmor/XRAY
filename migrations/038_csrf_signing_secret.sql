-- Migration 038: declare csrf_signing_secret as a known secret key.
--
-- Step-10 CSRF middleware uses the double-submit cookie pattern:
-- a cookie value AND a matching X-CSRF-Token header are required
-- on every state-changing request. To prevent a forged cookie
-- being paired with an attacker-chosen header value, the cookie
-- payload is `<random>.<hmac(random, csrf_signing_secret)>` — the
-- verify step recomputes the HMAC and rejects mismatches.
--
-- A dedicated secret (rather than reusing JWT_SECRET) keeps the
-- rotation blast radius scoped: rotating CSRF only invalidates
-- in-flight tokens, not outstanding sessions.
--
-- Lazy-seeded by the CSRF middleware on first use via
-- settings.service.updateSettings, which writes through the
-- crypto envelope so getSetting() can later decrypt() round-trip.
-- Seeding via SQL would be cleaner but pgcrypto does not implement
-- the AES-256-GCM shape lib/crypto.ts uses, so there is no way to
-- write a pre-encrypted value from the SQL layer.
--
-- This migration is kept (a) so the migration sequence stays
-- contiguous (036 / 037 / 038 / future), and (b) so a future
-- "rotate the csrf secret" operator action lands as 039+ rather
-- than reusing this slot. The body is intentionally a no-op.

BEGIN;

-- Intentionally empty. See header comment.

COMMIT;
