# XRay VPS Bridge — Step 3 kickoff

Paste this as the next session's opening prompt.

---

## Role

You are implementing one step of a five-step bridge to capture paying
XRay tenants on the current VPS before an on-prem migration. The full
plan is in the original session prompt. Hold it in context so your
choices in this step don't paint future steps into a corner.

## Current step

**Step: 3 — schema refactor: drop `dashboards.fetch_headers`, remove
the legacy auth branch, clean up the admin UI.**

By the time this step runs, every dashboard the VPS cares about should
already be on the JWT bridge path (step 2's `integration` column set
AND `bridge_secret` populated). This step:

1. Drop `platform.dashboards.fetch_headers` (and the migration-017
   trigger on it) once a zero-row guard query passes.
2. Delete the `if (dashboard.integration) { JWT } else { fetch_headers }`
   branches in all three render call sites — authed render, public-share
   render, admin preview. After this step there is only the JWT path.
3. Remove the now-dead **Auth Bearer Token** and **Headers (JSON)**
   fields from the admin dashboard builder (`frontend/bundles/general.json`).
4. Drop the `fetch_headers`-specific calls to `encryptJsonField` /
   `decryptJsonField`. The helpers themselves stay — `connections.connection_details`
   and `dashboards.bridge_secret` still use `encryptSecret` /
   `decryptSecret`, and future columns may want the JSONB variant.
5. Decide whether `dashboards.fetch_body` is still used. If only legacy
   dashboards set it and all are now on the JWT path, drop it too.
   Otherwise leave it alone.

## State from prior sessions

Step 2 shipped on branch `claude/xray-tenant-capture-9Wk1p`. Read
`CONTEXT.md` at the repo root for the full handoff. Summary of what's
left for step 3 to assume:

- **No platform-wide env var for the bridge.** The HS256 signing secret
  is per-dashboard (`platform.dashboards.bridge_secret`, encrypted at
  rest under `enc:v1:`), enforced by the trigger added in migration
  019. Don't try to centralize it.
- **Four new columns on `platform.dashboards`** — `template_id TEXT`,
  `integration TEXT`, `params JSONB NOT NULL DEFAULT '{}'`,
  `bridge_secret TEXT`. Migrations 018 and 019 are live.
- **Render branching lives at three call sites** — all three check
  `dashboard.integration` and fall back to `fetch_headers` when null.
  After your cutover-safety check passes, collapse all three to the
  JWT-only path. The `bridge_secret` fetch/decrypt pattern stays —
  `fetchBridgeSecretCiphertext(dashboardId)` in
  `server/src/services/dashboard.service.ts` is the canonical fetch.
- **Migration 017's trigger on `fetch_headers`** (and its function
  `platform.require_enc_dashboards_fetch_headers`) must be dropped in
  the same migration that drops the column. Reuse the drop-commands
  already in migrations/down/017 for the wording.
- **Admin UI bridge card** — already live in `frontend/bundles/general.json`
  (`views.admin_builder`). `build-integration`, `build-template-id`,
  `build-bridge-params`, `build-bridge-secret` input IDs. Save payload
  includes `integration`, `templateId`, `params`, `bridgeSecret`. Keep
  those. Remove `build-auth-token` and `build-headers` in this step.
- **Portability export/import** column list for dashboards includes the
  four new columns. Drop `fetch_headers` from that list when you drop
  the column.

## Cutover-safety check before dropping the column

Do NOT drop `fetch_headers` until this returns zero rows:

```sql
SELECT id, tenant_id, name
  FROM platform.dashboards
 WHERE status = 'active'
   AND (integration IS NULL OR integration = '')
   AND fetch_url IS NOT NULL;
```

Any row that comes back is a dashboard still on the legacy path. Either
set its `integration` + `bridge_secret` (via the admin UI's n8n Bridge
card) or archive/delete it, then rerun the check.

Also check the secret-presence invariant:

```sql
SELECT id, tenant_id, name
  FROM platform.dashboards
 WHERE integration IS NOT NULL AND integration <> ''
   AND (bridge_secret IS NULL OR bridge_secret = '');
```

Must be empty. If not, the pre-migration-019 code (which allowed
integration without a secret) left orphans — fix them through the
admin UI before step 3 lands.

## Design commitments that apply to step 3

- **The bridge JWT now carries a rich claim set** (added in the
  interlude session between step 2 and step 3 — see CONTEXT.md). When
  you collapse the render branches, preserve every existing call to
  `mintBridgeJwt` with all its current fields intact: `tenant_*`,
  `dashboard_*`, `user_*`, `isPlatformAdmin`, `params`, and — most
  importantly — the per-call-site `via` value. The `via` values today
  are `authed_render`, `admin_impersonation` (computed in
  `dashboard.routes.ts` when `is_platform_admin && dashboard.tenant_id
  !== req.user.tid`), `public_share`, and `admin_preview`. Step 3's
  cutover must not collapse these four into one or lose the
  `admin_impersonation` branch — they are the SOC 2 impersonation
  trail.
- **The authed render SELECT now JOINs `platform.tenants` + LEFT JOINs
  `platform.users` + `platform.roles`.** Keep the JOINs; they feed the
  tenant/user labels the JWT now emits. Same JOIN shape is in
  `admin.service.ts:fetchDashboardContent` and a sibling helper
  `fetchTenantLabels(tenantId)` lives in `dashboard.service.ts`.
- **Migration 020** is the home for the column drop + trigger drop
  (017's `fetch_headers` trigger). First destructive migration in the
  bridge arc. Stage it explicitly: up drops the column + trigger,
  down recreates the column as nullable JSONB with no trigger (the
  trigger and function stay dropped — by then all code writes via the
  JWT path).
- **`withClient` vs `withTenantContext`** — still out of scope. That's
  step 6. Only touch what you're editing for this cutover.
- **Do NOT remove the plaintext-read fallback in `encrypted-column.ts`**
  this session. Independent cleanup.
- **Do NOT introduce a global `dashboard_templates` table yet.**
  `template_id` stays opaque TEXT. Global-template modeling is after
  step 5.
- **Keep `bridge_secret` redaction in `decryptDashboardRow`.** That's
  the invariant that stops the secret from ever landing in an API
  response; step 3 must not weaken it when it simplifies the render
  paths.

## Working agreement for this session

Identical to prior sessions: read the repo first, confirm understanding
against CONTEXT.md, produce a plan, wait for approval, implement in
small commits, run the acceptance check, update CONTEXT.md, write the
step-4 kickoff prompt. Step 4 is OAuth `access_token` population — make
sure nothing you do here makes that harder (e.g. don't rename claim
keys, don't remove the `params` column, don't collapse the three
render call sites into one that loses the per-call-site audit
metadata).

## Acceptance check for step 3

1. `npm test` — green (no regressions in the 24 existing specs; 12 in
   `encrypted-column.test.ts`, 12 in `n8n-bridge.test.ts`).
2. `npm run build` — clean.
3. `psql` shows `platform.dashboards.fetch_headers` gone and the
   `enforce_enc_dashboards_fetch_headers` trigger dropped:
   ```
   \d platform.dashboards
   SELECT trigger_name FROM information_schema.triggers WHERE trigger_name LIKE 'enforce_enc_dashboards_%';
   ```
4. No grep hits for `fetch_headers` in `server/src/` or
   `frontend/bundles/general.json` outside of migration files and
   CONTEXT.md.
5. A rendered JWT-path dashboard still works end-to-end on the VPS.
6. Cutover-safety queries (both of them, above) return zero rows.

If the cutover-safety checks on the VPS show unconverted dashboards
and you cannot reach the operator to opt them in, STOP and surface
it. Don't silently archive production rows.
