# XRay VPS Bridge — Step 4b kickoff

Paste this as the next session's opening prompt.

---

## Role

You are implementing one step of the bridge to capture paying XRay
tenants on the current VPS before an on-prem migration. Step 4
shipped the OAuth groundwork (platform.integrations catalog,
per-tenant OAuth/API-key state, scheduler, pipeline RS256 JWT,
tenant-facing pill + Connect modal). This step — 4b — tackles the
Global-vs-Tenant Dashboard redesign that was deliberately scoped out
of step 4.

## Current step

**Step 4b — Global Dashboards: define a dashboard once, every tenant
renders it under their own OAuth/API-key credentials.**

The operator's definition, captured verbatim from the planning
conversation: *"Global dashboard means it is replicated for all users
but utilizes each individual tenant's oauth/custom auth."*

Practically: the dashboard builder gains a primary picker — **Global
Dashboard** vs **Tenant Dashboard**. Global rows live once and render
N times (once per tenant with the matching integration connected).
Tenant rows are the existing per-row model.

## State from step 4

Read CONTEXT.md at the repo root for the full handoff. Summary of what
step 4b inherits:

- **`platform.integrations`** catalog exists, admin-managed. Each row
  advertises `supports_oauth` / `supports_api_key` and stores provider
  OAuth app config. Empty at ship; admin populates as HCP/QBO
  approvals land.
- **`platform.connections`** carries per-tenant OAuth/API-key state
  keyed on `(tenant_id, integration_id)`. Scheduler keeps tokens fresh.
- **Render path** does a pure DB read for the access token; 409
  `OAUTH_NOT_CONNECTED` when the tenant hasn't connected. Global
  dashboards will resolve tokens under the *rendering* tenant's row,
  not the dashboard-owning tenant. The existing resolver
  (`integration.service.resolveAccessTokenForRender(tenantId,
  integrationSlug)`) already takes `tenantId` as an explicit argument,
  so Global rendering is just "pass the rendering tenant's id" — no
  rework needed in the token layer.
- **Bridge JWT** carries `auth_method` (`oauth|api_key`) + `access_token`
  per render. 4b doesn't touch the claim shape.
- **Pipeline JWT** (RS256, `aud='xray-pipeline'`) still minted per
  render. `sub`/`tenant_id` on Global renders must point at the
  rendering tenant, not the dashboard-owning tenant.
- **`dashboards.tenant_id NOT NULL`** today. The current render SELECT
  gates `WHERE d.tenant_id = $1` for non-platform-admin users. That
  constraint is the main piece 4b has to redesign.

## Product surface

Dashboard builder gets a new primary selector:

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

- **Global → Integration required.** Custom is allowed but a Global
  Custom dashboard only makes sense if every rendering tenant can
  run the same static HTML with no per-tenant data pull.
- **Tenant → Integration optional.** Identical to today's tenant-row
  behavior.
- **Who can create Global rows?** Platform admin only. A tenant user
  creating a dashboard gets only the Tenant scope; the Global radio
  is hidden.

## Open design questions — step 4b's plan phase must decide these

1. **Schema shape.** Two viable paths:
   - **(a) Column on `platform.dashboards`:** add `scope TEXT CHECK
     (scope IN ('tenant','global')) NOT NULL DEFAULT 'tenant'` plus
     make `tenant_id` nullable for global rows. Keeps everything in
     one table; render-path JOINs stay simple. Downside: migrations
     that currently assume `tenant_id NOT NULL` get untrustworthy.
   - **(b) New `platform.dashboard_templates` table:** Global rows
     live there; tenant rows stay in `platform.dashboards`. Render
     path picks the source table based on a URL prefix or a
     discriminator. Cleaner separation; more code paths.
   - Recommendation (to validate in plan phase): **(a)** — simpler,
     matches the "one kind of dashboard, two scopes" mental model,
     and the render path already has one SELECT that can branch.
2. **`bridge_secret` ownership for Global rows.** Three options:
   - One platform-global secret signing every Global render.
   - Per-(dashboard, tenant) secret (new table, row-per-tenant the
     first time they render).
   - Per-dashboard secret shared across rendering tenants.
   - Recommendation: **per-dashboard, shared across tenants.** Matches
     today's per-row model; a leaked Global dashboard secret still
     affects only that one dashboard (spread across N tenants, but
     one integration's worth of blast radius).
3. **Permissions model for Global rendering.** Options:
   - Implicit — every tenant sees every active Global dashboard.
   - Assignment — platform admin picks which tenants see which Global
     dashboards. New table `platform.dashboard_tenant_grants` keyed
     on `(dashboard_id, tenant_id)`.
   - Integration-gated — a tenant sees a Global dashboard only if
     they have an active connection for its integration.
   - Recommendation: **integration-gated for default visibility, with
     optional per-tenant grants for Custom Globals.** Keeps the "you
     see what you can render" heuristic intuitive.
4. **View count / billing attribution.** Does a Global dashboard view
   count against the rendering tenant's dashboard_limit? How are
   `platform.dashboard_views` rows scoped? Likely: each render inserts
   one view row with `dashboard_id` + `user_id` (existing schema) —
   no change — and `billing_state.dashboard_limit` treats Global
   dashboards as not-counted against limits (they're free-to-view for
   every tenant).
5. **Rendered HTML cache.** Today `view_html` / `view_css` / `view_js`
   cache the last successful render on the dashboard row. Global
   rendering for N tenants makes that racy — tenant A's render
   overwrites tenant B's cache, and the per-tenant OAuth token + data
   differ. **Move to a new `platform.dashboard_render_cache` table
   keyed on `(dashboard_id, tenant_id)`.** The existing columns on
   `dashboards` stay for tenant-scoped rows only.
6. **First-render OAuth prompt for Global dashboards.** The step-4
   Connect modal fires when a tenant's connection is missing or
   broken. A Global dashboard's first-render for a new tenant is
   exactly that case — the resolver returns `not_connected`, the
   render returns 409, the frontend opens the modal. **This is already
   wired.** No 4b work needed.
7. **Portability for Global rows.** Today's export is tenant-scoped.
   Globals are platform-level. Decision: Global dashboards ship as a
   separate platform-level export (or skip export entirely — they're
   reproducible from source control). Decide in plan phase.

## Constraints 4b must respect (landed in step 4)

- `platform.integrations` slugs are the stable integration identifiers
  — reference them, don't redefine.
- `X-XRay-Pipeline-Token` header contract stays as-is.
- Two-stage migration convention: Global-tables are additive
  (pre-rebuild); making `dashboards.tenant_id` nullable if you pick
  path (a) also goes pre-rebuild because it's additive-not-destructive.
- No per-tenant RS256 keys. Pipeline JWT stays platform-wide.
- Bridge JWT claim keys stay stable. If Global rendering needs a new
  signal, add a claim, don't rename.
- Scheduler + OAuth-tokens + pipeline-jwt libs stay untouched. They
  already accept `tenantId` as an explicit arg.

## Working agreement

1. Read CONTEXT.md (step-4 handoff), this kickoff, and
   `.claude/pipeline-hardening-notes.md`.
2. Plan → wait for approval → implement in small commits.
3. **Surface the seven open design questions above explicitly in the
   plan.** Don't decide them silently in code.
4. Acceptance checks:
   - `npm test` green (68 baseline, expect +N specs for Global render
     branch + scope column / dashboard_templates table + per-tenant
     render cache).
   - `npm run build` clean.
   - A Global dashboard renders under tenant A's credentials, then
     under tenant B's credentials, with distinct access tokens,
     distinct `sub`/`tenant_id` on both bridge and pipeline JWTs,
     distinct `jti`s, and the cached HTML lives per-(dashboard, tenant)
     rather than overwriting.
   - An unauthorized tenant (no matching OAuth connection, or no
     grant if the assignment model wins) sees the Connect modal on
     click instead of the dashboard rendering.
   - Tenant dashboards still work exactly as they do today.
5. Update CONTEXT.md with the step-4b handoff and either advance to
   step 5 (tenant onboarding / Stripe polish) or surface whatever
   got deferred.

## Branch

Develop on `claude/xray-step-4b-global-dashboards-<suffix>` off main
once step 4's PR merges.

## What step 4b must NOT do

- Touch the OAuth catalog (`platform.integrations`) schema.
- Rename bridge JWT or pipeline JWT claim keys.
- Drop or rename `X-XRay-Pipeline-Token`.
- Collapse the four `via` values.
- Land the pipeline DB side of Model J (still post-step-6).
- Fold Stripe / tenant onboarding polish in (that's step 5).
- Introduce per-tenant RS256 keys.
