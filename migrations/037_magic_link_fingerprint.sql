-- Migration 037: bind magic_links to issuing IP+UA fingerprint.
--
-- Step-10 anti-replay measure. When sendMagicLink / initiateLogin /
-- initiateSignup issues a code, we hash the issuing request's
-- IP + User-Agent and store them on the row. On consume, we
-- recompute the hashes from the consuming request and reject
-- mismatches with 400 LINK_FINGERPRINT_MISMATCH.
--
--   • issuer_ip_hash = sha256(req.ip || JWT_SECRET)
--   • issuer_ua_hash = sha256(req.headers['user-agent'] || JWT_SECRET)
--
-- The salt convention reuses step-9's auth_attempts.ip_hash shape
-- so we never persist raw IP/UA to this table.
--
-- Both columns are NULLABLE for the upgrade window — existing
-- in-flight links from before this migration deployed don't have
-- hashes and consume normally (skip-on-NULL is the upgrade-safe
-- posture). New issuance always populates. Once the deploy
-- window closes (links expire after config.magicLink.ttl), the
-- skip-on-NULL branch goes cold without a future migration to
-- enforce NOT NULL.
--
-- Independent from step-9's per-link 5-attempt counter (column
-- `attempts` + cap `max_attempts`). Both apply: a fingerprint
-- mismatch DECREMENTS attempts_remaining (eats one of the 5)
-- so a determined attacker still hits the per-link lockout.
--
-- platform.magic_links is on the carve-out (no RLS) per the
-- step-7 audit — no policy changes needed.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS.

BEGIN;

ALTER TABLE platform.magic_links
  ADD COLUMN IF NOT EXISTS issuer_ip_hash TEXT,
  ADD COLUMN IF NOT EXISTS issuer_ua_hash TEXT;

COMMIT;
