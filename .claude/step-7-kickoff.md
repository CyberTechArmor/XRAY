# XRay — Step 7 kickoff

Paste this as the next session's opening prompt.

---

## Role

You are implementing step 7 of the XRay platform hardening track.
Steps 1–5 shipped the bridge + onboarding + Stripe. Step 6 shipped
platform DB RLS hardening: `withTenantContext` / `withAdminClient`
helpers, migration 029's policy fill-in, the cross-tenant probe,
strict-mode decrypt, `dashboard.render_failed` audit, and the
`integration:needs_reconnect` WS broadcast. See the step-6 section
of `CONTEXT.md` and `.claude/withclient-audit.md` for the migrated
call-site inventory and the explicit "didn't ship" list.

**Step 7 closes the platform-side security baseline.** After step 7
ships, every tenant-data path on the platform DB is RLS-enforced
(not relying solely on app-layer `WHERE tenant_id` filters), the
embed endpoint no longer leaks upstream config, future regressions
are blocked by a pre-commit rule, and the cross-tenant probe
covers every RLS-enabled table. The remaining security track item
— pipeline DB hardening (Model D → Model J) — is **deferred to
after the on-prem/cloud migration**, not part of step 7.

## Current step

**Step 7 — Platform security baseline close-out.**

Three clusters, ~14 items total. Sized for a multi-session
campaign of small per-file commits in the same rhythm as step
6 (iii).

### Cluster A — Tenant-context tightening (ratchet, the bulk of the work)

These are `withClient + admin bypass` → `withTenantContext` swaps
on paths that have a `tenantId` in scope. Step 6 (iii) did the
services; cluster A finishes every remaining file. After A, a
forgotten `WHERE tenant_id = ...` in any migrated path returns
zero rows instead of leaking — RLS is the safety net.

1. **`dashboard.service` per-function refinement.** Step 6 (iii.17)
   did a mechanical sweep to `withAdminClient`. ~10 functions take
   `tenantId` and only touch tenant-scoped tables — move those to
   `withTenantContext` / `withTenantTransaction`. Specifically:
   `getDashboard`, `createDashboard`, `grantAccess`, `createEmbed`,
   `revokeEmbed`, `makePublic`, `makePrivate`, `rotatePublic`,
   `attachConnector`, `buildDashboardBundle`. Keep
   `getPublicDashboard`, `renderPublicDashboard`, `recordView`,
   `getViewCount`, `getEmbedDashboard`,
   `fetchBridgeSecretCiphertext`, and `listDashboards`'s admin
   branch on `withAdminClient` — cross-tenant by design.

2. **Route tenant-context migration.** Every route file — per
   `.claude/withclient-audit.md`:
   - `connection.routes` (3 sites)
   - `inbox.routes` (3 sites)
   - `user.routes` (2 sites)
   - `oauth.routes` (4 sites)
   - `dashboard.routes` (13 sites)
   - `stripe.routes` (13 sites)
   Most inline `const { withClient } = await import('../db/connection')`
   + a `set_config('app.is_platform_admin', 'true')`. Swap per-site
   to `withTenantContext(req.user!.tid, ...)` for authenticated
   tenant paths, `withAdminClient` for webhook receivers / share
   token resolvers, `withClient` for unauth paths. One commit per
   route file.

3. **Admin surface migration.** `admin.service.ts` (36 sites),
   `admin.routes.ts` (5), `admin.ai.routes.ts` (5),
   `portability.service.ts` (3). All are admin-by-definition —
   mechanical swap to `withAdminClient` / `withAdminTransaction`.
   No behavior change expected; intent becomes explicit in the
   helper name.

4. **`auth.service.ts`** (18 sites). Mostly unauth U paths
   (`firstBootSetup`, magic-link verify/consume, signup
   pre-verification, passkey challenge / auth). Per the audit:
   - 13 sites stay on `withClient` (unauth by design).
   - 5 sites (admin-flag lookups crossing tenants for platform
     admin routing) move to `withAdminClient`.
   Case-by-case per function.

5. **`settings.service`, `email.service`, `email-templates.ts`,
   `oauth-scheduler.ts`**. Settings + email-template reads touch
   global (no-RLS) tables — stay on `withClient` with a short
   comment at each site explaining why. `oauth-scheduler` runs
   cross-tenant by design — swap its two sites to
   `withAdminClient` for semantic clarity.

### Cluster B — Enforcement + test coverage

6. **Pre-commit / eslint rule** that flags any new `withClient(`
   call outside an allow-list. Allow-list reflects the
   post-cluster-A state — settings.service, email.service,
   email-templates.ts, oauth-scheduler.ts, auth.service.ts (U
   paths), and db/connection.ts (definition). Two shapes:
   - Minimal: shell grep in a pre-commit hook that counts
     `withClient` per file and fails if an unapproved file gains
     one.
   - Proper: tiny eslint custom rule. Requires adding eslint
     infrastructure.
   Pick one; defer the other to post-step-7 if needed.

7. **Widen `rls-probe.test.ts` coverage.** Current spec covers
   dashboards, connections, render cache, shares, connection
   comments, tenant_notes. Add: users, billing_state, audit_log,
   user_sessions, dashboard_access, dashboard_sources,
   connection_tables, invitations, user_passkeys,
   dashboard_embeds, api_keys, webhooks, file_uploads,
   dashboard_tenant_grants, fan_out_deliveries. Each assertion
   is ~6 lines. All gated by `PROBE_RLS=1`.

### Cluster C — Latent security + cleanup

8. **Embed endpoint projection tightening.**
   `GET /api/embed/:token` currently surfaces `fetch_url` (and
   adjacent config fields) in the response body. An embed token
   is a render capability, not a config-disclosure capability —
   strip `fetch_url`, `fetch_method`, `fetch_headers`,
   `fetch_query_params` from the embed response. Add a spec that
   asserts the projected shape. Minor info-disclosure fix.

9. **Inbox user_scope RLS.** Inbox tables (`inbox_threads`,
   `inbox_thread_participants`, `inbox_messages`) have no
   `tenant_id` column. Mirrors migration 016's shape: a new
   migration (030?) that enables RLS + adds a `user_scope`
   policy keyed on `app.current_user_id`. Requires a new helper
   `withUserContext(tenantId, userId, fn)` or extending
   `withTenantContext` to accept an optional userId. Small
   migration; low-risk swap of the ~12 inbox.service sites.

10. **Retire legacy `dashboards.view_html/css/js` columns.**
    Migration 026 moved per-tenant renders to
    `dashboard_render_cache`. Legacy columns on
    `platform.dashboards` still dual-write for tenant-scoped
    rows. Audit every non-render reader (embed, portability,
    admin preview fallback) — if every reader is fine with
    `dashboard_render_cache`, drop the columns in a migration.
    Otherwise migrate readers first. This is the single largest
    remaining schema cleanup.

11. **Portability export/import gap-fill** (the ratchet version,
    not the full pg_dump replacement). Add to
    `portability.service.ts`:
    - `tenants.stripe_customer_id` on the tenants import
      whitelist.
    - `billing_state.stripe_subscription_id` +
      `current_period_end` on the safeInsert.
    - New sections: `platform_settings`, `api_keys`, `webhooks`,
      `integrations`, `dashboard_tenant_grants`,
      `dashboard_shares`.
    - Document `ENCRYPTION_KEY` as a required sidecar in
      `docs/operator.md`.
    Still not a full host-move tool (excludes uploads, requires
    matching encryption key) but closes the gaps that made the
    planned cutover worthless.

12. **Branded `tenant_invitation` email template**
    (deferred-from-step-5). Admin "invite tenant owner" reuses
    `signup_verification` today. Add `tenant_invitation` to
    `DEFAULT_TEMPLATES` + parameter on `inviteTenantOwner`.
    ~30 min.

13. **VAPID / push-notifications polish**. `push.service.ts`
    creates `platform.push_subscriptions` inline with
    `CREATE TABLE IF NOT EXISTS`. Move to a proper migration.
    Move VAPID subject/keys from env to `platform_settings` so
    admin UI can configure. Low priority; only blocks push
    features not yet shipped.

14. **Platform-wide Globals-only portability export.** Admin UI
    option on `POST /api/admin/export` that bundles Globals +
    integrations catalog + email templates — a "starter pack"
    shareable between installs. One checkbox + one service
    parameter.

## State step 7 inherits

- 24 commits from step 6 on `claude/xray-tenant-capture-bridge-hp8ut`.
- `npm test`: 133 active green; 8 RLS probe specs gated on
  `PROBE_RLS=1`.
- `tsc --noEmit`: clean.
- Migration head: 029.
- Fresh-install cutover on the new cloud VPS (see
  `.claude/cutover-checklist.md`).
- `.claude/withclient-audit.md` lists every remaining `withClient`
  site — use it as the input to cluster A.
- CLAUDE.md documents the `withTenantContext` default /
  `withAdminClient` opt-in / `withClient` unauth-only policy.

## Constraints step 7 must respect

- **No JWT shape or audience changes.**
- **No pipeline DB work.** Pipeline hardening (Model D → J) is
  its own post-step-7 track — will land after the platform is
  stable on the new cloud host and has paying tenants.
- **No new migrations unless cluster A surfaces a missed table
  or cluster C items 9, 10, or 13 require one.** Each new
  migration gets its own commit with rationale.
- **No per-tenant RS256 keys.** Out of scope.
- **No changes to `billing_state.payment_status` transitions.**

## Working agreement

1. Read this kickoff + the step-6 section of `CONTEXT.md` +
   `.claude/withclient-audit.md`.
2. Propose a commit-by-commit plan. Cluster A is per-file
   (~15-20 commits); cluster B is 2 commits; cluster C is
   one commit per item (~7 commits). Flag any item that wants
   splitting or deferring.
3. Wait for approval before touching code.
4. Small commits, one concern per commit. Run `npm test` +
   `tsc --noEmit` after each commit. Push in batches.
5. Acceptance:
   - `npm test` green; `tsc --noEmit` clean.
   - Widened `rls-probe.test.ts` passes with `PROBE_RLS=1`
     against a live DB (operator-run).
   - `migrations/probes/probe-rls-cross-tenant.sql` still
     prints `PROBE PASS` after any migration 030.
   - `withClient` reference count in `server/src` goes down
     materially. Update `.claude/withclient-audit.md` with the
     new counts and the final allow-list.
   - Embed endpoint response verified to exclude `fetch_url`
     (spec + manual curl check).
6. Append a step-7 section to CONTEXT.md when shipped.

## Branch

Develop on `claude/xray-step-7-close-out-<suffix>` off main once
step 6's branch is merged. Confirm branch name with the operator
before pushing.

## What step 7 must NOT do

- JWT-shape / audience changes.
- Pipeline DB Model D / J work (separate post-step-7 track,
  landing after the fresh-install cutover is stable with real
  tenants).
- Per-tenant RS256 keys.
- n8n workflow changes.
- Retire `dashboards.view_html/css/js` columns without the
  reader audit (C10 item makes the audit the precondition).
- Add new features beyond the listed items. If something
  expands, split into a later step rather than growing scope
  here.

## First action

Read this kickoff + `CONTEXT.md` step-6 section +
`.claude/withclient-audit.md`. Produce a plan that:

- Sequences A → B → C with per-item commit estimates.
- Flags ambiguity in the audit doc needing operator input
  (e.g. `admin.ai.routes.ts` may have background-AI-request
  paths that don't classify cleanly).
- Identifies which cluster C items (if any) should slip to
  post-step-7 because they expand scope beyond "close-out."
- Confirms the eslint vs shell-grep choice for item 6.

Wait for approval before committing.

---

## Post-step-7 track (explicit)

**Pipeline DB hardening — deferred to after cutover.** Model D →
Model J per `.claude/pipeline-hardening-notes.md`. Security
rationale: post-step-7 the platform DB is tenant-isolated at the
DB layer, but the pipeline DB still trusts whatever tenant_id
n8n sends. Model J closes that gap with `pipeline.authorize(jwt)`
+ per-tenant Postgres roles + DB-side access audit. Landing the
pipeline track after paying tenants are on the new host ensures
we can probe real workloads and plan the per-tenant role
provisioning migration with actual data.
