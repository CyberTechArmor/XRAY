-- Migration 035: per-email-24h auth attempts ledger.
--
-- Backs the per-user-id rate-limit tier introduced in step 9. Every
-- /api/auth/* attempt (verify, passkey, totp/verify) inserts a row
-- here with email_lower, IP hash, and a success boolean. The
-- middleware queries:
--
--   SELECT count(*) FROM platform.auth_attempts
--    WHERE email_lower = $1
--      AND attempted_at > NOW() - INTERVAL '24 hours'
--      AND success = false;
--
-- 20 failures in the last 24h triggers a hard 429 with retry-after.
-- The "≤10 remaining" banner threshold is computed in the same
-- middleware and surfaced via the response body so the auth modal
-- can render the warning.
--
-- DB-backed (not in-memory) so the counter survives container
-- restarts — kickoff acceptance: "21 login attempts from the same
-- email in 24h → 21st rejected with retry-after." An LRU would
-- forget on every redeploy, which is the wrong default for a
-- security counter.
--
-- No RLS on this table — the counter runs pre-tenant-context
-- (rate-limit middleware sits before any session is established).
-- Access is via withAdminClient from the rate-limit middleware so
-- no addition to the withClient allow-list is needed.
--
-- email_lower is stored verbatim (canonicalised lower-cased). It is
-- the same key the auth flow already accepts — not a privacy
-- regression vs. existing platform.users.email storage.
--
-- ip_hash is sha256(ip_address || server_secret) so we never log
-- raw IPs to this table. Passed in by the middleware; nullable so
-- code paths that don't have an IP (tests) can still record the
-- attempt.
--
-- Index on (email_lower, attempted_at) to keep the count() lookup
-- index-only.
--
-- Retention: rows older than 7 days are pruned on a best-effort
-- schedule by the application (hourly tick; see middleware/
-- per-user-rate-limit.ts). The 24h window is the only enforcement
-- horizon — the 7-day retention is purely for forensic audit on a
-- security-incident review.
--
-- Idempotent.

BEGIN;

CREATE TABLE IF NOT EXISTS platform.auth_attempts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email_lower   TEXT NOT NULL,
  attempted_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ip_hash       TEXT,
  success       BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS idx_auth_attempts_email_at
  ON platform.auth_attempts (email_lower, attempted_at DESC);

-- No RLS — pre-tenant-context lookup path.

COMMIT;
