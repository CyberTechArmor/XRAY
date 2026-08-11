# Porting the XRay multi-tenancy model to another service

Companion to `auth-flow-port-prompt.md` and `stripe-integration-port-prompt.md`.
Same two-part structure:

1. **How XRay's multi-tenancy works** — the reference implementation.
2. **The prompt** — a self-contained brief for the target service's repo.

---

# Part 1 — How XRay's multi-tenancy works

## 1.1 Three layers, and only one of them is trusted

| Layer | Mechanism | Scope |
| --- | --- | --- |
| Request | `tid` claim in the JWT | Which tenant this request acts as |
| Connection | Named DB context helper | Which GUCs are set on this pooled client |
| Row | Postgres RLS policy | Which rows the query can even see |

The application layer is discipline; the **database is the enforcement**. A
missed `WHERE tenant_id = $1` in a query is a leak in most codebases. Here it
returns zero rows, because the policy is evaluated by Postgres regardless of
what the query says.

## 1.2 The named-helper convention (`db/connection.ts`)

This is the heart of the design. Four helpers, each with one job:

```ts
withTenantContext(tenantId, fn)  // sets app.current_tenant → tenant_isolation gates
withUserContext(tid, uid, fn)    // adds app.current_user_id → user_scope gates
withAdminClient(fn)              // sets app.is_platform_admin → bypass policy applies
withClient(fn)                   // no context; default-deny. Unauth/bootstrap only.
```

Plus `withTenantTransaction` / `withAdminTransaction` as BEGIN/COMMIT analogues.

The critical property: **bypass is a function name you have to type.** There is
no `{ bypassRLS: true }` option, no boolean parameter, no ambient flag. Reading
across tenants requires writing the word `withAdminClient`, which is greppable,
reviewable, and impossible to reach by accident.

`CLAUDE.md` codifies the rule: new code defaults to `withTenantContext`; if you
are reaching for `withAdminClient` on a path that already has a `tenantId`, stop
— you want the tenant helper.

## 1.3 Default-deny reset on every checkout

```ts
async function resetRlsContext(client: PoolClient) {
  await client.query(
    `SELECT set_config('app.current_tenant', '', false),
            set_config('app.current_user_id', '', false),
            set_config('app.is_platform_admin', 'false', false)`
  );
}
```

Every `withClient` entry — and therefore every helper, since they all wrap it —
clears all three GUCs before running the body.

This exists because **connections are pooled and GUCs are session-scoped**.
Without the reset, a checkout that ran under `withAdminClient` returns a client
with `is_platform_admin = true` still set. The next borrower gets a silent,
undetectable full-database bypass. It's an intermittent, load-dependent, near
un-debuggable cross-tenant leak — and the reset is a one-line fix.

## 1.4 The `is_local` trap

Straight from the comment in `connection.ts:28-36`, and worth reading twice:

> The previous implementation used `set_config(..., true)` (`is_local=true`)
> which only persists inside an explicit transaction — outside one, the value is
> "set" for the implicit single-statement transaction and immediately reset, so
> the very next query sees the GUC unset.

So the non-transaction helpers use `is_local=false` (session scope) plus the
reset above, and only the `withTransaction` family uses `is_local=true`.

Getting this backwards is silently catastrophic in both directions: `true`
outside a transaction means the tenant context never applies (default-deny, so
you get mysterious empty results — the safe failure), while `false` without the
reset means context leaks across pool occupants (the unsafe failure).

## 1.5 FORCE ROW LEVEL SECURITY — the lesson that cost the most

From migration 044's header:

> row-level security has been **decorative** for the connecting application
> user. The docker-compose stack creates `POSTGRES_USER` (xray) as a
> superuser-equivalent and runs `init.sql` AS that user, so xray ends up OWNING
> every `platform.*` table. **Postgres bypasses RLS for table owners by
> default** — the policies attach but never fire.

Policies existed. Tests passed. `\d+` showed them. And they did nothing, because
the application connects as the table owner. This survived until `PROBE_RLS=1`
was wired into CI.

Two fixes were required together:

**A. `ALTER TABLE ... FORCE ROW LEVEL SECURITY`** on every tenant-scoped table,
so the owner respects its own policies.

**B. NULL-safe policy expressions.** Once policies actually evaluate, the naive
form crashes:

```sql
current_setting('app.current_tenant', true)::uuid
-- ERROR: invalid input syntax for type uuid: ""   ← when unset
```

Worse, **Postgres evaluates every policy on a table, and one raising aborts the
whole query** — so under `withAdminClient` (which doesn't set
`app.current_tenant`), the `tenant_isolation` policy raised even though
`platform_admin_bypass` would have permitted the row.

The fix is three `STABLE PARALLEL SAFE` helper functions that do the NULL-safe
read once:

```sql
CREATE FUNCTION platform.current_tenant_id() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE AS
  $$ SELECT nullif(current_setting('app.current_tenant', true), '')::uuid $$;
-- likewise current_user_id() and is_platform_admin()
```

Every policy calls the helper. `STABLE PARALLEL SAFE` lets the planner inline
them, so there's no per-row cost.

## 1.6 Policy shape

Two permissive policies per tenant-scoped table (permissive policies OR together):

```sql
CREATE POLICY tenant_isolation ON platform.<table>
  USING      (tenant_id = platform.current_tenant_id())
  WITH CHECK (tenant_id = platform.current_tenant_id());

CREATE POLICY platform_admin_bypass ON platform.<table>
  USING      (platform.is_platform_admin())
  WITH CHECK (platform.is_platform_admin());
```

Migration 044 sets **both `USING` and `WITH CHECK` explicitly** on every policy.
Postgres defaults `WITH CHECK` to the `USING` expression, so the behavior is the
same — but writing it out means `INSERT` gating is visibly intentional rather
than inherited, and it can't be lost in a later edit.

**Transitive isolation** for tables with no direct `tenant_id`: migration 029
gives `connection_comments` (which has only `connection_id`) a policy that joins
through `platform.connections`. Easy to miss when adding a table; there is no
`tenant_id` column to remind you.

## 1.7 The carve-out list is explicit and reasoned

Not every table gets isolation, and migration 029's header documents each
decision:

- **True globals** — `roles`, `permissions`, `role_permissions`,
  `platform_settings`, `email_templates`, `tenants`, `connection_templates`. No
  RLS; they're the same for everyone.
- **Unauth-path tables** — `magic_links` is queried by token *before* any login
  exists, so there's no context to gate on. RLS stays off; the token is the
  capability.
- **Admin-only, deliberately no isolation policy** — `tenant_notes` gets RLS
  enabled and `platform_admin_bypass` **only**. Tenants are never meant to read
  notes about themselves, so any code path running in tenant context gets zero
  rows by default-deny.

That last one is the pattern worth internalizing: *omitting* a policy is itself
a security decision, and it's written down.

## 1.8 Enforcement is mechanical, not cultural

**Pre-commit hook.** `scripts/check-withclient-allowlist.sh` fails the commit if
any file outside a ten-file allow-list calls `withClient(` directly. Enabled per
clone with `git config core.hooksPath .githooks`. The allow-list is the exact
roster of files holding unauth/bootstrap/carve-out paths, each annotated with
why.

`CLAUDE.md` also names the specific anti-pattern the script exists to kill:

> Never write `withClient(...) + set_config('app.is_platform_admin', 'true')`
> inline. A local `bypassRLS` helper in a service file is the same anti-pattern.

**CI probe.** `migrations/probes/probe-rls-cross-tenant.sql` creates two
synthetic tenants, inserts a row per RLS-enabled table for each, switches into
each tenant's context, and `RAISE EXCEPTION`s if either sees the other's rows.
Admin bypass is verified last. Everything rolls back.

It lives in `probes/`, not `migrations/`, specifically so the deploy script's
migration pass doesn't auto-apply something with real INSERT side effects.

This probe is what caught the owner-bypass bug. A convention that isn't
executable is a convention that has already drifted.

## 1.9 Users are per-tenant rows, not global accounts

A person with access to three organizations has **three rows** in
`platform.users` — same email, different `tenant_id`, potentially different
`role_id`. That's what makes `tenant_isolation` on the users table coherent.

Consequences that fall out of it:

- Login resolves *all* rows for an email → if more than one active tenant, the
  auth flow returns `{ tenants: [...] }` and the client shows a picker.
- Roles are genuinely per-tenant: owner in one org, member in another.
- Deactivating someone in one org doesn't touch the others.

## 1.10 Switching tenants re-mints the session

`POST /api/users/me/switch-tenant` doesn't edit a claim or set a filter — it
calls `authService.loginToTenant(email, tenantId)`, the same function the login
tenant-picker uses, and issues a **complete new session**: new access token, new
refresh cookie, new CSRF cookie.

The client discards everything and re-enters:

```js
accessToken = d.data.accessToken;
currentView = null;
document.getElementById('view-container').innerHTML = '';
enterApp();
```

Because the tenant lives in the signed token rather than in client state, there
is no window where a stale view holds the old tenant's data under the new
tenant's identity.

## 1.11 RBAC composes on top

`requirePermission()` layers a fixed precedence over the tenant scope:

1. `is_platform_admin` → bypass all checks
2. `is_owner` → bypass, **except** `platform.admin`
3. Otherwise → require every named permission in the JWT's `permissions` array

Permissions are baked into the token at login, so the check is synchronous and
free. Note the trade-off: a permission change doesn't take effect until the next
token refresh (≤15 minutes).

WebSocket delivery is tenant-scoped the same way — `broadcastToTenant()` filters
sockets by the `tenantId` captured at connection time.

## 1.12 Rough edges worth fixing on the way out

**`withTenantContext` trusts its argument.** It takes a raw string. Nothing
verifies the value came from `req.user.tid` rather than `req.params.tenantId` or
a request body. The convention holds today, but a variant that takes the request
and reads the claim itself would make the safe path the only path.

**Transitive policies are easy to forget.** A new table with `connection_id`
instead of `tenant_id` gets no policy unless someone remembers. A schema linter
asserting "every table in `platform.*` either has both policies or appears on
the documented carve-out list" would close it.

**The reset costs a round-trip.** `resetRlsContext` runs a query on every
checkout. Correct, and cheap relative to the alternative — but it's real, and
worth knowing before someone "optimizes" it away.

---

# Part 2 — The prompt

> Fill in the blanks, then paste everything below the line.

**Blanks:**
- `<SERVICE>` — target service name
- `<REPO_PATH>` — where its data layer lives
- `<DB>` — database (this design assumes **PostgreSQL**; see the note in §1)
- `<SCOPE_NOUN>` — what a tenant is called here (organization, workspace, team)

---

## PROMPT

I want `<SERVICE>` to enforce multi-tenancy the way XRay BI does. Below is the
specification. Implement it in `<REPO_PATH>`, adapted to this codebase's
conventions. Match the **enforcement model and invariants**, not the file names.

Several sections say "XRay does X, you should do Y" — those are known weaknesses
in the reference implementation, called out deliberately.

### 1. Core principle

Tenant isolation is enforced **at the database**, not in application queries.
A developer who forgets `WHERE tenant_id = $1` must get zero rows, not another
tenant's data. Application-layer scoping is discipline; the database is the
enforcement.

This design depends on PostgreSQL row-level security. If `<DB>` is not Postgres,
tell me before starting — the equivalent for MySQL/SQLite is a mandatory
repository layer that no query can bypass, which is a genuinely different design
and I'd rather scope it explicitly than have you approximate it.

Three layers, in order:

1. **Request** — tenant identity as a claim in the signed session token
2. **Connection** — a named helper that sets the DB session context
3. **Row** — an RLS policy that gates every query regardless of its `WHERE`

### 2. Named context helpers — the heart of it

Create exactly these, and route **all** database access through them:

```ts
withTenantContext(tenantId, fn)   // default for all tenant-scoped work
withUserContext(tenantId, userId, fn)  // for per-user-scoped tables
withAdminClient(fn)               // explicit, opt-in cross-tenant bypass
withClient(fn)                    // no context, default-deny; unauth paths only
```

Plus transaction analogues for the first three.

**Bypass must be a function name you type, never a parameter you pass.** No
`{ bypassRLS: true }`, no boolean argument, no ambient flag. Reading across
tenants must require writing a distinctive identifier that greps cleanly and
stands out in review.

Document the rule in the project's `CLAUDE.md`/contributing guide: new code
defaults to `withTenantContext`; reaching for the admin helper on a path that
already has a tenant ID is a bug, not a shortcut.

### 3. Default-deny reset on every checkout — do not skip this

Every connection checkout must clear all context GUCs **before** running the
body:

```sql
SELECT set_config('app.current_tenant', '', false),
       set_config('app.current_user_id', '', false),
       set_config('app.is_platform_admin', 'false', false);
```

Connections are pooled and session GUCs survive release. Without this, a
checkout that ran under the admin helper hands the next borrower a silent
full-database bypass. The resulting leak is intermittent, load-dependent, and
effectively undebuggable. This is one query and it eliminates the entire bug
class.

### 4. The `is_local` trap

`set_config(key, value, is_local)`:

- `is_local = true` persists **only inside an explicit transaction**. Outside
  one, it applies to the implicit single-statement transaction and is gone by
  the next query.
- `is_local = false` is session-scoped and survives — which is why the reset in
  §3 is mandatory.

So: **non-transaction helpers use `false`; transaction helpers use `true`.**
Getting it backwards fails silently in both directions — `true` outside a
transaction means context never applies (empty results, the safe failure),
`false` without the reset means context leaks (the unsafe one).

### 5. Force RLS — the failure mode that hides for years

**Postgres bypasses RLS for table owners by default.** If your app connects as
the user that created the tables (the default in most Docker setups), your
policies attach, appear in `\d+`, and never fire. XRay shipped decorative RLS
for a long time before CI caught it.

Required:

```sql
ALTER TABLE <schema>.<table> FORCE ROW LEVEL SECURITY;
```

on every tenant-scoped table — **or** connect as a non-owner role with no
`BYPASSRLS`. Do both if you can.

Then verify it empirically, not by inspection. A policy you haven't watched
block a real query is a policy you don't have.

### 6. NULL-safe policy expressions

Once policies actually evaluate, naive expressions crash on unset GUCs:

```sql
current_setting('app.current_tenant', true)::uuid
-- ERROR: invalid input syntax for type uuid: ""
```

And critically: **Postgres evaluates every policy on a table; one raising aborts
the query** — even if another policy would have permitted the row. So an admin
context that doesn't set the tenant GUC will crash on the tenant policy.

Define helper functions and use them in every policy:

```sql
CREATE OR REPLACE FUNCTION app.current_tenant_id() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE AS
  $$ SELECT nullif(current_setting('app.current_tenant', true), '')::uuid $$;

CREATE OR REPLACE FUNCTION app.is_platform_admin() RETURNS boolean
  LANGUAGE sql STABLE PARALLEL SAFE AS
  $$ SELECT coalesce(current_setting('app.is_platform_admin', true), '') = 'true' $$;
```

`STABLE PARALLEL SAFE` lets the planner inline them — no per-row cost.

### 7. Policy shape

Two permissive policies per tenant-scoped table (permissive policies OR):

```sql
CREATE POLICY tenant_isolation ON <schema>.<table>
  USING      (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

CREATE POLICY platform_admin_bypass ON <schema>.<table>
  USING      (app.is_platform_admin())
  WITH CHECK (app.is_platform_admin());
```

Set **both `USING` and `WITH CHECK` explicitly**, even though Postgres defaults
the latter to the former — it documents that `INSERT` is gated too, and it
survives later edits.

For tables with no direct `tenant_id`, write a **transitive** policy that joins
through the owning table. These are the ones people forget, because there's no
column to prompt them.

### 8. Document the carve-outs

Not every table gets isolation. Write down each exception and its reasoning:

- **True globals** (roles, permissions, settings, the tenant registry itself) —
  no RLS.
- **Unauth-path tables** (login tokens queried before any session exists) — no
  context to gate on; the token is the capability.
- **Admin-only tables** — enable RLS with the bypass policy **only** and no
  isolation policy, so any code path in tenant context gets zero rows.

That last pattern matters: *omitting* a policy is a security decision. Write it
down where the next person will find it.

### 9. Make enforcement mechanical

**A pre-commit hook** that fails the commit when a file outside a documented
allow-list calls the unscoped `withClient(` helper. Keep the allow-list short,
annotate each entry with why it's there, and make the whole thing runnable
standalone in CI.

Explicitly ban the workaround in the contributing guide: constructing a local
bypass by calling the plain helper and setting the admin GUC inline is the same
anti-pattern wearing a different name.

**A cross-tenant probe** run in CI:
- create two synthetic tenants
- insert a row per RLS-enabled table for each
- switch into each tenant's context and assert it sees **only** its own rows
- verify the admin bypass sees both
- fail loudly on any leak; roll everything back at the end

Keep it out of the auto-applied migration directory — it has real write side
effects and must never run as part of a deploy.

This probe is not optional polish. It is the only thing that distinguishes real
isolation from decorative isolation, and it is what caught the owner-bypass bug.

### 10. Users are per-tenant rows

A person with access to three `<SCOPE_NOUN>`s gets **three user rows** — same
email, different tenant, independently assigned role. Not one global account
with a membership join table.

This is what makes isolation on the users table coherent, and it gives you
per-tenant roles and per-tenant deactivation for free. It also means login must
resolve *all* rows for an email and disambiguate when there's more than one —
see the auth-flow spec's tenant-picker step.

### 11. Switching tenants re-mints the session

Switching must issue a **complete new session** — new access token, new refresh
cookie, new CSRF token — through the same code path as logging into that tenant.
Never patch a claim, never set a client-side filter.

The client then discards all view state and re-initializes from scratch. Because
tenant identity lives in the signed token, there is no window where a stale view
holds the previous tenant's data under the new tenant's identity.

### 12. Layer RBAC on top

Fixed precedence:
1. platform admin → bypass all permission checks
2. tenant owner → bypass, except platform-level permissions
3. otherwise → require every named permission

Bake permissions into the session token so checks are synchronous. Know the
trade-off you're accepting: permission changes don't take effect until the next
token refresh. If that's unacceptable for your threat model, check the DB
instead and cache with explicit invalidation.

Scope real-time delivery the same way — filter sockets by the tenant captured at
connection time. A global broadcast in a multi-tenant system is a data leak
waiting for its first payload change.

### 13. Improve on the reference where noted

**Bind tenant context to the verified claim.** XRay's `withTenantContext` takes a
raw string, so nothing stops a caller passing `req.params.tenantId`. Provide a
variant that takes the authenticated request and reads the claim itself, and make
that the documented default — the safe path should be the easy one.

**Add a schema linter** asserting that every table in the tenant schema either
carries both policies or appears on the documented carve-out list. Transitive
cases have no `tenant_id` column to jog anyone's memory.

### 14. Acceptance criteria

- [ ] A query with no `WHERE tenant_id` clause, run under tenant context,
      returns only that tenant's rows
- [ ] The same query under a different tenant's context returns disjoint rows
- [ ] The cross-tenant probe runs in CI and fails the build on a leak
- [ ] `FORCE ROW LEVEL SECURITY` verified on every tenant-scoped table, **and**
      demonstrated to actually block a query as the connecting user
- [ ] Policies do not raise when the tenant GUC is unset (admin context works)
- [ ] `INSERT` of a row belonging to another tenant is rejected by `WITH CHECK`
- [ ] An admin-context checkout followed by a tenant-context checkout on the
      **same pooled connection** shows no context bleed
- [ ] Tables without a direct tenant column are gated transitively
- [ ] The pre-commit hook rejects a new unscoped helper call outside the
      allow-list
- [ ] Switching tenants issues a new token and fully re-initializes the client
- [ ] Real-time messages reach only the originating tenant's sockets
- [ ] Every carve-out table has a written, findable justification

## END PROMPT
