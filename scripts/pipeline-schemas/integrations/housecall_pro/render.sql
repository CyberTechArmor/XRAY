-- housecall_pro_render_version: 2026-04-30-1
--
-- Render template for the HouseCall Pro dashboard read path.
-- n8n's render workflow fetches this verbatim and runs it as the
-- per-click query against the pipeline DB.
--
-- ── n8n binding contract ───────────────────────────────────────
--
--   Query Parameters:
--     $1 = {{ $json.jwtPayload.tenant_id }}
--          UUID claim from the verified render JWT — gates RLS
--          via app.current_tenant. Must come from the JWT, never
--          from the request body.
--
--   Postgres node options:
--     - Operation:                  Execute Query
--     - Replace Empty Strings with NULL: ON
--          Empty strings in TEXT columns ("") otherwise come back
--          as "" instead of null and dashboard JS ternary
--          fallbacks misbehave. Required.
--
-- ── Shape of the wrapper ──────────────────────────────────────
--
-- BEGIN / SET LOCAL / COMMIT bracket the SELECT so the GUC is
-- transaction-scoped — pooled connections can't leak the tenant
-- context to the next request, and RLS is forced FORCE ROW LEVEL
-- SECURITY on the table so a missing or wrong context returns
-- zero rows rather than cross-tenant data.
--
-- Bump the version header on every change. Same convention as
-- schema.sql:
--
--   YYYY-MM-DD-N where N starts at 1 each day and increments per
--   change in that day. e.g. "2026-04-30-1", "2026-04-30-2".

BEGIN;
SET LOCAL app.current_tenant = $1;

SELECT * FROM housecall_pro.jobs;

COMMIT;
