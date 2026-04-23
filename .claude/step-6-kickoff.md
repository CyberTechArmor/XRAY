# XRay VPS Bridge — Step 6 kickoff

Paste this as the next session's opening prompt.

---

## Role

You are implementing one step of the bridge to capture paying XRay
tenants on the current VPS before an on-prem migration. Steps 1–4c
shipped the credential/JWT/schema/OAuth/fan-out/Global-dashboard +
UX rails. Step 5 shipped tenant onboarding + Stripe polish: new
tenants can self-serve from `/` to a rendered dashboard with no
operator hand-holding.

This step — 6 — is **platform DB hardening**: turn the
decorative RLS on the platform DB into real isolation, migrate
`withClient` call sites onto `withTenantContext`, and retire the
plaintext-read fallback on encrypted columns. It's the last
step before the on-prem migration cutover.

## Current step

**Step 6 — Platform DB hardening.**

Three concerns that have been deferred from every prior step:

1. **Fix decorative RLS.** Step 1 found that every `platform.*`
   table has a `tenant_isolation` policy bound to
   `current_setting('app.current_tenant')`, but the DB-layer
   helpers (`withClient`) never actually set that config — they
   set `app.is_platform_admin = 'true'` instead, which
   short-circuits the policy via the platform-admin bypass. Result:
   the RLS does nothing because every query runs with the bypass
   flag on. The step-1 doc calls this out explicitly.

2. **Migrate `withClient` → `withTenantContext`.** A
   `withTenantContext(tenantId, fn)` helper exists (one call site
   today). Step 6 moves every tenant-scoped read and write path
   over, and `withClient` becomes the rare no-tenant path
   (settings, bootstrap, maintenance scripts, platform-admin
   cross-tenant queries).

3. **Retire the plaintext-read fallback.** The encrypted-column
   reader (`lib/encrypted-column.ts` → `decryptSecret`) tolerates
   plaintext input for rows encrypted before step 1. With step 1's
   backfill run on every VPS that upgraded, the fallback should
   be removable. Step 6 removes it and makes decrypt throw on
   plaintext (a signal that something's wrong rather than a silent
   security regression).

## What step 6 has to deliver

1. **Real RLS on the platform DB.**
   - Audit every `withClient(async (client) => { ... })` call
     site. Classify as: tenant-scoped (should use
     `withTenantContext`), platform-admin cross-tenant (keep
     `withClient` + explicit `set_config('app.is_platform_admin',
     'true', true)` — the bypass stays deliberately intact here),
     or unauthenticated setup (first-boot, migrations).
   - Each tenant-scoped call site flips to
     `withTenantContext(tenantId, fn)`. The helper both sets
     `app.current_tenant` AND clears `app.is_platform_admin` so
     the RLS policy actually gates the query.
   - Policy-by-policy verification: query
     `platform.<table> FROM a different tenant context` and confirm
     zero rows. This is the acceptance gate — a single table that
     still leaks cross-tenant data means the step is incomplete.

2. **`withTenantContext` is the default.**
   - Add a lint rule or a `pre-commit` check that flags any new
     `withClient` call outside an allow-list of paths (settings
     service, platform-admin routes, migration scripts, bootstrap
     flows).
   - Update `CLAUDE.md` rules to require tenant context for any
     new tenant-scoped code path.

3. **Retire plaintext fallback.**
   - Run the encryption backfill one last time on any VPS that
     hasn't upgraded recently.
   - Flip `decryptSecret` to throw on non-encrypted input.
   - Remove the `try { decrypt } catch { return plaintext }`
     shape across the codebase.
   - Add a spec that asserts a plaintext value is rejected.

4. **Render-failure audit action** (deferred from step 5).
   - Add `dashboard.render_failed` audit entries on render-path
     failures (bridge-mint 5xx, pipeline-fetch timeout, etc.).
     Enables the admin-tenants "Last failure" column that (iii)
     wanted to ship but couldn't.

5. **Integration `needs_reconnect` WS broadcast** (deferred from
   step 4c). The OAuth scheduler flips `connections.status` to
   `needs_reconnect` on refresh failure but doesn't broadcast.
   Step 6 adds the broadcast since `oauth-scheduler.ts` is now
   unblocked (step 5 is over).

## State step 6 inherits

- **127/127 tests green**; `tsc --noEmit` clean at head.
- Bundle version: `2026-04-23-014-step5v`.
- No new SQL migrations since 028 through all of step 5. Step 6
  may need one for an RLS policy refinement if audit surfaces a
  table missing its `tenant_isolation` policy — but the default
  assumption is still "zero migrations."
- **`withTenantContext` exists** with one call site today. Step 6
  is the migration.
- **Stripe is fully wired**: gate + WS unlock + cancel/resume +
  per-product toggles for gate/billing-page/tenant-row. Admin +
  tenant billing pages fully interactive.
- **Onboarding checklist** on empty dashboard list; signup error
  paths all have distinct codes (SLUG_TAKEN, MAGIC_LINK_EXPIRED,
  MAGIC_LINK_USED, MAX_ATTEMPTS, EMAIL_EXISTS, TENANT_EXISTS).
- **Custom Global grant management UI** shipped.
- **Default email templates seeded on boot**: signup_verification,
  login_code, account_recovery, invitation, passkey_registered,
  billing_locked. Reset-to-default per-template action available.
- **install.sh** fails loud on `/api/health` regression and
  dumps the last 30 lines of server logs.
- **Docs** live: `docs/operator.md`, `docs/tenant-owner.md`.

## Constraints step 6 must respect

- **No changes to JWT shapes or audiences.** Bridge, pipeline, and
  fan-out tokens all stay as they are.
- **No touching `oauth-scheduler.ts`** except to add the
  `needs_reconnect` WS broadcast — and only after auditing the
  rest of the module to make sure the broadcast doesn't fire on
  the success path by accident.
- **No new migrations unless an RLS policy is missing or wrong.**
  Most of step 6 is call-site changes, not schema changes.
- **Don't land Model J pipeline DB consumer.** Still deferred
  (post-step-6; see `.claude/pipeline-hardening-notes.md`).
- **Don't add per-tenant RS256 keys.** Out of scope for the bridge
  track.
- **Don't retire legacy `dashboards.view_html/css/js` columns.**
  4b dual-writes them; retiring needs a reader audit that's
  outside hardening scope.

## Working agreement

1. Read this kickoff + the step-5 section of `CONTEXT.md` +
   `.claude/pipeline-hardening-notes.md` (the "Model D / J"
   architecture that step 6 is the prerequisite for).
2. Plan → wait for approval → implement in small commits. One
   concern per commit. Suggested slicing:
   - (i) Audit + taxonomy: every `withClient` call site classified
     (no code changes, just a doc).
   - (ii) Migrate tenant-scoped call sites to `withTenantContext`.
   - (iii) RLS acceptance test: cross-tenant probe confirms zero
     leaks.
   - (iv) Retire plaintext-read fallback, add rejection spec.
   - (v) Render-failure audit action (small; piggy-backs onto the
     existing `dashboard.opened` pattern).
   - (vi) `needs_reconnect` WS broadcast (tiny; mirrors the
     step-4c connect/disconnect broadcast pattern).
   - (vii) Lint / CLAUDE.md update to gate future `withClient`
     adoption.

   Ship (i)–(iv) first; (v)–(vi) can piggyback on (iii)/(ii) if
   scope allows. (vii) is the close-out.

3. Surface any scope expansions before touching code. If the RLS
   audit turns up a policy that actually requires a schema
   change (new table missing `tenant_isolation`, or a
   FK-cascades-through-tenant chain that's wrong), that's a
   migration and it deserves its own mini-kickoff.

4. Acceptance checks:
   - `npm test` green; expect new specs for each migrated call
     site's cross-tenant isolation.
   - `tsc --noEmit` clean.
   - Cross-tenant probe: `SET app.current_tenant = '<tenant-a>'`
     in a psql session, then
     `SELECT COUNT(*) FROM platform.<every table>` must return
     only tenant-a's rows. Run for at least three tables per
     schema section (users, dashboards, connections, billing_state,
     audit_log, user_sessions).
   - Encrypted-column rejection test: plaintext input to
     `decryptSecret` throws.
   - E2E smoke: run through the step-5 onboarding flow again
     (signup → setup → subscribe → render) after the hardening
     — behavior must be unchanged.

5. Update `CONTEXT.md` with the step-6 handoff. If this is the
   final step before the on-prem cutover, write a
   `.claude/cutover-checklist.md` covering: data-migration plan,
   downtime window, DNS flip, Stripe webhook endpoint re-
   registration, fan-out secret rotation, admin re-seeding on
   the new host.

## Branch

Develop on `claude/xray-step-6-rls-hardening-<suffix>` off main
once step 5's PR merges. If the operator-specified session
branch differs, confirm before pushing.

## What step 6 must NOT do

- Introduce JWT-shape changes.
- Touch the bridge / pipeline / fan-out audience set.
- Land the pipeline DB side of Model J.
- Retire `dashboards.view_html/css/js`.
- Add per-tenant RS256 keys.
- Change anything in the n8n workflows.
- Change `billing_state.payment_status` transitions.

## Deferred from step 5 (step 6 plan phase should decide
disposition)

- **Failure-count column** on admin tenants row — needs
  `dashboard.render_failed` audit. Fits (v) above.
- **Integration `needs_reconnect` WS broadcast** — fits (vi).
- **Branded `tenant_invitation` email template** as its own
  template key (currently step 5 re-uses `signup_verification`).
  Decision: fold-in or keep deferred. If fold-in, adds one entry
  to `DEFAULT_TEMPLATES` and a parameter on `inviteTenantOwner`
  to pick the template key. Low-risk, ~30 min.

## Post-step-6 follow-ups (not scoped in step 6)

- Pipeline DB hardening Phase A (Model D) — see
  `.claude/pipeline-hardening-notes.md`.
- Pipeline DB hardening Phase B (Model J).
- Legacy `dashboards.view_html` column retirement (reader audit
  required).
- Embed endpoint projection tightening (`fetch_url` still surfaces
  from `GET /api/embed/:token`).
- Platform-wide Globals-only portability export.
- VAPID / push-notification polish.

## First action

Read `.claude/pipeline-hardening-notes.md` + the step-5 section of
`CONTEXT.md`. Produce a plan that:

- Lists the concrete commit slices (the (i)–(vii) above is a
  starting point).
- Surfaces any scope expansion or deferral.
- Flags whether the step-5 deferrals fold in or stay deferred.
- Lists any open questions before implementation — especially
  around any `withClient` call site that's ambiguous between
  "tenant-scoped" and "platform-admin cross-tenant."

Wait for approval before committing.
