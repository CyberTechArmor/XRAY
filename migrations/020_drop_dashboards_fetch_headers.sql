-- Migration 020: drop the legacy `platform.dashboards.fetch_headers` column
-- and its migration-017 guardrail trigger. First destructive migration in
-- the VPS-bridge arc.
--
-- Precondition (enforced by the operator before this migration applies):
-- every active dashboard with a `fetch_url` has been opted onto the JWT
-- bridge (non-empty `integration` + encrypted `bridge_secret`). The two
-- cutover-safety queries in .claude/step-3-kickoff.md must both return
-- zero rows. If they don't, opt the stragglers in through the admin UI's
-- n8n Bridge card (Generate secret + set Integration) and re-run the
-- checks before deploying.
--
-- After this migration:
--   - The server code no longer reads or writes `fetch_headers` on
--     `platform.dashboards` — the JWT bridge is the only render path.
--   - `platform.connection_templates.fetch_headers` is untouched; that
--     column is a template-authoring convenience, independent of the
--     dashboards write path that migration 017 guarded.
--   - The `enforce_enc_webhooks_secret` and
--     `enforce_enc_connections_details` triggers from migration 017 stay
--     in place. Only the `fetch_headers` guardrail goes.
--
-- Idempotent: DROP TRIGGER IF EXISTS / DROP FUNCTION IF EXISTS / the
-- column drop is CASCADE-free (nothing depends on fetch_headers outside
-- the trigger we drop first). Down migration lives in migrations/down/
-- so deploy.sh's non-recursive glob does not execute it.

BEGIN;

DROP TRIGGER IF EXISTS enforce_enc_dashboards_fetch_headers ON platform.dashboards;
DROP FUNCTION IF EXISTS platform.require_enc_dashboards_fetch_headers();

ALTER TABLE platform.dashboards DROP COLUMN IF EXISTS fetch_headers;

COMMIT;
