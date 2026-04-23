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

Step 7 is **the step-6 close-out pass** — the small, well-scoped
follow-ups deferred from step 6 plus a handful of latent items
that have been tracked for several steps now. It deliberately does
**not** include the pipeline DB hardening (Model D → Model J) —
that's a separate post-step-7 track with its own kickoff.

## Current step

**Step 7 — Close-out pass on deferred items.**

Items, roughly grouped by risk/effort:

### Cluster A — tenant-context tightening (ratchet; low risk)

These are `withClient + admin bypass` → `withTenantContext` swaps
on paths that clearly have a `tenantId` in scope. Step 6 (iii)
did the bulk of the services; cluster A finishes the remaining
surface. Each sub-commit is a file-level classification +
mechanical edit.

1. **`dashboard.service` per-function refinement.** Step 6 (iii.17)
   did a mechanical sweep to `withAdminClient`. ~10 functions
   take a `tenantId` and only touch tenant-scoped tables —
   `getDashboard`, `createDashboard` (→ `withTenantTransaction`),
   `grantAccess`, `createEmbed`, `revokeEmbed`, `makePublic`,
   `makePrivate`, `rotatePublic`, `attachConnector`,
   `buildDashboardBundle`. Move those to `withTenantContext` /
   `withTenantTransaction`. Leave `getPublicDashboard`,
   `renderPublicDashboard`, `recordView`, `getViewCount`,
   `getEmbedDashboard`, `fetchBridgeSecretCiphertext`, and
   `listDashboards`'s admin branch on `withAdminClient` —
   cross-tenant by design.

2. **Route tenant-context migration.** `connection.routes` (3),
   `inbox.routes` (3), `user.routes` (2), `oauth.routes` (4),
   `dashboard.routes` (13), `stripe.routes` (13). Most inline a
   `const { withClient } = await import('../db/connection')` + a
   `set_config('app.is_platform_admin', 'true')` before the query.
   Swap those to direct `withTenantContext(req.user!.tid, ...)` or
   `withAdminClient` based on the route's purpose.

3. **Admin surface migration.** `admin.service.ts` (36),
   `admin.routes.ts` (5), `admin.ai.routes.ts` (5),
   `portability.service.ts` (3). All are admin-by-definition —
   straight mechanical swap to `withAdminClient` /
   `withAdminTransaction`. No behavior change expected; the point
   is semantic honesty and removing the inline set_config idiom.

4. **`auth.service.ts`** (18 sites). Mostly unauth U paths
   (`firstBootSetup`, magic-link verify, signup pre-verification,
   passkey auth). Review each site per the classifications in
   `.claude/withclient-audit.md` — U paths stay on `withClient`;
   the handful that query tenant-scoped tables in an
   authenticated flow move to `withTenantContext`.

5. **`settings.service`, `email.service`, `email-templates.ts`,
   `oauth-scheduler.ts`**. Settings + emails read global tables
   (no RLS) — stay on `withClient`; add a comment at each site
   explaining why. `oauth-scheduler` runs cross-tenant by
   design — swap its two sites to `withAdminClient` for
   semantic clarity.

### Cluster B — formal enforcement

6. **Pre-commit / eslint rule** that flags any new
   `withClient(...)` call outside an allow-list. Allow-list
   should reflect the post-cluster-A state. Two shapes:
   - Minimal: a shell grep in a `lefthook` / `husky` pre-commit
     hook that counts `withClient` references per-file and fails
     if an unapproved file gains a new one.
   - Proper: a tiny eslint custom rule. Requires adding eslint
     infrastructure since the repo currently has none.

7. **`rls-probe.test.ts`: widen coverage.** Current spec covers
   dashboards, connections, render cache, shares, connection
   comments, tenant_notes. Add: users, billing_state, audit_log,
   user_sessions, dashboard_access, dashboard_sources,
   connection_tables, invitations, user_passkeys,
   dashboard_embeds, api_keys, webhooks, file_uploads,
   dashboard_tenant_grants, fan_out_deliveries. Each assertion
   is ~6 lines.

### Cluster C — latent / cleanups

8. **Retire legacy `dashboards.view_html/css/js` columns**.
   Mig 026 moved per-tenant renders to
   `dashboard_render_cache`. The legacy columns on
   `platform.dashboards` still dual-write for tenant-scoped
   rows (non-render readers: embed, portability, admin preview
   fallback). Audit every read path — if every reader is OK
   with reading from `dashboard_render_cache` instead, write
   a migration to DROP the columns. Otherwise migrate the
   readers first.

9. **Embed endpoint projection tightening**. `GET /api/embed/:token`
   still surfaces `fetch_url` in the response. The embed is a
   render surface — it should not leak the upstream URL. Strip
   `fetch_url` (and `fetch_method`, `fetch_headers`,
   `fetch_query_params`) from the embed response body. Add a
   spec that asserts the projected shape.

10. **Portability export/import gap-fill** (half of this — the
    admin-UI-facing half, not the full dataset round-trip).
    Add these to `portability.service.ts`:
    - `tenants.stripe_customer_id` on the tenants INSERT whitelist.
    - `billing_state.stripe_subscription_id` + `current_period_end`
      on the safeInsert.
    - New sections for `platform_settings`, `api_keys`,
      `webhooks`, `integrations`, `dashboard_tenant_grants`,
      `dashboard_shares`.
    - Document in `docs/operator.md` that `ENCRYPTION_KEY` is a
      required sidecar env var for any export/import cycle.
    This doesn't make portability a full alternative to `pg_dump`
    (it still excludes uploads, encrypted columns that need the
    matching key, transient tables like magic_links) — but it
    closes the gaps that bit the planned on-prem cutover.

11. **Inbox user_scope RLS**. Inbox tables
    (`inbox_threads`, `inbox_thread_participants`,
    `inbox_messages`) have no `tenant_id` column — they're
    user-scoped, with participants spanning tenants. Mirror
    migration 016's shape: a `user_scope` RLS policy that matches
    `user_id` against `app.current_user_id`. Requires exposing a
    `withUserContext(tenantId, userId, fn)` helper (or extending
    `withTenantContext` to accept an optional user ID). Low risk;
    small migration.

12. **Branded `tenant_invitation` email template**
    (deferred-from-step-5). Currently the admin "invite tenant
    owner" path reuses `signup_verification`. Add a distinct
    `tenant_invitation` key to `DEFAULT_TEMPLATES` +
    `inviteTenantOwner` parameter to pick it. ~30 min.

13. **VAPID / push notifications polish**. Long-latent.
    `server/src/services/push.service.ts` ensures a
    `platform.push_subscriptions` table inline (via
    `CREATE TABLE IF NOT EXISTS`) instead of having a migration.
    Move to a proper migration. Add the VAPID subject to
    `platform_settings` so the admin UI can configure it instead
    of reading from env. Optional; only blocks push features
    that aren't shipped yet.

14. **Platform-wide Globals-only portability export**. Option on
    `POST /api/admin/export` that limits the bundle to Globals +
    Integrations catalog + email templates — so operators can
    ship a "starter pack" to a new install without carrying
    tenant data. Needs one new checkbox in the admin UI and a
    filter parameter on the service.

## State step 7 inherits

- 24 commits from step 6 shipped on `claude/xray-tenant-capture-bridge-hp8ut`
  and merged to main.
- `npm test`: 133 active green; 8 RLS probe specs gated on
  `PROBE_RLS=1`.
- `tsc --noEmit`: clean.
- Migration head: 029 (RLS policy fill-in).
- Fresh-install cutover completed on the new cloud VPS; old VPS
  decommissioned.
- `.claude/withclient-audit.md` lists every remaining `withClient`
  call site — use it as the input to cluster A.
- CLAUDE.md documents the `withTenantContext` default /
  `withAdminClient` opt-in / `withClient` unauth-only policy.

## Constraints step 7 must respect

- **No changes to JWT shapes or audiences.** Bridge, pipeline, and
  fan-out tokens stay as they are.
- **No pipeline DB work.** Model D / J is a separate track.
- **No new migrations unless cluster A surfaces a missed
  table or cluster C items 8 or 11 require one.** Each new
  migration gets its own commit with rationale.
- **No per-tenant RS256 keys.** Out of scope.
- **No changes to `billing_state.payment_status` transitions.**

## Working agreement

1. Read this kickoff + the step-6 section of `CONTEXT.md` +
   `.claude/withclient-audit.md`.
2. Propose a commit-by-commit plan. Cluster A is per-file; cluster
   B and C are one commit per item unless an item naturally splits
   (e.g. the portability gap-fill could be one commit per added
   section).
3. Wait for approval before touching code.
4. Small commits, one concern per commit — same rhythm as step 6
   (iii). Run `npm test` + `tsc --noEmit` after each commit.
5. Acceptance:
   - `npm test` green, `tsc --noEmit` clean.
   - Widened `rls-probe.test.ts` passes with `PROBE_RLS=1` against
     a live DB (operator-run).
   - `migrations/probes/probe-rls-cross-tenant.sql` still prints
     `PROBE PASS`.
   - `withClient` reference count in the server tree goes down.
     Update `.claude/withclient-audit.md` with the new counts.
6. Append a step-7 section to CONTEXT.md when shipped.

## Branch

Develop on `claude/xray-step-7-close-out-<suffix>` off main once
this step-6 commit is merged. Confirm branch name with the
operator before pushing.

## What step 7 must NOT do

- JWT-shape changes.
- Pipeline DB Model D / J work.
- Per-tenant RS256 keys.
- n8n workflow changes.
- Retire `dashboards.view_html/css/js` columns without a reader
  audit (cluster C item 8 makes the audit the precondition).
- Add new features beyond what's listed. Keep cluster B and C
  items scoped — if an item expands, split it back out into its
  own step.

## First action

Read this kickoff + `CONTEXT.md` step-6 section +
`.claude/withclient-audit.md`. Produce a plan that:

- Sequences cluster A → B → C, with per-item commit estimates.
- Flags any ambiguity in the audit doc that needs operator input
  before implementation (e.g. `admin.ai.routes.ts` has
  background-AI-request paths that might not be tenant-scoped
  cleanly).
- Identifies which cluster C items (if any) should slip to a
  later step because they expand scope beyond "step-6 close-out."

Wait for approval before committing.
