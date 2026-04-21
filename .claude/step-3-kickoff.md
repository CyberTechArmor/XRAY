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
on each row). This step:

1. Drop `platform.dashboards.fetch_headers` (and the migration-017
   trigger on it) once a zero-row guard query passes.
2. Delete the `if (dashboard.integration) { JWT } else { fetch_headers }`
   branches in all three render call sites — authed render, public-share
   render, admin preview. After this step there is only the JWT path.
3. Remove the now-dead **Auth Bearer Token** and **Headers (JSON)**
   fields from the admin dashboard builder (`frontend/bundles/general.json`).
4. Drop `encryptJsonField`/`decryptJsonField` call sites that referenced
   `fetch_headers`. The helper itself stays — `connections.connection_details`
   and future columns may want it.
5. Decide whether `dashboards.fetch_body` is still used. If only legacy
   dashboards set it and all are now on the JWT path, drop it too.
   Otherwise leave it alone.

## State from prior sessions

Step 2 shipped on branch `claude/xray-tenant-capture-9Wk1p`. Read
`CONTEXT.md` at the repo root for the full handoff. Summary of what's
left for step 3 to assume:

- **New env var `N8N_BRIDGE_JWT_SECRET`** is required to boot. Already
  handled by `install.sh` and `update.sh`. Don't remove it in this step.
- **Three new columns on `platform.dashboards`** — `template_id TEXT`,
  `integration TEXT`, `params JSONB NOT NULL DEFAULT '{}'`. Migration
  018 is live; leave these alone (they are the JWT-path inputs).
- **Render branching lives at three call sites** — all three check
  `dashboard.integration` and fall back to `fetch_headers` when null.
  After your cutover-safety check passes, collapse all three to the
  JWT-only path.
- **Migration 017's triggers** — `enforce_enc_dashboards_fetch_headers`
  (+ its function `platform.require_enc_dashboards_fetch_headers`) must
  be dropped in the same migration that drops the column. The trigger
  function's own dropping is already in the migration-017 down migration
  — cross-reference it so you don't leave dangling objects.
- **Admin UI bridge card** — already live in `frontend/bundles/general.json`
  (`views.admin_builder`). `build-integration`, `build-template-id`,
  `build-bridge-params` input IDs. Save payload includes `integration`,
  `templateId`, `params`. Keep those. Remove `build-auth-token` and
  `build-headers` in this step.
- **Portability export/import** column list for dashboards includes the
  three new columns. Drop `fetch_headers` from that list when you drop
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
set its `integration` (via the admin UI's n8n Bridge card) or
archive/delete it, then rerun the check.

## Design commitments that apply to step 3

- **Migration 019** is the home for the column drop + trigger drop.
  Additive-only schema-changes are done; this is the first destructive
  one in the bridge arc. Stage it explicitly: migration 019 up drops
  the column, migration 019 down recreates it as nullable JSONB with
  no trigger (the trigger and its function stay dropped, because by
  then all code writes via the JWT path).
- **`withClient` vs `withTenantContext`** — still out of scope. That's
  step 6. Only touch what you're editing for this cutover.
- **Do NOT remove the plaintext-read fallback in `encrypted-column.ts`**
  this session. Independent cleanup, tracked under CONTEXT step 1.
- **Do NOT introduce a global `dashboard_templates` table yet.**
  `template_id` stays opaque TEXT. Global-template modeling is a
  separate step after 5; step 3 is just schema cleanup, not redesign.

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

1. `npm test` — green (no regressions in the 18 existing specs).
2. `npm run build` — clean.
3. `psql` shows `platform.dashboards.fetch_headers` gone:
   ```
   \d platform.dashboards
   ```
4. No grep hits for `fetch_headers` in `server/src/` or
   `frontend/bundles/general.json` outside of migration files and
   CONTEXT.md.
5. A rendered JWT-path dashboard still works end-to-end.

If the cutover-safety check on the VPS shows unconverted dashboards
and you cannot reach the operator to opt them in, STOP and surface
it. Don't silently archive production rows.
