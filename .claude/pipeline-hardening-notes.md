# Pipeline DB hardening — design notes

Captures decisions reached in the Apr 22 session so they aren't lost
before the pipeline-DB-hardening step is actually implemented. This is
NOT a step kickoff doc; it's a future-looking commitment log that step-N
kickoffs should consult when they're drafted.

## Target architecture

Three Postgres instances stay separate:

1. **Platform DB** — tenants, users, dashboards, encrypted OAuth refresh
   tokens. Small. Local/cheap backups. Restore = pull app, restore DB,
   re-seed via API (first signup already has to pull "last year/two"
   of source data anyway, so restore seeding is an existing code path).
2. **n8n DB** — self-contained. Noisy. Separate cadence. Not touched.
3. **Pipeline / data-lake DB** — per-tenant data. Currently one hard-coded
   setup (single client, pipeline is still in development). New tenant
   onboarding needs to be built out; migrating the existing hard-coded
   client onto the "created tenant + provisioned role" path is a
   one-off migration task that precedes broader rollout.

## Hardening model: D → J, staged

### Model D (first)

- Every pipeline table carries `tenant_id UUID NOT NULL`.
- `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` + tenant_isolation policy
  on every pipeline table.
- n8n connects as a non-superuser `pipeline_user` role with grants but
  without table ownership (so RLS bites).
- n8n workflows call `SELECT set_config('app.current_tenant', $jwt.tenant_id, true)`
  as the first step in every pipeline-touching transaction.

Rollout pattern: permissive policy (`OR current_setting(...) = ''`) per
table, flip to strict once all relevant workflows are updated. No flag
day; one table at a time.

**Status at D:** pipeline DB trusts whatever `app.current_tenant` is
set to. Compromise of n8n = can set any tenant_id. D is the bar for
"better than today" and good for a SOC 2 readiness gap analysis, but
it is NOT where we stop.

### Model J (target)

Upgrade from D once pgjwt is installed and an RS256 keypair is
provisioned:

- `pipeline.authorize(token text)` SECURITY DEFINER function:
  1. Verifies RS256 signature against a public key stored in the
     pipeline DB. Private key lives only on the platform.
  2. Checks `iss='xray'`, `aud='xray-pipeline'`, `exp > now()`.
  3. Extracts `tenant_id` from claims, calls `set_config('app.current_tenant', ..., true)`.
  4. Also sets `app.acting_user_id` from the JWT's `user_id` claim
     (nullable — absent on public_share).
  5. **Inserts a row into `pipeline.access_audit`** (see below).
- Per-tenant Postgres role `tenant_<uuid>` provisioned at tenant-
  signup time with grants scoped to that tenant's rows/schema.
- `pipeline.authorize()` does `SET ROLE tenant_<uuid>` after verifying.
  Queries after this point run under the tenant's role.
- n8n's one service credential can `SET ROLE` to any `tenant_*` via
  the SECURITY DEFINER wrapper, but cannot bypass RLS directly.

Data-access token is a **second, separate** JWT from the n8n-bridge JWT:

- Bridge JWT: HS256 per-dashboard secret, `aud='n8n'`. Verified by
  n8n's native JWT Auth node. Carries all the labels (tenant_id,
  dashboard_id, user_id, is_platform_admin, via, …).
- Data-access token: RS256, `aud='xray-pipeline'`. Verified by
  `pipeline.authorize`. Minimal claims: tenant_id, user_id,
  is_platform_admin, via, jti, exp. Platform mints both in parallel
  and hands them to n8n together in the render response.

## DB-side audit log (Option B, committed)

Confirmed direction for Model J. Rationale: Option B keeps audit
trail inside the pipeline DB itself — SOC 2 Type II auditors are
comfortable with DB-side access logging and uncomfortable with
"audit is in application logs only" stories.

### Schema

```sql
CREATE TABLE pipeline.access_audit (
  id                BIGSERIAL PRIMARY KEY,
  connected_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  jti               UUID NOT NULL,
  tenant_id         UUID NOT NULL,
  acting_user_id    UUID,          -- null on public_share
  is_platform_admin BOOLEAN NOT NULL,
  via               TEXT NOT NULL, -- mirrors the JWT `via` claim
  session_pid       INTEGER NOT NULL DEFAULT pg_backend_pid()
);

CREATE INDEX ON pipeline.access_audit (tenant_id, connected_at DESC);
CREATE INDEX ON pipeline.access_audit (jti);
```

- One row per `pipeline.authorize()` call. Retention policy TBD
  (likely 1-2 years, rolling partition).
- `jti` lets us cross-reference with XRay's own `platform.audit_log`
  and with n8n execution history — the triangulation that makes a
  leaked-token trail actually traceable.
- `is_platform_admin` + `via` captures impersonation explicitly.
  `via='admin_impersonation'` rows in this table are the set
  an auditor asks for during a SOC 2 review.

### Retention + access

- No UPDATE/DELETE from the `pipeline_user` role (append-only).
- Platform ops role can read the audit table for forensics.
- Expect this table to be the second-largest by row count after
  tenant data itself; size accordingly.

## Platform admin impersonation

Landed in the JWT labels PR (Apr 22):

- `via: 'admin_impersonation'` emitted when
  `req.user.is_platform_admin && dashboard.tenant_id !== req.user.tid`.
- `user_id`, `user_email`, `user_name`, `user_role`, `is_platform_admin`
  all carry the impersonating admin's identity.
- Audit log row (`platform.audit_log.action = 'dashboard.bridge_mint'`)
  records `via: 'admin_impersonation'` — step-1 of the SOC 2 trail.
- Step-2 (DB-side `pipeline.access_audit` row) lands with Model J.

## Ordering and dependencies

1. **Step 3** — schema refactor / drop fetch_headers. Independent of
   pipeline hardening. Kick off on a fresh branch per existing pattern.
2. **Step 4** — OAuth access_token population. Provision RS256 keypair
   here (piggyback since it's "platform mints more tokens"). Start
   minting the data-access token alongside the n8n-bridge JWT even
   before the pipeline DB starts consuming it.
3. **Step 6** — platform DB RLS fix (the decorative-RLS finding from
   step 1). Prerequisite for Model D to give you real isolation on
   the platform DB.
4. **Pipeline hardening Phase A (Model D)** — add `tenant_id` column
   where missing, backfill, RLS + permissive policy, update workflows
   to set `app.current_tenant`, flip to strict per table.
5. **Pipeline hardening Phase B (Model J)** — install pgjwt, add
   `pipeline.authorize()` with audit-row insert, add `pipeline.access_audit`,
   cut workflows over from `set_config` to `pipeline.authorize(token)`.
   Migrate existing hard-coded client onto per-tenant role provisioning
   in the same window.

## Non-goals for this track

- **Full consolidation of platform + pipeline into one DB.** Decided
  against — keeping three DBs lets backups/ops stay split by concern.
- **n8n DB consolidation.** Never.
- **HIPAA now.** SOC 2 Type II is the aspirational target; HIPAA is
  "infrastructure ready if ever needed," not a current requirement.

## Open items to resolve before Phase A kicks off

- Does the current hard-coded pipeline setup already have `tenant_id`
  on every table, or is that structural work?
- Migration plan for the one existing client from hard-coded to
  provisioned (tenant row, role creation, table row re-keying).
- Workflow inventory — how many n8n workflows currently touch the
  pipeline DB, so we can size the rollout.
