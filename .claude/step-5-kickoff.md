# XRay VPS Bridge — Step 5 kickoff

Paste this as the next session's opening prompt.

---

## Role

You are implementing one step of the bridge to capture paying XRay
tenants on the current VPS before an on-prem migration. Step 4 shipped
the OAuth groundwork (platform.integrations catalog, per-tenant
OAuth/API-key state, scheduler, pipeline RS256 JWT). Step 4b shipped
the Global-vs-Tenant dashboard redesign, an n8n-owned fan-out
dispatcher, and the builder Integration dropdown fix.

This step — 5 — is **tenant onboarding polish**: make it painless for
a new paying tenant to sign up, pay, and reach a rendered dashboard
without hand-holding from the operator. The end of step 5 should be
the moment "XRay on the VPS" is something you can hand to a stranger
with a credit card.

## Current step

**Step 5 — Tenant onboarding + Stripe polish.**

The paid-to-rendered path today has rough edges accumulated across
steps 1–4b. Step 5 closes them. Nothing in this step should require a
new SQL migration; everything is either a UI polish, a missing API
wire-up, or a config knob exposed to the admin.

## What step 5 has to deliver

Treat these as hard requirements unless the plan phase surfaces a
reason to defer. The operator's answer on billing from the 4b
planning session was **"Billing is already gated and completely set
up; Stripe products show up in the admin panel and have a toggle
whether they lift the dashboard gate or not; a subscription unlocks
all dashboards (all or nothing, already setup with websockets."** So
the core Stripe wiring is done — this step is about the user journey
*around* that wire, not the wire itself.

1. **New-tenant self-signup E2E polish.** Today the flow is:
   - Land on `/`, click Start → modal, enter email → magic link.
   - Magic-link email arrives, click through → tenant setup form
     (name, slug) → verify → app shell.
   - App shell shows empty dashboard list + nothing else.

   What 5 needs to verify works end-to-end and what's broken:
   - Every "loading…" state handles errors without a hang.
   - Magic-link expiry is graceful (clear error, re-request path).
   - Slug collision on setup produces a clear error, not a 500.
   - Post-setup, the app shell greets the owner with a next-step
     checklist ("Connect your first integration / Configure billing
     / Invite a teammate").
   - First-render of any dashboard before the Stripe gate is unlocked
     must show the paywall UX, not a raw 403 or empty state.

2. **Billing UX around the existing Stripe gate.**
   - The admin-Stripe-products tab (exists) surfaces a
     "unlocks dashboards" toggle on each product (exists, per operator).
     Verify the toggle is exposed, persisted, and the WebSocket
     broadcast that flips a tenant from locked → unlocked actually
     fires on `invoice.paid` + `customer.subscription.updated`.
   - Tenant-facing billing view: current plan, next bill, "upgrade /
     cancel" links to the Stripe customer portal. Create-portal-session
     endpoint if missing.
   - Locked-tenant paywall — a single clean component, not scattered
     403s. Triggered by the existing billing-state WebSocket signal.
   - "Coupon / discount" flow if the operator runs launch promos —
     surface the Stripe promo code input on the checkout link. Optional
     for 5, nice-to-have.

3. **Admin onboarding of a brand-new paying tenant.** Today an operator
   who wants to hand-hold a specific customer has to click through
   multiple screens. Polish:
   - "Invite tenant" flow in the admin Tenants tab: email + proposed
     slug → sends a branded invitation with a pre-seeded signup link.
     Track invitation status in the UI (pending / accepted / expired).
   - Admin can toggle a tenant's `status` (active / suspended) from
     the Tenants tab with a confirm modal.
   - Admin can view a tenant's last-render timestamp + failure count
     at a glance.

4. **Install-script last-mile.** `install.sh` currently stops after
   migrations + server boot. Post-5 it should also:
   - Seed at least one sample integration row in
     `platform.integrations` (HouseCall Pro as `pending`) so the admin
     UI isn't empty on first load.
   - Print the platform-admin first-login magic link to stdout (or a
     file the operator is told to cat) — avoids the "I'm locked out of
     my own install" foot-gun.
   - Self-check: curl `/api/health` after boot; fail loud if it
     doesn't return 200.

5. **Email template polish.** The magic-link email is functional but
   unbranded. Templates live in `platform.email_templates` (step-1).
   - Default templates for: signup magic link, tenant invitation,
     passkey registration confirmation, billing-locked notice.
   - Admin-editable via the existing Email tab.
   - HTML + plaintext versions; fall back to plaintext gracefully.

6. **Docs the operator hands out.** A `docs/operator.md` (new) and a
   `docs/tenant-owner.md` (new) covering:
   - How to register OAuth apps with HouseCall Pro / QuickBooks and
     feed them into the Integrations tab.
   - How to set a fan-out secret and hand it to an n8n workflow.
   - How a tenant owner invites teammates + grants dashboards.
   - Troubleshooting: magic-link expired, integration stuck on "needs
     reconnect", fan-out returning 401.

## State from step 4b

Read `CONTEXT.md` for the full step-4 + 4b handoff. Summary:

- **Fan-out endpoint** ships, gated on `integrations.fan_out_secret`.
  Admin UI has the secret + parallelism config + "last fan-out"
  status line. n8n owns the cron; XRay never schedules fan-outs.
- **Global dashboards** ship. `platform.dashboards.scope` is
  `'tenant' | 'global'`. Render-path + cache + grants all live.
- **Builder dropdown** is populated, status pill works, Connect
  button opens the modal, edit-load refreshes the pill.
- **Bridge / pipeline / fan-out JWTs**: three distinct audiences, all
  per-dashboard or per-integration signing. No env-var-wide secrets
  for these three.
- **Stripe gate** is live, WebSocket-backed, all-or-nothing per
  operator.
- **OAuth access-token refresh** (`oauth-scheduler.ts`, 5-min tick)
  stays untouched.

## Constraints step 5 must respect

- No schema migrations unless a UX requirement genuinely can't be met
  without one. Expected: zero migrations in step 5.
- No changes to bridge / pipeline / fan-out JWT claim shapes.
- No changes to the three JWT audiences, the four `via` values, or
  `X-XRay-Pipeline-Token`.
- Don't touch `oauth-scheduler.ts`.
- Don't land Model J pipeline DB consumer — still post-step-6.
- Don't fix RLS-is-decorative, don't migrate `withClient` →
  `withTenantContext`, don't retire the plaintext-read fallback.
  All three stay for step 6.
- Don't retire the legacy `dashboards.view_html/css/js` columns — 4b
  dual-writes them for tenant-scoped rows; retiring needs a reader
  audit that's out of scope here.

## Working agreement

1. Read `CONTEXT.md` (step-4 + step-4b handoffs) and this kickoff.
2. Plan → wait for approval → implement in small commits. One
   concern per commit:
   - (i) Signup + magic-link + setup happy path + error states.
   - (ii) Billing UX: paywall component, customer portal link,
     WebSocket-driven unlock, verify product-toggle persistence.
   - (iii) Admin onboarding: invite flow, status toggle, last-render
     dashboard column.
   - (iv) Install-script last-mile + sample integration seed +
     first-login bootstrap output.
   - (v) Email templates.
   - (vi) Operator + tenant-owner docs.

   Ship (i)–(iv) first; (v)–(vi) can piggyback on (iv) if scope
   allows.
3. Surface any scope expansions in the plan before touching code.
4. Acceptance checks (all must pass):
   - `npm test` green; expect modest spec additions for any new
     service-layer code (paywall gate logic, invite flow).
   - `npx tsc --noEmit` clean.
   - **E2E smoke** (operator runs on a clean VPS):
     - `./install.sh` on a bare VPS produces a running platform
       with the first-login link on stdout.
     - Admin logs in, sees Integrations tab populated with the
       HCP seed row at `status='pending'`.
     - Admin invites a tenant owner → owner clicks the email link →
       lands on setup → creates a tenant → sees the onboarding
       checklist in the app shell.
     - Owner clicks "Connect integration" before paying → paywall
       component shows with a "Subscribe" CTA → Stripe checkout →
       webhook fires → WebSocket unlocks the tenant → dashboard
       list becomes interactive.
     - Owner renders a tenant dashboard (seeded? or the admin
       creates a test one) end-to-end.
5. Update `CONTEXT.md` with the step-5 handoff and write a
   `.claude/step-6-kickoff.md`. Step 6's current shape is
   **platform DB hardening**: RLS fix (the decorative-RLS finding
   from step 1), `withClient → withTenantContext` migration,
   plaintext-read-fallback retirement. Verify nothing else got
   deferred into step 6 — notably any cleanup items 4b / 5 left
   behind (grant-management admin UI for Custom Globals, legacy
   `dashboards.view_html` column retirement).

## Branch

Develop on `claude/xray-step-5-onboarding-<suffix>` off main once
step 4b's PR merges. Never push to a different branch without
explicit permission.

## What step 5 must NOT do

- Introduce any SQL migration unless forced.
- Touch bridge/pipeline/fan-out JWT claim shapes or audiences.
- Touch `oauth-scheduler.ts`.
- Collapse the four `via` values.
- Land the pipeline DB side of Model J.
- Fix platform DB RLS (that's step 6).
- Migrate `withClient` → `withTenantContext` (that's step 6).
- Retire the plaintext-read fallback (that's step 6).
- Retire legacy `dashboards.view_html/css/js` columns (post-step
  cleanup, not 5).
- Add per-tenant RS256 keys.
- Build a grant-management admin UI for Custom Globals (deferred
  4b follow-up; re-evaluate in step 5 plan phase — may fit if the
  UX is small).

## Deferred from earlier steps (step 5 plan phase should decide
disposition)

- **Grant-management admin UI** for Custom Globals (step 4b
  follow-up). The grants table exists and the render-path gate
  honors it. A 2-field admin UI (add tenant, remove tenant) is ~an
  hour of work. Fits here if the plan phase wants to pull it in.
- **Platform-wide portability export of Globals only** (4b
  follow-up). Low priority; `exportPlatform` already round-trips
  them.
- **Embed endpoint projection** (pre-existing since step 1).
  `GET /api/embed/:token` returns the whole dashboard row including
  `fetch_url`. Tighter projection is pre-step-6 hygiene; could land
  here or stay deferred.
- **VAPID / push-notification polish** (never formally in scope).
  Not touched by any bridge step.
