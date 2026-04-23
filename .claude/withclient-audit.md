# `withClient` call-site audit — Step 6 (i)

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
