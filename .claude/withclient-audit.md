# `withClient` call-site audit — Step 6 (i) → Step 7 close

**Status (post-step-7):** Allow-list is locked and enforced by the
pre-commit guard at `scripts/check-withclient-allowlist.sh`. Total
direct `withClient(` references in `server/src` (excluding tests):
**13 sites across 9 files**, all on the allow-list. Pre-step-7
baseline: ~80 sites across 22 files.

The original step-6 audit document (below) is preserved for the
historical record. The step-7 follow-up actions are all completed
or explicitly deferred — see the step-7 section of `CONTEXT.md`.

## Final allow-list (post-step-7, locked)

These nine files may call `withClient()` directly. Every entry
either touches a no-RLS carve-out table (per migration 029) or
runs in a pre-tenant / pre-auth flow.

| File | Why on allow-list |
|---|---|
| `server/src/db/connection.ts` | Helper definitions (`withClient`, `withTenantContext`, `withAdminClient`, `withUserContext`, transaction analogues). |
| `server/src/services/auth.service.ts` | Magic-link create/verify/consume on `platform.magic_links` (carve-out, no RLS); passkey-challenge platform_settings reads. |
| `server/src/services/settings.service.ts` | `platform.platform_settings` (carve-out). |
| `server/src/services/email.service.ts` | `platform.email_templates` (carve-out). |
| `server/src/services/email-templates.ts` | Boot-time seed into `platform.email_templates`. |
| `server/src/services/meet.service.ts` | `platform.platform_settings` + `platform.tenants` (carve-outs). |
| `server/src/services/rbac.service.ts` | `platform.roles` + `platform.role_permissions` + `platform.permissions` (carve-outs). `deleteRole` uses `withAdminClient` because it queries `users` (RLS-gated). |
| `server/src/services/role.service.ts` | `platform.permissions` (carve-out). |
| `server/src/services/tenant.service.ts` | `platform.tenants` (carve-out); `getTenantDetail` uses `withAdminClient` because it counts users/dashboards/connections cross-tenant. |

## How the rule is enforced

- **Pre-commit hook**: `.githooks/pre-commit` runs
  `scripts/check-withclient-allowlist.sh --staged` on every commit.
  Enable per-clone with `git config core.hooksPath .githooks`.
- **Full-tree scan**: `scripts/check-withclient-allowlist.sh` (no
  args) verifies the rule on the whole tree. Useful in CI.
- **Add to allow-list**: edit the `ALLOWLIST` array in the script
  + add a row above + update CLAUDE.md's helper-policy section
  with the rationale. The hook fails the commit otherwise.

## Final per-file outcome (step-7 close)

| File | Step 6 outcome | Step 7 commit | Final state |
|---|---|---|---|
| `services/admin.service.ts` | Pending | A8 | All 36 → `withAdminClient`/`withAdminTransaction`. |
| `services/dashboard.service.ts` | Mechanical sweep (iii.17) | A1 | 10 functions refined → `withTenantContext`/`withTenantTransaction`; cross-boundary share helpers split with `resolveDashboardScope`. |
| `services/replay.service.ts` | Migrated (iii) | — | All `withTenantContext`. |
| `services/auth.service.ts` | Pending | A13 | 18 sites split: A → `withAdminClient`/`withAdminTransaction`, U → `withClient` (allow-listed). |
| `services/user.service.ts` | Migrated (iii) | — | Mixed; admin lookups → `withAdminClient`. |
| `services/ai.service.ts` | Pending (own helper) | (B1 sweep) | 13 explicit-bypass sites → `withAdminClient`. User-scope sites still use local `withAiUserContext` (consolidation deferred). |
| `routes/stripe.routes.ts` | Pending | A7 | T → `withTenantContext`, A → `withAdminClient`. |
| `routes/dashboard.routes.ts` | Pending | A6 | T (cache + grants) → `withTenantContext`; A (render, share probes) → `withAdminClient`. |
| `services/meet.service.ts` | Migrated (iii) | — | Allow-listed (carve-out reads). |
| `services/inbox.service.ts` | Migrated (iii) → `withAdminClient` | C2 | User-scoped reads + own-row updates → new `withUserContext` (migration 030 + helper). Cross-user writes stay on `withAdminClient`. |
| `services/fan-out.service.ts` | Migrated (iii) | — | Mixed; cross-tenant iteration on `withAdminClient`, per-tenant writes on `withTenantContext`. |
| `services/webhook.service.ts` | Migrated (iii) | — | All `withTenantContext`. |
| `services/upload.service.ts` | Migrated (iii) | — | All `withTenantContext`. |
| `services/stripe.service.ts` | Migrated (iii) | — | Mixed; webhook reverse-lookups on `withAdminClient`. |
| `services/integration.service.ts` | Migrated (iii) | — | Mixed; admin catalog on `withAdminClient`. |
| `services/rbac.service.ts` | Migrated (iii) | — | Allow-listed (carve-out reads). `deleteRole` on `withAdminClient`. |
| `services/apikey.service.ts` | Migrated (iii) | — | All `withTenantContext`. |
| `services/tenant.service.ts` | Migrated (iii) | A8 sweep | Allow-listed (carve-out). `getTenantDetail` on `withAdminClient`. |
| `services/push.service.ts` | Migrated (iii) | — | All `withTenantContext`. |
| `routes/admin.routes.ts` | Pending | A9 | All `withAdminClient`. |
| `routes/admin.ai.routes.ts` | Pending | A10 | All `withAdminClient`. |
| `services/invitation.service.ts` | Migrated (iii) | — | All `withTenantContext`. |
| `services/audit.service.ts` | Migrated (iii) | — | T (`log`) on `withTenantContext`; cross-tenant queries on `withAdminClient`. |
| `routes/oauth.routes.ts` | Pending | A5 | T (callback connection upsert) → `withTenantContext`; A (integration lookup) → `withAdminClient`. |
| `services/settings.service.ts` | Carve-out | A14 | Allow-listed. |
| `services/portability.service.ts` | Pending | A11 | All `withAdminClient`/`withAdminTransaction`. |
| `services/connection.service.ts` | Migrated (iii) | — | All `withTenantContext`. |
| `routes/inbox.routes.ts` | Pending | A3 | Cross-tenant user lookups → `withAdminClient`. |
| `routes/connection.routes.ts` | Pending | A2 | All `withTenantContext`. |
| `services/role.service.ts` | Migrated (iii) | — | Allow-listed (carve-out). |
| `services/email.service.ts` | Carve-out | A14 | Allow-listed. |
| `services/email-templates.ts` | Carve-out | A14 | Allow-listed. |
| `services/data.service.ts` | Migrated (iii) | — | All `withTenantContext`. |
| `routes/user.routes.ts` | Pending | A4 | All `withTenantContext`. |
| `lib/oauth-scheduler.ts` | Pending | A12 | Both → `withAdminClient`/`withAdminTransaction`. |

---

# Original audit doc — Step 6 (i)

Classifies every `withClient` usage in the server tree so the migration
to `withTenantContext` / `withAdminClient` can proceed with a clear
call-site roster. See `.claude/step-6-kickoff.md` for the target shape.

## Categories

- **T — tenant-scoped.** Code path runs on behalf of a single tenant.
  Migrate to `withTenantContext(tenantId, fn)`. RLS `tenant_isolation`
  policy gates the query; the bypass flag is cleared.
- **A — platform-admin cross-tenant.** Code path deliberately reads or
  writes across tenants (admin UI, webhooks reverse-lookup by Stripe
  customer, fan-out dispatch iterating every connected tenant).
  Migrate to `withAdminClient(fn)` — explicit, named bypass. No
  behavior change vs today's `withClient` + `set_config('app.is_platform_admin', 'true')`.
- **U — unauthenticated / bootstrap.** No tenant or admin context
  exists. First-boot setup, magic-link token lookup, signup
  pre-verification, health checks. Stays on `withClient`.
- **S — system / background.** Scheduler ticks, cross-tenant sweeps
  launched from application code. Treated as A (explicit bypass).

## Summary by file

| File | T | A | U | S | Notes |
|---|---|---|---|---|---|
| `services/admin.service.ts` | 0 | 36 | 0 | 0 | Entire surface is platform-admin CRUD. All → A. |
| `services/dashboard.service.ts` | 26 | 2 | 0 | 0 | Tenant-scoped CRUD. A: `getPublicDashboard`, `renderPublicDashboard` (resolve by token — no tenant context yet). |
| `services/replay.service.ts` | 22 | 0 | 0 | 0 | All tenant-scoped (session replay per tenant). |
| `services/auth.service.ts` | 0 | 5 | 13 | 0 | Mostly unauth (magic-link lookup, signup, first-boot). A: permission/flag lookups that legitimately cross-tenant for platform admin. |
| `services/user.service.ts` | 10 | 5 | 0 | 0 | Uses local `bypassRLS()` helper — precedent for A. User-session / passkey listings are user-scoped but queried in tenant context. |
| `services/ai.service.ts` | 14 | 0 | 0 | 0 | All migrate to the existing `withAiUserContext` (user+tenant scope). No change to sem. |
| `routes/stripe.routes.ts` | 8 | 5 | 0 | 0 | T: tenant billing page. A: webhook handlers (reverse-lookup by stripe_customer_id), admin override routes. |
| `routes/dashboard.routes.ts` | 11 | 2 | 0 | 0 | T: authenticated render, grants, shares. A: `/share/:token` resolver, admin preview. |
| `services/meet.service.ts` | 12 | 0 | 0 | 0 | Tenant-scoped (support calls). |
| `services/inbox.service.ts` | 12 | 0 | 0 | 0 | User-scoped but queried in tenant context — T semantics. Note: inbox tables themselves stay bypass-only (no tenant_isolation in step 6). |
| `services/fan-out.service.ts` | 2 | 8 | 0 | 0 | A: listConnectedTenants, loadIntegration, insertRun, finalizeRun, listLastFanOutByIntegration. T: `upsertSkipped`, `upsertDispatchAttempt` (write fan_out_deliveries for a specific tenant — RLS-gated once policy lands). |
| `services/webhook.service.ts` | 9 | 0 | 0 | 0 | Uses local `bypassRLS()`. All writes carry tenant_id → migrate to T. |
| `services/upload.service.ts` | 9 | 0 | 0 | 0 | Tenant-scoped file uploads. |
| `services/stripe.service.ts` | 4 | 5 | 0 | 0 | T: getBillingStatus, checkout, cancel, resume. A: webhook reverse-lookup handlers (`handleInvoicePaid`, `handleInvoiceFailed`, etc.). |
| `services/integration.service.ts` | 2 | 7 | 0 | 0 | A: admin catalog CRUD. T: `listActiveForTenant`, `resolveAccessTokenForRender`. |
| `services/rbac.service.ts` | 6 | 0 | 0 | 0 | Tenant-scoped permission checks. |
| `services/apikey.service.ts` | 6 | 0 | 0 | 0 | Tenant-scoped. |
| `services/tenant.service.ts` | 5 | 0 | 0 | 0 | Tenant-scoped (current tenant detail). |
| `services/push.service.ts` | 5 | 0 | 0 | 0 | Tenant-scoped push subscriptions. |
| `routes/admin.routes.ts` | 0 | 5 | 0 | 0 | All admin. |
| `routes/admin.ai.routes.ts` | 0 | 5 | 0 | 0 | All admin. |
| `services/invitation.service.ts` | 4 | 0 | 0 | 0 | Tenant-scoped. |
| `services/audit.service.ts` | 1 | 3 | 0 | 0 | T: `log` (tenant_id always supplied). A: `query`, `queryAll` (platform audit read). |
| `routes/oauth.routes.ts` | 2 | 2 | 0 | 0 | T: connection CRUD during OAuth return. A: integration lookups. |
| `services/settings.service.ts` | 0 | 0 | 3 | 0 | Platform-wide settings — no tenant concept. Stays on `withClient`. |
| `services/portability.service.ts` | 0 | 3 | 0 | 0 | Export/import — by definition cross-tenant. A. |
| `services/connection.service.ts` | 3 | 0 | 0 | 0 | Tenant-scoped. |
| `routes/inbox.routes.ts` | 3 | 0 | 0 | 0 | Tenant-scoped (user+tenant context). |
| `routes/connection.routes.ts` | 3 | 0 | 0 | 0 | Tenant-scoped. |
| `services/role.service.ts` | 2 | 0 | 0 | 0 | Tenant-scoped (per-tenant role assignments). |
| `services/email.service.ts` | 0 | 2 | 0 | 0 | Platform-wide template fetch → A. |
| `services/email-templates.ts` | 0 | 2 | 0 | 0 | Boot-time seed → A (no tenant, needs bypass since email_templates has no RLS anyway). |
| `services/data.service.ts` | 2 | 0 | 0 | 0 | Tenant-scoped. |
| `routes/user.routes.ts` | 2 | 0 | 0 | 0 | Tenant+user-scoped. |
| `lib/oauth-scheduler.ts` | 0 | 0 | 0 | 2 | Background scheduler iterates connections across tenants → S (bypass). |
| `db/connection.ts` | — | — | — | — | Helper definitions. |

**Totals:** ~188 T, ~85 A, ~16 U, ~2 S. (Approximate — some files mix; per-site numbers below for the migration commits.)

## Migration ordering

Per-service commits in (iii):

1. **Round 1 (simple tenant-scoped services):** `rbac.service`, `apikey.service`, `tenant.service`, `push.service`, `role.service`, `data.service`, `invitation.service`, `connection.service`, `upload.service`, `replay.service`.
2. **Round 2 (mixed):** `webhook.service`, `meet.service`, `inbox.service`, `user.service`, `audit.service`, `fan-out.service`, `integration.service`, `stripe.service`, `dashboard.service`.
3. **Round 3 (routes):** `routes/connection.routes`, `routes/inbox.routes`, `routes/user.routes`, `routes/oauth.routes`, `routes/dashboard.routes`, `routes/stripe.routes`.
4. **Admin surface:** `services/admin.service`, `routes/admin.routes`, `routes/admin.ai.routes`, `services/portability.service` — all flip `withClient` + `set_config(...='true')` to `withAdminClient`.
5. **System:** `lib/oauth-scheduler.ts` — swap to `withAdminClient` to make the cross-tenant nature explicit.
6. **Unauth/bootstrap:** `services/auth.service.ts` (U paths), `services/settings.service.ts`, `services/email-templates.ts` — stay on `withClient`; add a brief comment at each site explaining why tenant context is absent.

## Precedent for `withAdminClient`

Two files already implement the pattern inline:

- `services/webhook.service.ts:7` — `async function bypassRLS(client) { ... }`
- `services/user.service.ts:6` — same helper, copy-pasted.

The step-6 refactor consolidates these into one exported helper and
makes every A-category site call it. The two local copies get deleted.

## Known edge cases

- **`dashboard.service.renderPublicDashboard`** resolves by public
  token, then switches into the sharing tenant's context mid-function.
  Migration: opens as `withClient` (token lookup is unauth), then uses
  a nested `withTenantContext(sharingTenantId, ...)` for the render
  step. Two connections, two setting scopes — cleaner than mutating
  `app.current_tenant` mid-transaction.
- **`stripe.service` webhook handlers** reverse-lookup tenant by
  `stripe_customer_id`. No tenant context arrives with the webhook;
  must use `withAdminClient` to find the tenant, then can switch into
  tenant context for the subsequent `INSERT INTO audit_log`.
- **`fan-out.service.dispatchFanOut`** iterates every connected tenant
  in a single function. Outer pass is A; each per-tenant delivery
  write is T. Mixed-context function — implementation uses
  `withAdminClient` for iteration and `withTenantContext(tenantId, ...)`
  for per-tenant writes.
- **`auth.service`** — magic-link lookup, signup pre-verification, and
  first-boot setup all run before any tenant is known. These are the
  canonical U paths. `withClient` with no settings — any RLS-enabled
  table returns zero rows unless the table is also in the "no RLS"
  carve-out (magic_links, platform_settings).

## Tables that must have tenant_isolation to make T sites work

Validated against migration 029's scope:

- `users, dashboards, dashboard_access, dashboard_sources, connections,`
  `connection_tables, invitations, billing_state, user_passkeys,`
  `user_sessions, audit_log, dashboard_embeds, api_keys, webhooks,`
  `file_uploads` — all **already** have `tenant_isolation` policies
  in `init.sql`.
- `fan_out_deliveries, dashboard_render_cache, dashboard_tenant_grants,`
  `dashboard_shares, tenant_notes` — **missing**; migration 029 adds them.
- `connection_comments` — RLS enabled but no policy. Migration 029
  adds a transitive `tenant_isolation` that joins through
  `platform.connections`.
- `magic_links, platform_settings, email_templates, integrations,`
  `fan_out_runs, roles, permissions, role_permissions,`
  `connection_templates, tenants` — stay on bypass-only (true globals
  or unauth-lookup tables). Documented in 029's header comment.
- `inbox_threads, inbox_thread_participants, inbox_messages` —
  scoped out of step 6. Future user_scope pass mirroring migration 016.
- `ai_threads, ai_messages, ai_pins, ai_usage_daily,`
  `ai_user_dashboard_prefs, ai_message_feedback` — already handled by
  migration 016's `user_scope` policies. No change needed.
