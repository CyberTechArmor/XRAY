-- housecall_pro_select_version: 2026-04-30-1
--
-- Templated SELECT for the HouseCall Pro dashboard read path.
-- The integration's "Pipeline table" admin field substitutes
-- {{table}} client-side at Copy time — set the table name in
-- Admin → Integrations → Edit before copying.
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
-- ── Wrapper ────────────────────────────────────────────────────
--
-- BEGIN / SET LOCAL / COMMIT bracket the SELECT so the GUC is
-- transaction-scoped — pooled connections can't leak the tenant
-- context, and FORCE ROW LEVEL SECURITY on the table returns zero
-- rows on a missing or wrong context rather than cross-tenant
-- data.
--
-- Bump the version header on every change. Same convention as
-- schema.sql:
--
--   YYYY-MM-DD-N where N starts at 1 each day and increments per
--   change in that day. e.g. "2026-04-30-1", "2026-04-30-2".

BEGIN;
SET LOCAL app.current_tenant = $1;

SELECT * FROM housecall_pro.{{table}};

COMMIT;
