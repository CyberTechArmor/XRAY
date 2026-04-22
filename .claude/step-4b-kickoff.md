# XRay VPS Bridge — Step 4b kickoff

Paste this as the next session's opening prompt.

---

## Role

You are implementing one step of the bridge to capture paying XRay
tenants on the current VPS before an on-prem migration. Step 4
shipped the OAuth groundwork (platform.integrations catalog,
per-tenant OAuth/API-key state, scheduler, pipeline RS256 JWT,
tenant-facing pill + Connect modal). This step — 4b — has three
concerns, in order of priority:

1. **Fix the builder Integration dropdown** (step-4 loose end).
2. **Global vs Tenant dashboards** (the original 4b scope).
3. **n8n-owned sync fan-out** — expose a per-integration fan-out
   endpoint so n8n workflows can schedule tenant-wide syncs without
   XRay owning a second cron.

Items 1 and 3 are small and concrete. Item 2 is the architectural
redesign. Ship them in that order in separate commits; they're
mostly independent.

## Current step

**Step 4b — Global Dashboards + fan-out + dropdown fix.**

Operator's definition of Global, captured verbatim from the planning
conversation: *"Global dashboard means it is replicated for all users
but utilizes each individual tenant's oauth/custom auth."*

Practically: the dashboard builder gains a primary picker — **Global
Dashboard** vs **Tenant Dashboard**. Global rows live once and render
N times (once per tenant with the matching integration connected).
Tenant rows are the existing per-row model.

And: n8n, not XRay, owns the sync cron. XRay exposes a fan-out
endpoint that n8n hits on its own schedule; XRay responds by POSTing
once per connected tenant to the n8n workflow URL the caller supplied,
with the tenant's live access token already resolved.

## State from step 4

Read CONTEXT.md at the repo root for the full handoff. Summary of what
step 4b inherits:

- **`platform.integrations`** catalog exists, admin-managed. Each row
  advertises `supports_oauth` / `supports_api_key` and stores provider
  OAuth app config. Empty at ship; admin populates as HCP/QBO
  approvals land.
- **`platform.connections`** carries per-tenant OAuth/API-key state
  keyed on `(tenant_id, integration_id)`. Scheduler keeps tokens fresh.
- **Render path** does a pure DB read for the access token via
  `integration.service.resolveAccessTokenForRender(tenantId, slug)`,
  which already handles both OAuth and API-key connections and
  returns `{ kind, accessToken, authMethod }`. Global rendering is
  "pass the rendering tenant's id" — no rework in the token layer.
- **Bridge JWT** carries `auth_method` (`oauth|api_key`) + `access_token`
  per render. 4b doesn't touch the claim shape.
- **Pipeline JWT** (RS256, `aud='xray-pipeline'`) still minted per
  render. `sub`/`tenant_id` on Global renders must point at the
  rendering tenant, not the dashboard-owning tenant.
- **`dashboards.tenant_id NOT NULL`** today. The current render SELECT
  gates `WHERE d.tenant_id = $1` for non-platform-admin users. That
  constraint is the main piece Global dashboards have to redesign.
- **OAuth access-token refresh** (`oauth-scheduler.ts`, 5-min tick)
  stays exactly as-is. It refreshes tokens so they're already fresh
  when fan-out or render resolves them. 4b does not touch it.

## Product surface

### Builder: top-level scope selector

Dashboard builder gets a new primary selector at the very top of the
form, above the existing Dashboard details card:

```
┌──────────────── New dashboard ─────────────────┐
│                                                │
│  Scope:  (•) Global Dashboard                  │
│          ( ) Tenant Dashboard                  │
│                                                │
│  Integration:  [ HouseCall Pro ▼ ]             │
│                [ Custom (no auth)  ]           │
│                                                │
│  [ if Tenant: open tenant-picker modal         │
│    - paginated, searchable                     │
│    - shows tenant name + owner + email         │
│    - pick one to scope the dashboard to ]      │
│                                                │
└────────────────────────────────────────────────┘
```

Rules:

- **Global → Integration required** (Custom allowed only if every
  rendering tenant can run the same static HTML with no per-tenant
  data pull).
- **Tenant → Integration optional.** Identical to today's tenant-row
  behavior.
- **Who can create Global rows?** Platform admin only. A tenant user
  creating a dashboard sees only Tenant; the Global radio is hidden.

### Fan-out endpoint — `POST /api/integrations/:slug/fan-out`

Dispatcher for n8n-owned sync schedules. Caller auth: a shared webhook
secret (per integration, stored encrypted on the catalog row). Never
a user JWT.

Request body:

```json
{
  "target_url": "https://n8n.cybertech.app/webhook/<sync-workflow>",
  "window": { "since": "2026-04-21T00:00:00Z" },
  "metadata": { "arbitrary": "passthrough" }
}
```

Behavior:

- Select every `platform.connections` row where
  `integration_id = (integrations.slug = :slug).id AND status='active'`.
- For each connected tenant, call `resolveAccessTokenForRender(...)`.
  Rows returning `needs_reconnect` / `not_connected` are skipped and
  surfaced in the summary.
- POST a signed envelope to `target_url` once per tenant:

  ```json
  {
    "fan_out_id": "<uuid>",
    "integration_slug": "housecall_pro",
    "tenant_id": "<uuid>",
    "tenant_slug": "acme",
    "auth_method": "oauth",
    "access_token": "<decrypted access token>",
    "window": { "since": "2026-04-21T00:00:00Z" },
    "metadata": { "arbitrary": "passthrough" }
  }
  ```

  Signed with an HS256 JWT header `X-XRay-FanOut-Token` (claim shape
  mirrors the bridge JWT; `aud='n8n-fan-out'`; 60s TTL). Workflow
  verifies before consuming.

- Bounded parallelism (start at 5; configurable per integration row).
- Per-target retry policy: 3 attempts, exponential backoff, dead after
  that. Record outcomes on a new `platform.fan_out_runs` table for
  observability (one row per fan_out_id; nested
  `platform.fan_out_deliveries` keyed on (fan_out_id, tenant_id) for
  per-tenant status).
- Idempotency key per delivery: `sha256(fan_out_id || tenant_id)` so
  n8n can replay without double-landing rows on the provider side.

Response from fan-out endpoint (synchronous, returns as soon as all
deliveries enqueue):

```json
{
  "fan_out_id": "<uuid>",
  "dispatched": 14,
  "skipped_needs_reconnect": 2,
  "skipped_inactive": 1,
  "skipped_integration_missing": 0
}
```

Admin surface: on each integration row in the Integrations tab,
surface "Last fan-out: N dispatched, M skipped, at <timestamp>" pulled
from `platform.fan_out_runs`. Read-only in 4b.

### Builder Integration dropdown — populate it

Step-4 loose end. The dashboard builder's existing
`<select id='build-integration'>` and `<button id='btn-build-connect'>`
in the `n8n Bridge (JWT auth)` card ship unwired:

- The `<select>` only contains the baked-in `<option value="">Custom
  (no auth)</option>` — no JS ever populates it from the catalog.
- The Connect button next to it has no click handler.

Fix:

- On `admin_builder` mount, call the existing
  `__xrayFetchIntegrations()` (already in `frontend/app.js` at ~line
  1166) and append one `<option value="{slug}">{display_name}</option>`
  per active catalog entry.
- On selection, show the per-tenant status line (`connected` /
  `needs_reconnect` / `not_connected`) by calling
  `__xrayIntegrationStatus(slug)`.
- Wire `btn-build-connect` to `__xrayOpenConnectModal(slug, onConnected)`
  where `onConnected` refreshes the status line.
- When Scope=Global is selected and the form is being edited by a
  platform admin, the dropdown is for routing only — the status pill
  is hidden (admin may not have a connection themselves; per-tenant
  status is irrelevant for authoring).

Tests: a Vitest spec that mounts the builder, stubs
`/api/connections/my-integrations` with two active rows, and asserts
both appear as options.

## Open design questions — step 4b's plan phase must decide these

1. **Schema shape for Globals.** Two viable paths:
   - **(a) Column on `platform.dashboards`:** add `scope TEXT CHECK
     (scope IN ('tenant','global')) NOT NULL DEFAULT 'tenant'` plus
     make `tenant_id` nullable for Global rows. Keeps everything in
     one table; render-path JOINs stay simple. Downside: migrations
     that assume `tenant_id NOT NULL` get untrustworthy.
   - **(b) New `platform.dashboard_templates` table:** Global rows
     live there; tenant rows stay in `platform.dashboards`. Render
     picks source table based on a discriminator. Cleaner separation;
     more code paths.
   - Recommendation (to validate in plan phase): **(a)** — simpler,
     matches "one kind of dashboard, two scopes" mental model, and the
     render path already has one SELECT that can branch.
2. **`bridge_secret` ownership for Global rows.**
   - One platform-global secret / per-(dashboard, tenant) / per-dashboard.
   - Recommendation: **per-dashboard, shared across rendering tenants.**
     Matches today's per-row model; blast radius on a leak stays at
     "one dashboard, spread across N tenants."
3. **Permissions model for Global rendering.**
   - Implicit / assignment / integration-gated.
   - Recommendation: **integration-gated by default, with optional
     per-tenant grants for Custom Globals.**
4. **View count / billing attribution.** Does a Global render count
   against the rendering tenant's `dashboard_limit`?
   - Likely: existing `platform.dashboard_views` row per render — no
     schema change — and `billing_state.dashboard_limit` does NOT
     count Global dashboards. Globals are free-to-view.
5. **Rendered HTML cache.** Today `view_html` / `view_css` / `view_js`
   cache the last render on the dashboard row. Global rendering for
   N tenants makes that racy — tenant A overwrites tenant B. **Move
   to `platform.dashboard_render_cache` keyed on (dashboard_id,
   tenant_id).** Columns on `dashboards` stay for tenant-scoped rows.
6. **First-render OAuth prompt for Globals.** Already wired — 4-step
   flow: resolver → `not_connected` → 409 → Connect modal. No new
   work.
7. **Portability for Global rows.** Today's export is tenant-scoped;
   Globals are platform-level. Decide: separate platform-level export
   endpoint, or skip (reproducible from source control).
8. **Fan-out webhook secret storage.** Add a column on
   `platform.integrations` (`fan_out_secret`, encrypted with the same
   envelope scheme as other credentials) so each integration has its
   own n8n shared secret. Admin UI adds a "Generate / rotate fan-out
   secret" button (shown once, copied to clipboard, never shown again
   — same UX as the existing bridge secret).

## Constraints 4b must respect (landed in step 4)

- `platform.integrations` slugs are stable identifiers — reference
  them, don't redefine. (Adding columns like `fan_out_secret` and
  `fan_out_parallelism` is fine; renaming anything is not.)
- `X-XRay-Pipeline-Token` header contract stays as-is.
- Two-stage migration convention: new tables (`fan_out_runs`,
  `fan_out_deliveries`, `dashboard_render_cache`, maybe
  `dashboard_tenant_grants`) are additive → pre-rebuild. Making
  `dashboards.tenant_id` nullable if you pick path (a) is also
  pre-rebuild because it's additive-not-destructive.
- No per-tenant RS256 keys. Pipeline JWT stays platform-wide.
- Bridge JWT claim keys stay stable. Fan-out JWT is a new claim set
  (`aud='n8n-fan-out'`), separate from bridge (`aud='n8n'`) and
  pipeline (`aud='xray-pipeline'`) — don't collapse them.
- Scheduler + OAuth-tokens + pipeline-jwt libs stay untouched. Fan-out
  shares the `resolveAccessTokenForRender` resolver.

## Working agreement

1. Read CONTEXT.md (step-4 handoff), this kickoff, and
   `.claude/pipeline-hardening-notes.md`.
2. Plan → wait for approval → implement in small commits, one concern
   per commit: (i) dropdown fix + test, (ii) fan-out endpoint + lib +
   tests + admin UI row, (iii) Global dashboards schema + builder +
   render-path + render-cache + tests.
3. **Surface the eight open design questions above explicitly in the
   plan.** Don't decide them silently in code.
4. Acceptance checks:
   - `npm test` green (68 baseline, expect +N specs for fan-out,
     Global render branch, per-tenant render cache, dropdown populate).
   - `npm run build` / `tsc --noEmit` clean.
   - **Global dashboards:** a Global renders under tenant A's
     credentials, then under tenant B's, with distinct access tokens,
     distinct `sub`/`tenant_id` on both bridge and pipeline JWTs,
     distinct `jti`s, and per-(dashboard, tenant) cached HTML.
   - **Unauthorized tenant:** no matching connection (or no grant
     where the assignment model applies) → Connect modal on click,
     not a dashboard render.
   - **Tenant dashboards:** still work exactly as they do today.
   - **Fan-out:** `POST /api/integrations/:slug/fan-out` with the
     shared secret produces N deliveries to the target URL, each with
     a signed envelope whose `tenant_id` matches its
     `access_token`'s owning connection. Replays with the same
     idempotency key are deduped.
   - **Dropdown:** HouseCall Pro (or any active catalog entry)
     appears in the builder's Integration dropdown; Connect button
     fires the step-4 modal.
5. Update CONTEXT.md with the step-4b handoff and either advance to
   step 5 (tenant onboarding / Stripe polish) or surface whatever
   got deferred.

## Branch

Develop on `claude/xray-step-4b-global-dashboards-<suffix>` off main
once step 4's PR merges.

## What step 4b must NOT do

- Touch the OAuth catalog (`platform.integrations`) schema beyond
  additive columns for fan-out config.
- Rename bridge JWT or pipeline JWT claim keys.
- Drop or rename `X-XRay-Pipeline-Token`.
- Collapse the four `via` values, or merge bridge / pipeline / fan-out
  JWT audiences.
- Land the pipeline DB side of Model J (still post-step-6).
- Fold Stripe / tenant onboarding polish in (that's step 5).
- Introduce per-tenant RS256 keys.
- Move OAuth token refresh out of XRay — the 5-min
  `oauth-scheduler.ts` stays. Fan-out is a *separate* concern from
  token refresh; both coexist.
- Make fan-out a cron inside XRay. n8n owns the schedule; XRay only
  dispatches when called.
