-- Migration 048: per-integration seed URL.
--
-- Optional webhook that XRay POSTs to whenever a tenant first connects
-- to this integration (api-key + oauth paths both fire). Operator
-- configures the URL in Admin → Integrations; the receiving end (n8n
-- workflow, custom service, etc.) can use it to backfill / seed
-- additional data beyond what the dashboard render path collects.
--
-- The same fan_out_secret (migration 023) is reused for signing seed
-- POSTs when set — body is HMAC-SHA256'd into an X-XRay-Signature
-- header. When fan_out_secret is unset the POST goes out unsigned;
-- operator receivers can rely on private network / IP allowlist /
-- their own header check.
--
-- Pure additive column. No constraints — empty string is treated as
-- unset (validated application-side). Idempotent.

BEGIN;

ALTER TABLE platform.integrations
  ADD COLUMN IF NOT EXISTS seed_url TEXT;

COMMIT;
