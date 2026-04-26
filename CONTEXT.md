# XRay VPS Bridge — session context

This file tracks state left behind by each bridge step so the next
session can pick up without re-reading the whole repo. See the session
prompt for the full five-step arc.

---

## Step 1 — Encrypt tenant credentials (shipped)

### What changed

- `server/src/lib/encrypted-column.ts` — new. Wraps `crypto.ts` with a
  versioned `enc:v1:` envelope. Exports `encryptSecret` / `decryptSecret`
  for TEXT columns and `encryptJsonField` / `decryptJsonField` for JSONB.
  Transitional read path accepts plaintext rows and emits one WARN per
  `(table, column, row_id)` triple.
- `server/src/lib/encrypted-column.test.ts` — 12 vitest specs covering
  round-trip, null/empty, tamper, transitional fallback, and the per-row
  WARN semantics. First unit tests in the repo.
- Write-path encryption wired in `services/admin.service.ts`
  (`createDashboard`, `updateDashboard`, `createConnection`,
  `updateConnection`) and `services/webhook.service.ts` (`createWebhook`,
  `regenerateSecret`).
- Read-path decryption wired in `routes/dashboard.routes.ts` (`/:id/render`),
  `services/dashboard.service.ts` (public embed render),
  `services/admin.service.ts` (`fetchDashboardContent`, list/create/update
  connection), `services/connection.service.ts` (list, get).
- `services/webhook.service.ts` — `getWebhook` and `updateWebhook` no
  longer return the `secret` column at all (they used to, which leaked
  plaintext). `createWebhook` and `regenerateSecret` still return the
  plaintext to the caller once — that's the documented contract for
  those endpoints and is required for the client to verify HMACs.
- `migrations/017_encrypt_tenant_credentials.sql` + `.down.sql`. Triggers
  on `platform.webhooks.secret`, `platform.connections.connection_details`,
  `platform.dashboards.fetch_headers`. Reject non-envelope writes. UPDATE
  triggers scoped `OF <column>` so unrelated row updates don't pay the
  validation cost.
- `server/scripts/backfill-encrypt-credentials.ts` — idempotent rewrite
  of plaintext rows to `enc:v1:`. Supports `--dry-run`. npm alias:
  `npm run backfill:encrypt-credentials`.

### Deploy order on the VPS

`update.sh` and `install.sh` now handle all three steps end-to-end in
the correct order. For manual deploys or out-of-band runs:

1. **Deploy new server code.** Writes encrypt, reads tolerate both
   formats. Safe to run against a DB that still has plaintext rows.
   `update.sh` step 4 (`docker compose build --no-cache && up -d`).
2. **Apply migration 017.** Scripts iterate `migrations/*.sql` and pick
   it up automatically. The down migration lives under `migrations/down/`
   so the glob does not execute it. Existing plaintext rows are
   untouched (trigger only fires on INSERT/UPDATE). Manual equivalent:
   `psql $DATABASE_URL -f migrations/017_encrypt_tenant_credentials.sql`.
3. **Run the backfill.** `update.sh` step 5b runs
   `docker compose exec -T server node dist/scripts/backfill-encrypt-credentials.js`
   after migrations. Idempotent — rerun-safe. Manual equivalent:
   ```
   docker compose exec -T server node dist/scripts/backfill-encrypt-credentials.js
   ```
   For a dev machine outside the container:
   `cd server && npm run backfill:encrypt-credentials:dev`.

After step 3 you can `SELECT` any of the three columns and confirm every
non-null value either equals `''`/`{}` or matches `enc:v1:%` / `{"_enc":"enc:v1:%"}`.

### Env changes

- No new env vars. Uses the existing `ENCRYPTION_KEY` (64-char hex, 256-bit).
- Required in every environment that boots the server OR runs the backfill:
  `DATABASE_URL`, `JWT_SECRET`, `ENCRYPTION_KEY`.

### Schema changes

- No column types or defaults changed.
- Triggers + two trigger functions added to `platform` schema.
- `init.sql` was NOT updated — the numbered migrations in `/migrations/`
  are the source of truth for changes since init. Follow the existing
  pattern.

### Known follow-ups not done this session

- **RLS is effectively decorative in the current deploy — critical for
  step 6.** Empirically verified during the step-1 review:
  1. The `set_config(..., 'true')` pattern used throughout the services
     does not persist the GUC to subsequent `client.query()` calls. Each
     query is its own autocommit transaction, and `SET LOCAL` unwinds at
     transaction end. I reproduced this by running the exact XRay
     pattern against a local Postgres 16 via node-postgres: the query
     after `set_config` throws `invalid input syntax for type uuid: ""`
     when the RLS policy dereferences `current_setting('app.current_tenant', true)::uuid`.
  2. The masking factor: in Docker, `POSTGRES_USER` creates a superuser,
     and the role owns `platform.*` tables. Both superuser and table
     owner bypass RLS by default (no `ALTER TABLE ... FORCE ROW LEVEL SECURITY`
     is set). So the policies never actually filter; tenant isolation in
     prod comes from explicit `WHERE tenant_id = $1` in services.
  3. Step-1 work is unaffected — triggers fire for all roles, and the
     backfill script uses `is_local=false` (session-scoped, verified to
     persist). But step 6 needs to address: (a) run the app as a
     non-superuser non-owner role, (b) enable FORCE ROW LEVEL SECURITY
     on tenant tables, (c) fix the `set_config` pattern by wrapping in
     explicit transactions or switching to `is_local=false`, (d) use
     `withTenantContext` consistently. All four likely; pick one as the
     entry point and the others fall out.
- **`GET /api/embed/:token` is unauthenticated and returns the whole
  dashboard row**, including `fetch_url` and (now-decrypted)
  `fetch_headers`. This is a pre-existing design flaw, not a regression
  from step 1 — the same endpoint returned plaintext before encryption
  was introduced. Proper fix is to project only `view_html`, `view_css`,
  `view_js`, and `name` from the embed endpoint. Out of scope for
  credentials-at-rest; address before any embed tokens land in the wild.
  Same caveat applies in a weaker form to the authenticated
  `GET /dashboards/:id` and the public `/share/:token` path — authed
  users with `dashboards.view` see the row today, which is a
  permission-model question rather than an encryption question.
- **`dashboards.fetch_body`** (JSONB) is not encrypted. Today it holds
  static template/tenant params rather than credentials, but it will
  hold the n8n JWT in step 2 — revisit encryption scope when step 2
  decides whether the body carries anything credential-like.
- **Plaintext read fallback in `encrypted-column.ts`** is still there.
  Leave it until the VPS is backfilled and there's been a few days of
  clean logs (zero WARN lines). Removing it is a one-line change in a
  future session; flag it in the follow-up list rather than doing it
  blind.
- **`withClient` → `withTenantContext` migration** across services is
  explicitly **Step 6**, not this session. Do not fold it into
  intermediate steps. Raw `withClient` + inline `set_config` is still
  the norm across most services.
- **Portability export/import** is unchanged. Encrypted values
  round-trip because the same `ENCRYPTION_KEY` travels with the
  platform env. A platform-admin JSON export is no longer
  human-readable — expected.

### Verify on VPS after deploy

```sql
-- Everything non-null/non-empty should match the envelope.
SELECT id FROM platform.webhooks
  WHERE secret IS NOT NULL AND secret <> '' AND secret NOT LIKE 'enc:v1:%';
SELECT id FROM platform.connections
  WHERE connection_details IS NOT NULL AND connection_details <> ''
    AND connection_details NOT LIKE 'enc:v1:%';
SELECT id FROM platform.dashboards
  WHERE fetch_headers IS NOT NULL AND fetch_headers <> '{}'::jsonb
    AND NOT (fetch_headers ? '_enc' AND fetch_headers->>'_enc' LIKE 'enc:v1:%');
```

All three should return zero rows post-backfill. Also tail the server
logs — zero `[encrypted-column] plaintext row detected` WARNs means the
backfill is complete and it's safe to retire the fallback later.

---

## Step 2 — XRay ↔ n8n JWT bridge (shipped)

### What changed

- `server/src/lib/n8n-bridge.ts` — new. `mintBridgeJwt({ tenantId,
  integration, secret, userId?, templateId?, accessToken?, params? })`
  signs an HS256 token with `iss='xray'`, `aud='n8n'`, `sub=tenant_id`,
  `jti=UUID`, `iat`/`exp` (60 s lifetime), plus `user_id`,
  `template_id`, `integration`, `access_token`, `params`. Unset optional
  claims are **absent**, not empty — keeps n8n-side validation from
  seeing false-signal nulls. Also exports `generateBridgeSecret()`
  (48 bytes of `randomBytes` → base64url) used by the admin UI's
  Generate button.
- `server/src/lib/n8n-bridge.test.ts` — 7 vitest specs. Claim shape,
  absent-vs-present optionals, `jti` uniqueness, input validation,
  cross-secret rejection (per-dashboard isolation), generator shape.
- `server/src/config.ts` — new `config.n8nBridge` block: platform-wide
  `issuer: 'xray'`, `audience: 'n8n'`, `expirySeconds: 60`. **No env
  var** — the signing secret is per-dashboard (see migration 019).
- `server/src/routes/dashboard.routes.ts` — authed `POST /:id/render`
  branches on `dashboards.integration`:
  - non-null → decrypt the dashboard's `bridge_secret`, mint JWT with
    that secret, send as `Authorization: Bearer`, audit
    `dashboard.bridge_mint` with metadata `{ jti, integration,
    template_id, via: 'authed_render' }`. Returns `500
    BRIDGE_SECRET_MISSING` if the row has `integration` but no
    `bridge_secret`.
  - null → legacy `fetch_headers` path, unchanged.
  SELECT list expanded to include `tenant_id`, `template_id`,
  `integration`, `params`, `bridge_secret`.
- `server/src/services/dashboard.service.ts` — same branching in
  `renderPublicDashboard`. `user_id` claim absent for public share.
  Audit metadata records `via: 'public_share'` plus the first 8 chars
  of the share token for triangulation. New internal helper
  `fetchBridgeSecretCiphertext(dashboardId)` — decryptor strips
  `bridge_secret` from rows by default, so render sites re-fetch the
  ciphertext with this helper and decrypt inline. Guarantees the
  admin/share GET responses can never leak the secret.
- `server/src/services/admin.service.ts` —
  - `fetchDashboardContent` (admin preview) branches the same way with
    `via: 'admin_preview'`.
  - `createDashboard` accepts `templateId`, `integration`, `params`,
    `bridgeSecret`. Throws `BRIDGE_SECRET_REQUIRED` if `integration`
    is set but `bridgeSecret` is empty. Encrypts the secret before
    insert.
  - `updateDashboard` extended to accept `bridgeSecret`. New
    consistency check: if the post-update row will carry a non-empty
    `integration`, it must also have a non-empty `bridge_secret` —
    either on the existing row or supplied in the patch. Empty string
    on either clears back to the legacy path.
  - `decryptDashboardRow` strips `bridge_secret` from every returned
    row and surfaces `bridge_secret_set: boolean` instead. Ciphertext
    and plaintext never reach the API response.
- `server/src/lib/validation.ts` — `dashboardCreateSchema` /
  `dashboardUpdateSchema` extended with `templateId`, `integration`,
  `params`, `bridgeSecret`.
- `server/src/services/portability.service.ts` — export/import column
  list extended with `template_id`, `integration`, `params`,
  `bridge_secret` so round-trips preserve bridge config (ciphertext
  stays encrypted on export).
- `frontend/bundles/general.json` — admin dashboard builder gets a new
  **n8n Bridge (JWT auth)** card between Connection and Appearance.
  Fields: Integration, Template ID, Params (JSON), **Bridge signing
  secret** (masked password input + Generate + Show/Hide). Generate
  uses `window.crypto.getRandomValues` for base64url on the client so
  the plaintext never round-trips through the server until save.
  Client-side guard refuses to save when Integration is set but no
  secret is stored and none entered. Load path reads
  `bridge_secret_set` (boolean) and displays status text; never asks
  the server for the plaintext.
- `migrations/018_dashboards_bridge_config.sql` (+ companion under
  `down/`) — adds `template_id TEXT`, `integration TEXT`, `params
  JSONB NOT NULL DEFAULT '{}'`. Additive, idempotent. No encryption
  trigger — routing data, not credentials.
- `migrations/019_dashboard_bridge_secret.sql` (+ down) — adds
  `bridge_secret TEXT` and the `enforce_enc_dashboards_bridge_secret`
  trigger (same `enc:v1:` envelope contract as migration 017).
  Rejects plaintext writes at the DB layer.
- **Deploy scripts reordered so migrations run BEFORE the server
  rebuild.** `update.sh` and `deploy.sh` used to rebuild the container
  first and migrate after — that window let new code SELECT columns
  the DB didn't have yet. Fix: additive-DDL migrations go before the
  rebuild; the backfill stays after (it needs the server container).

### Env changes

- **No new env vars.** The bridge secret is per-dashboard (migration
  019), stored encrypted on `platform.dashboards.bridge_secret`.
- Required in every environment that boots the server:
  `DATABASE_URL`, `JWT_SECRET`, `ENCRYPTION_KEY`.

### Schema changes

- Four additive columns on `platform.dashboards`:
  `template_id TEXT`, `integration TEXT`, `params JSONB NOT NULL
  DEFAULT '{}'::jsonb`, `bridge_secret TEXT`.
- One new trigger + function:
  `enforce_enc_dashboards_bridge_secret` guards `bridge_secret` under
  the same `enc:v1:` contract as migration 017.
- Existing rows need no backfill. The JSONB default covers `params`,
  the TEXT columns are nullable, and legacy dashboards (no
  `integration`) continue on the `fetch_headers` path untouched.
- `init.sql` was NOT updated (same convention as step 1; numbered
  migrations are source of truth post-init).

### Secret model — why per-dashboard

A single platform-wide signing secret meant one leak compromised every
integration across every tenant. Per-dashboard means:

- The blast radius of a leaked secret is exactly one dashboard.
- Rotating one dashboard's secret doesn't coordinate a maintenance
  window across every n8n workflow.
- Each n8n workflow owns its own "JWT Auth" credential — matches n8n's
  native credential-per-workflow model.
- The future "global dashboard template + per-tenant attribution" model
  extends naturally: each template row owns its own secret, each
  tenant-dashboard inherits or overrides per row.

### How n8n validates (the other side of the contract)

One-time setup **per dashboard / per workflow**:

1. In XRay's dashboard builder, click Generate on the Bridge signing
   secret field (or paste one you already minted elsewhere). Copy the
   value. Click Show to reveal it.
2. In n8n, create a credential of type "JWT Auth": algorithm HS256,
   secret = the value you just copied. Name it after the dashboard
   (e.g. `XRay Bridge — HCP Technician`).
3. On the Webhook node for that workflow, set Authentication → JWT
   Auth → that credential. n8n verifies signature + `exp` automatically.
4. In a downstream Set/Code node: assert `$json.iss === 'xray'`,
   `$json.aud === 'n8n'`, extract `sub` (tenant_id), `user_id`,
   `template_id`, `integration`, `access_token`, `params`. Route on
   `integration` or `template_id`.
5. Log `jti` on the n8n side so a leaked token's trail exists on both
   systems.

### Opting a dashboard onto the JWT path

Admin UI: populate the **Integration** field AND set a **Bridge
signing secret** on the dashboard builder. Generate auto-fills a
48-byte base64url value; Paste works too. Save fails with a clear
error if Integration is set without a secret. Empty Integration =
legacy `fetch_headers` path.

SQL opt-in for batch work is discouraged because the secret has to
be encrypted under the `enc:v1:` envelope before it hits the DB.
The admin UI is the supported entry point.

### Known follow-ups not done this session

- **`Auth Bearer Token` / `Headers` form fields** on the builder are
  dead for JWT-path dashboards. Kept visible so legacy dashboards can
  still be edited. Step 3's schema refactor drops `fetch_headers`;
  that's the right time to remove these form fields.
- **`access_token` claim** is always absent this session. Step 4
  (OAuth integration handling) is where XRay looks up the tenant's
  per-integration token from `platform.connections.connection_details`
  and passes it through.
- **"Dashboards defined once, tenants auto-inherit via connection
  source_type"** is a post-step-5 concern. `integration`, `template_id`,
  and `bridge_secret` are all per-row today; global-template modeling
  is a separate redesign.
- **`dashboards.fetch_body` encryption** — moot. The JWT travels in
  the Authorization header, never in the body. `fetch_body` stays
  available for legacy payloads.
- **RLS is still decorative** (documented under step 1). Unchanged by
  step 2.
- **Plaintext-read fallback in `encrypted-column.ts`** still in place.

### Verify on VPS after deploy

```sql
-- Migration 019 trigger is installed.
SELECT trigger_name FROM information_schema.triggers
 WHERE trigger_name='enforce_enc_dashboards_bridge_secret';

-- Every non-null bridge_secret matches the envelope. Zero rows = clean.
SELECT id FROM platform.dashboards
 WHERE bridge_secret IS NOT NULL AND bridge_secret <> ''
   AND bridge_secret NOT LIKE 'enc:v1:%';

-- Audit-log the mint trace after a render:
SELECT created_at, action, resource_id,
       metadata->>'jti' AS jti,
       metadata->>'integration' AS integration,
       metadata->>'via' AS via
  FROM platform.audit_log
 WHERE action='dashboard.bridge_mint'
 ORDER BY created_at DESC LIMIT 5;
```

---

## Interlude — JWT labels + pipeline hardening plan (shipped)

Session between step 2 and step 3. Expanded the bridge JWT claim set so
n8n and any downstream DB verifier have first-class access to tenant,
dashboard, user, and call-site context without a second round-trip to
the platform. Also captured the three-Postgres design decisions that
will drive the pipeline-hardening work after step 6.

### What changed

- `server/src/lib/n8n-bridge.ts` — `BridgeJwtInput` extended with
  tenant labels (`tenantSlug`, `tenantName`, `tenantStatus`,
  `warehouseHost`), dashboard labels (`dashboardId`, `dashboardName`,
  `dashboardStatus`, `isPublic`), user labels (`userEmail`, `userName`,
  `userRole`, `isPlatformAdmin`), and a `via` tag. Helper
  `setIfPresent` keeps unset optional fields absent rather than null,
  while preserving boolean `false`. `BridgeVia` type is
  `'authed_render' | 'admin_impersonation' | 'public_share' |
  'admin_preview'`.
- `server/src/lib/n8n-bridge.test.ts` — 7 specs → 12 specs. Covers
  full claim snapshot, sub==tenant_id invariant, public_share user
  absence, admin_impersonation and admin_preview acting-admin claims,
  empty-string-vs-absent semantics, boolean preservation.
- `server/src/routes/dashboard.routes.ts` — authed render SELECT now
  `JOIN platform.tenants` + `LEFT JOIN platform.users` + `LEFT JOIN
  platform.roles` on the acting user. Computes
  `via: 'admin_impersonation'` when
  `is_platform_admin && dashboard.tenant_id !== req.user.tid`, else
  `'authed_render'`. Both the JWT claim and the audit_log row record
  the same computed value so the impersonation trail is self-contained
  in `platform.audit_log`.
- `server/src/services/dashboard.service.ts` — added
  `fetchTenantLabels(tenantId)` helper. `renderPublicDashboard`
  passes tenant labels + dashboard labels into `mintBridgeJwt` with
  `via: 'public_share'`; user_* claims intentionally absent.
- `server/src/services/admin.service.ts` — `fetchDashboardContent`
  now accepts `adminUserId`. SELECT adds the same JOINs; emits
  `via: 'admin_preview'` with the acting admin's user row (LEFT JOIN
  tolerates missing rows for platform admins outside the target
  tenant).
- `server/src/routes/admin.routes.ts` — threads `req.user?.sub`
  through to `adminService.fetchDashboardContent`.
- `.claude/pipeline-hardening-notes.md` — new. Captures: the
  three-Postgres target architecture (platform / n8n / data-lake, no
  consolidation); staged Model D → J pipeline-DB hardening plan;
  Option B (DB-side `pipeline.access_audit` table inserted by
  `pipeline.authorize` SECURITY DEFINER function) as the SOC 2-aligned
  audit approach committed for Model J; platform-admin impersonation
  semantics under D/J; open items (does the one current hard-coded
  client's tables already have `tenant_id`, workflow inventory,
  migration plan for the existing client).

### Deploy surface

No new env vars, no new migrations, no new npm deps, no docker-compose
changes. `update.sh` and `install.sh` both accommodate this without
modification — the SELECT JOINs target columns that have existed since
init.sql day one (`platform.tenants.{slug,name,status,warehouse_host}`,
`platform.users.{email,name,role_id}`, `platform.roles.slug`). RLS
behavior is preserved: tenants and roles have no RLS; users' JOIN
satisfies either `tenant_isolation` (tenant user) or
`platform_admin_bypass` (admin) depending on which GUCs are set.

### Claim set (final, what n8n sees)

Always present: `iss`, `aud`, `sub` (= tenant_id), `jti`, `iat`, `exp`,
`tenant_id`, `integration`, `params`, `via`.

Always present when loaded from `platform.tenants`: `tenant_slug`,
`tenant_name`, `tenant_status`. Absent when null: `warehouse_host`.

Always present when loaded from `platform.dashboards`: `dashboard_id`,
`dashboard_name`, `dashboard_status`, `is_public`. Absent when null:
`template_id`.

Present on authed_render / admin_impersonation / admin_preview, absent
on public_share: `user_id`, `user_email`, `user_name`, `user_role`,
`is_platform_admin`.

Still absent until step 4: `access_token`. Step 4 populates it from
the tenant's OAuth refresh-token lookup.

### Naming

`sub` is kept equal to `tenant_id` so n8n's native JWT Auth node (which
reads `sub`) continues working unchanged. All new claims are flat and
domain-prefixed (`tenant_*`, `dashboard_*`, `user_*`) — no nested
objects, so n8n Set/Code nodes read them as `$json.tenant_slug` etc.

### Platform admin impersonation (handled, SOC 2-ready at app layer)

A platform admin clicking any tenant's dashboard already worked under
step 2 — the platform picks the target tenant as `sub` at mint time.
This session added explicit labeling: the `via: 'admin_impersonation'`
value plus the user_* claims + `is_platform_admin: true` make every
cross-tenant render an auditable, signed, 60-second event. Model J
will layer a DB-side audit row on top (Option B in the pipeline notes)
so the trail exists in both `platform.audit_log` and
`pipeline.access_audit` — the SOC 2 Type II "access logging lives in
the database" bar.

### Known follow-ups not done this session

- **Step 3 cutover** is still untouched. See `.claude/step-3-kickoff.md`.
- **Access token population** (step 4) still absent from the JWT.
- **Pipeline hardening (Models D / J)** — design fully specified in
  `.claude/pipeline-hardening-notes.md`; not built. Phase A (Model D)
  blocked on step 6's platform-RLS fix landing first.
- **RLS-is-decorative finding** from step 1 still stands.
- **Plaintext-read fallback** in `encrypted-column.ts` still in place.

### Verify on VPS after deploy

```sql
-- New via values appear in bridge_mint audit rows.
SELECT metadata->>'via' AS via, count(*)
  FROM platform.audit_log
 WHERE action = 'dashboard.bridge_mint'
   AND created_at > now() - interval '1 day'
 GROUP BY 1;

-- An admin rendering someone else's dashboard leaves a clean trail.
SELECT created_at, user_id, tenant_id, metadata->>'jti' AS jti
  FROM platform.audit_log
 WHERE action = 'dashboard.bridge_mint'
   AND metadata->>'via' = 'admin_impersonation'
 ORDER BY created_at DESC LIMIT 5;
```

---

## Step 3 — Schema refactor: drop fetch_headers, collapse render paths (shipped)

First destructive migration in the bridge arc. By step 3 every dashboard
on the VPS is already carrying an `integration` + encrypted
`bridge_secret` (steps 2 + the JWT-labels interlude), so the legacy
`fetch_headers` headers path and its admin-UI form fields are dead weight.
Step 3 removes them.

### What changed

- `migrations/020_drop_dashboards_fetch_headers.sql` (+ down) —
  `DROP TRIGGER enforce_enc_dashboards_fetch_headers`, `DROP FUNCTION
  platform.require_enc_dashboards_fetch_headers`, `ALTER TABLE
  platform.dashboards DROP COLUMN fetch_headers`. Down re-adds the
  column as nullable JSONB with **no** trigger — by the time a rollback
  is plausible, no code path produces enc-envelope values for it, and a
  guardrail that rejects unencrypted writes would only block manual
  recovery. The two other migration-017 triggers
  (`enforce_enc_webhooks_secret`,
  `enforce_enc_connections_details`) stay in place.
- `server/src/routes/dashboard.routes.ts` — authed render SELECT drops
  `d.fetch_headers`. Legacy `else { fetch_headers }` branch gone. New
  invariant: a dashboard with `fetch_url` but no `integration` errors
  with `BRIDGE_INTEGRATION_MISSING` (500). Cutover-safety guarantees
  this never fires on `status='active'`. JOIN shape, `via` compute
  (`authed_render` vs `admin_impersonation`), and the full
  `mintBridgeJwt` call (tenant_*, dashboard_*, user_*, isPlatformAdmin,
  params, per-site `via`) unchanged. `decryptJsonField` import dropped.
- `server/src/services/dashboard.service.ts` — same collapse in
  `renderPublicDashboard`. `Dashboard` interface loses `fetch_headers`.
  `decryptDashboardRow` no longer decrypts `fetch_headers`; still
  redacts `bridge_secret`. `fetchTenantLabels` + `fetchBridgeSecretCiphertext`
  + `via: 'public_share'` all preserved verbatim. `decryptJsonField`
  import dropped.
- `server/src/services/admin.service.ts` — `fetchDashboardContent`
  (admin preview) collapses onto the JWT-only path with
  `via: 'admin_preview'`. `createDashboard` / `updateDashboard` drop
  the `fetchHeaders` parameter + the `fetch_headers` INSERT/UPDATE
  column. `encryptJsonField` / `decryptJsonField` imports dropped
  (helpers themselves stay; `connection_templates` uses the text form
  and future columns may still want the JSONB variant).
- `server/src/lib/validation.ts` — `fetchHeaders` removed from
  `dashboardCreateSchema` / `dashboardUpdateSchema`.
  `connectionTemplateCreateSchema.fetchHeaders` stays — template-authoring
  is a separate write surface for `platform.connection_templates`.
- `server/src/services/portability.service.ts` — `fetch_headers` removed
  from the dashboards import column whitelist. Older exports that still
  carry the field are silently ignored at import time.
- `server/src/scripts/backfill-encrypt-credentials.ts` — dropped the
  `backfillJsonb('dashboards.fetch_headers', ...)` call and the
  `encryptJsonField` import + `isEncryptedJsonb` helper. The two
  remaining TEXT backfills (webhooks.secret, connections.connection_details)
  are unchanged.
- `frontend/bundles/general.json` — `views.admin_builder`:
  - HTML: removed the `Auth Bearer Token` field (`#build-auth-token`)
    and the `Headers (JSON)` textarea (`#build-headers`). Reworded the
    n8n Bridge card blurb — no legacy path to contrast with now.
  - JS: removed the save handler's Headers parse + `authToken`→header
    merge, the edit loader's "extract auth token from fetch_headers"
    block, the template-apply's `fetch_headers`→`#build-headers` line,
    and `fetchHeaders: headers` from the dashboards create/update
    payload. Save-as-template no longer sends `fetchHeaders` or
    `fetchQueryParams` (the latter was a closure leak referring to an
    outer-scope var that no longer exists after this cleanup).
  - Bundle version bumped to `2026-04-22-020`.

### Cutover-safety check (operator runs on VPS, before migration 020 applies)

Both queries must return zero rows. Rerun after any remediation and
before letting `update.sh` apply migration 020:

```sql
-- Active dashboards still on the legacy headers path:
SELECT id, tenant_id, name
  FROM platform.dashboards
 WHERE status = 'active'
   AND (integration IS NULL OR integration = '')
   AND fetch_url IS NOT NULL;

-- Integration set without a bridge_secret (pre-019 drift):
SELECT id, tenant_id, name
  FROM platform.dashboards
 WHERE integration IS NOT NULL AND integration <> ''
   AND (bridge_secret IS NULL OR bridge_secret = '');
```

If either returns rows, opt the stragglers in via the admin UI's n8n
Bridge card (set Integration + Generate a signing secret) before
deploying. Do **not** silently archive production rows to pass the
check.

### Deploy order on the VPS

Step 3 exposed a deploy-order race the step-2 "migrations before
rebuild" fix didn't anticipate: migration 020 is **destructive** (DROP
COLUMN), and dropping the column while the old container still served
traffic caused every /render call to 500 for the duration of the
`docker compose build --no-cache` window (~60–120s). The fix is a
two-stage migration convention, introduced in step 3 alongside the
drop:

- **`migrations/*.sql` — pre-rebuild (additive only).** `ADD COLUMN`,
  new tables, triggers on new columns. Runs BEFORE the container
  rebuild so the new code boots into a schema that already has the
  columns it SELECTs.
- **`migrations/post-rebuild/*.sql` — post-rebuild (destructive).**
  `DROP COLUMN`, `DROP TABLE`, anything that breaks the old image's
  SELECTs. Runs AFTER the container is rebuilt and swapped, so the
  old code has stopped serving traffic before the columns it depends
  on disappear.
- **`migrations/down/*.sql` — never auto-run.** Rollback scripts only.
  Non-recursive `migrations/*.sql` glob already skipped this
  directory; `post-rebuild/` is skipped the same way.

`install.sh`, `update.sh`, and `deploy.sh` all implement this:

- `install.sh` step 9 runs both stages in order within one step (on
  a fresh install the container is already up, so both stages are
  safe to run back-to-back).
- `update.sh` step 4 runs the pre-rebuild stage; step 5 rebuilds;
  new step 5c runs the post-rebuild stage; step 6 runs the
  credentials backfill.
- `deploy.sh` mirrors the `update.sh` split.

Manual equivalent for step 3 (no scripts):

1. Apply additive migrations from `migrations/*.sql` (no-ops on
   step 3 since 018/019 are already applied on the VPS).
2. Rebuild and swap the server container (`docker compose build
   --no-cache && docker compose up -d`). New code boots; old code
   stops serving traffic.
3. Apply `migrations/post-rebuild/020_drop_dashboards_fetch_headers.sql`.
   Trigger + function + column drop in one transaction. Idempotent:
   `DROP ... IF EXISTS` / `DROP COLUMN IF EXISTS`.

Future destructive migrations (step 6's RLS rework is a candidate)
belong in `migrations/post-rebuild/`. Future additive migrations
(step 4's RS256 keypair surfaces, step 4's OAuth-token cache if it
lands as a table) stay in `migrations/*.sql`.

### Env changes

None. No new env vars, no new npm deps, no docker-compose changes.

### Schema changes

- One column dropped: `platform.dashboards.fetch_headers`.
- One trigger dropped: `enforce_enc_dashboards_fetch_headers`.
- One function dropped: `platform.require_enc_dashboards_fetch_headers`.
- `platform.connection_templates.fetch_headers` retained on purpose —
  templates are authoring prototypes, not a live render write surface.
  `init.sql` is NOT updated (migrations are source of truth post-init;
  same convention as steps 1 and 2).

### What was explicitly left in place

- **`encrypted-column.ts` plaintext-read fallback.** Still emitting per-row
  WARNs on plaintext-detected decrypts for `webhooks.secret` +
  `connections.connection_details`. Independent cleanup once VPS logs
  show zero WARNs across a few days.
- **`connection_templates.fetch_headers` column.** Builder no longer
  populates it (new templates get empty `'{}'`), but the column +
  validation entry + portability column list all stay. If template
  authoring ever wants a headers field again, add it to the builder
  rather than resurrecting the legacy dashboards path.
- **`dashboards.fetch_body`.** JWT-path dashboards still POST bodies
  for templated workflows — column stays.
- **RLS is still decorative** (documented under step 1, unchanged).
- **`withClient` → `withTenantContext` migration.** Still step 6.
- **Global `dashboard_templates` table.** `template_id` stays opaque
  TEXT — post-step-5 concern.
- **`bridge_secret` redaction in `decryptDashboardRow`.** Preserved
  on both admin and tenant code paths.

### Known follow-ups not done this session

- **`access_token` claim** still always absent. Step 4 (OAuth lookup)
  populates it from `platform.connections.connection_details`.
- **RS256 data-access token** for the pipeline DB is step 4's
  piggyback per `.claude/pipeline-hardening-notes.md` (Model J).
- **Plaintext-read fallback retirement** still pending.
- **Embed endpoint projection** (pre-existing, flagged under step 1):
  `GET /api/embed/:token` still returns the whole dashboard row
  including `fetch_url`. Tighter projection — `view_html` / `view_css`
  / `view_js` / `name` only — is still out of scope for the bridge
  arc; fix before embed tokens land in the wild.

### Verify on VPS after deploy

```sql
-- Column gone
\d platform.dashboards
-- Should NOT list fetch_headers.

-- Trigger gone (plus its two siblings that STAY)
SELECT trigger_name FROM information_schema.triggers
 WHERE trigger_name LIKE 'enforce_enc_%'
 ORDER BY trigger_name;
-- Expect exactly: enforce_enc_connections_details, enforce_enc_webhooks_secret

-- Function gone
SELECT proname FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'platform' AND p.proname = 'require_enc_dashboards_fetch_headers';
-- Should return zero rows.

-- Bridge mint audit rows — via should only ever be one of the four
-- values now. Post-cutover there is no "undocumented" via.
SELECT metadata->>'via' AS via, count(*)
  FROM platform.audit_log
 WHERE action = 'dashboard.bridge_mint'
   AND created_at > now() - interval '1 day'
 GROUP BY 1 ORDER BY 2 DESC;
```

Then render a JWT-path dashboard end-to-end in the UI to confirm the
Authorization header reaches n8n and the response comes back rendered.

---

## Step 4 — OAuth groundwork + Integrations admin + RS256 pipeline JWT (shipped)

Everything the step-4 kickoff promised plus the in-session extensions
from the planning conversation (per-integration API-key-vs-OAuth toggle,
platform-admin Integrations tab, tenant-facing pill + Connect modal,
"My Integrations" strip, scheduled per-tenant token refresh). The
Global-vs-Tenant Dashboard redesign got spun out to step 4b —
documented under `.claude/step-4b-kickoff.md`.

### What changed

**Schema (additive, pre-rebuild stage)**

- `migrations/021_integrations.sql` — new `platform.integrations`
  catalog. One row per external system XRay can OAuth into or connect
  via API key (HouseCall Pro, QuickBooks, etc.). Columns: `slug`,
  `display_name`, `icon_url`, `status` (`pending|active|disabled`),
  `supports_oauth`, `supports_api_key` (CHECK `(supports_oauth OR
  supports_api_key)`), OAuth fields (`auth_url`, `token_url`,
  `client_id`, `client_secret`, `scopes`, `extra_authorize_params`
  JSONB for provider quirks like Google's `access_type=offline`),
  API-key fields (`api_key_header_name`, `api_key_instructions`).
  Trigger `enforce_enc_integrations_client_secret` guards the
  `client_secret` column under the same `enc:v1:` envelope as 017/019.
- `migrations/022_connections_oauth_state.sql` — extends
  `platform.connections` with per-tenant OAuth/API-key state:
  `integration_id` (FK `ON DELETE RESTRICT`), `auth_method`
  (`oauth|api_key`), `oauth_refresh_token`, `oauth_access_token`,
  `oauth_access_token_expires_at`, `oauth_last_refreshed_at`,
  `oauth_refresh_failed_count`, `oauth_last_error`, `api_key`. Partial
  unique index on `(tenant_id, integration_id) WHERE integration_id IS
  NOT NULL` enforces one connection-row-per-(tenant, integration);
  legacy non-OAuth rows with `integration_id=NULL` stay free to
  duplicate. Three `enc:v1:` triggers consolidate into one function
  guarding `oauth_refresh_token`, `oauth_access_token`, `api_key`.
  Partial index on `oauth_access_token_expires_at` (where
  `auth_method='oauth' AND integration_id IS NOT NULL`) for scheduler
  efficiency. Down scripts preserved in `migrations/down/`.

**Server libs + services**

- `server/src/lib/pipeline-jwt.ts` — RS256 mint for `aud='xray-pipeline'`.
  Claim shape locked: `iss='xray'`, `sub=tenant_id`, `jti`, `iat`,
  `exp` (60s), `tenant_id`, `via`, plus `user_id` + `is_platform_admin`
  (both absent on `public_share` per pipeline-hardening commit of
  nullable `acting_user_id`). `isPipelineJwtConfigured()` +
  `warnIfUnconfigured()` give the graceful-absent path — fresh installs
  that boot before the keypair is provisioned don't 500.
- `server/src/lib/oauth-tokens.ts` — RFC 6749 refresh-token exchange.
  Retry policy `[0s, 30s, 60s, 120s, 240s]` (5 attempts, ~450s worst
  case) for scheduler refreshes; `exchangeAuthorizationCode` is a
  single attempt for the interactive callback path. RFC 6749 defaults
  baked in (POST form-urlencoded, client_id/secret in body, expires_in
  default 3600, preserve stored refresh_token when provider omits it).
  Test seams `__setFetcherForTest` + `__setSleeperForTest`. Provider
  extras (QBO's `realmId`, etc.) kept in a bag so per-provider code
  can pull from them without this lib knowing their shape.
- `server/src/lib/oauth-scheduler.ts` — 5-min setInterval tick. Picks
  up any connection whose access token expires within 30 min AND
  auth_method='oauth' AND integration.status='active'. Per-connection
  `pg_try_advisory_xact_lock(hashtext(id::text)::bigint)` serializes
  refreshes for future multi-instance deploys. Failure accounting:
  `oauth_refresh_failed_count >= 5` flips connection `status='error'`
  with `oauth_last_error` populated. First tick runs via setImmediate
  at startScheduler() so post-outage recovery doesn't wait 5 min.
  Boots from `index.ts` after HTTP listener is up.
- `server/src/lib/oauth-state.ts` — signed state JWT for the
  authorize/callback flow. HS256 against `JWT_SECRET`, 10-min exp,
  claims `{t, i, u, n}` (tenant_id, integration_id, user_id, nonce).
  `buildAuthorizeUrl` merges standard OAuth 2.0 params with
  `integration.extra_authorize_params`.
- `server/src/services/integration.service.ts` — CRUD for
  `platform.integrations` + `resolveAccessTokenForRender` (single JOIN,
  4-state result: ready / not_connected / needs_reconnect /
  unknown_integration). Secret handling follows the step-2 contract —
  API responses redact `client_secret` and surface `client_secret_set:
  boolean`. Two internal helpers (`getIntegrationWithSecret`,
  `decryptIntegrationClientSecret`) encapsulate the single "need
  plaintext" code path so reviewers can grep for it. Cross-field
  `validateIntegrationConfig` enforces auth-method-specific required
  fields (auth_url/token_url/client_id for OAuth; api_key_header_name
  for API key).

**Routes**

- `GET /api/connections/oauth/:slug/authorize` — returns the provider's
  authorize URL with a signed state JWT. Frontend does a full-page
  redirect (popup/iframe defeated by provider X-Frame-Options).
- `GET /api/oauth/callback` — no auth (state JWT is the trust anchor).
  Verifies state, exchanges code at provider, encrypts + stores tokens,
  UPSERTs the tenant's `platform.connections` row (prefers updating
  existing `source_type=slug` rows to cover the hardcoded-pre-step-4-
  client migration story), redirects to `/app?connected=<slug>` or
  `/app?oauth_error=<code>`. App boot's `checkOauthReturnParams()`
  reads those params and toasts the outcome.
- `POST /api/connections/api-key/:slug` — tenant pastes API key;
  encrypt + store on the connection with `auth_method='api_key'`.
- `POST /api/connections/disconnect/:slug` — clears tokens + sets
  connection `status='pending'`. Row kept so dashboards still reference
  the integration_id.
- `GET /api/connections/my-integrations` — owner/platform-admin-only.
  Lists active integrations + per-tenant connection state.
- `GET/POST/PATCH/DELETE /api/admin/integrations` — platform-admin
  CRUD. List + get responses include `meta.oauth_redirect_uri` so the
  admin UI can copy-paste the URL into each provider's dev console.

**Render-path wiring**

Three call sites read pre-refreshed credentials via
`integration.service.resolveAccessTokenForRender`, mint pipeline JWT
in parallel, add `X-XRay-Pipeline-Token` header:

- `dashboard.routes.ts` authed render → `/render` returns 409
  `OAUTH_NOT_CONNECTED` on needs_reconnect (frontend catches and
  opens the Connect modal).
- `dashboard.service.ts` `renderPublicDashboard` → no OAuth lookup
  (public_share works DB-only per your direction); pipeline JWT still
  minted with user_id absent.
- `admin.service.ts` `fetchDashboardContent` (admin preview) → OAuth
  resolved under target tenant's credentials; 409 surfaces as
  `AppError(409, 'OAUTH_NOT_CONNECTED')` so impersonating admins see
  "tenant must reconnect" rather than 500.

All three emit `auth_method` on the bridge JWT so n8n workflows can
branch between OAuth Bearer and static API-key header schemes. Audit
metadata on `dashboard.bridge_mint` gains `pipeline_jti`, `auth_method`,
`access_token_present` (value-less boolean, for SOC-2 triage).

**Frontend**

- `views.admin_integrations` (Platform > Integrations nav). CRUD for
  `platform.integrations` with auth-method toggles, conditional OAuth
  /API-key sections, masked client_secret + green "Secured" pill per
  the step-2 contract, copy-paste OAuth callback URL banner, status
  selector including `pending` for pre-created-but-awaiting-approval
  rows.
- Dashboard builder: free-text Integration field replaced with a
  `<select>` populated from `/api/connections/my-integrations` + a
  "Custom (no auth)" default. Inline Connect button + status pill
  next to the dropdown. Free-text slug preservation: dashboards
  referencing a slug no longer in the catalog keep the slug with a
  "(not in catalog)" suffix so saves don't wipe it (render-path
  degrades gracefully per the lib).
- `window.__xrayOpenConnectModal(slug, onConnected)` — global Connect
  modal with OAuth + API Key cards. Dimmed for unsupported methods
  rather than hidden so tenants can see what's available in principle.
- Dashboard list pill on every card with an integration (green/amber/
  gray; Custom and unknown-slug cards get no pill). Click-intercept in
  the capture phase: broken pill opens the Connect modal instead of
  navigating.
- "My Integrations" strip at the top of the dashboard list — owner +
  platform admin only — with Connect/Reconnect/Disconnect actions per
  integration.
- Tenant-facing Connections view (`views.connections`) removed.
- Bundle version → `2026-04-22-024`.

**Deploy plumbing**

- `config.ts` — `pipelineJwt` block (issuer/audience/expiry + private
  and public keys with `normalizePem` accepting raw or base64 PEM) +
  `oauth.redirectUri` derived from env (`XRAY_OAUTH_REDIRECT_URI` ||
  `ORIGIN` || `APP_URL` + `/api/oauth/callback`) + `stateExpirySeconds`.
- `install.sh` — generates an RSA 2048 keypair during the secrets
  step, base64-encodes both PEMs, writes to `.env` alongside JWT_SECRET
  and ENCRYPTION_KEY. Also seeds `XRAY_OAUTH_REDIRECT_URI`.
- `update.sh` — idempotent check for `XRAY_PIPELINE_JWT_PRIVATE_KEY`
  and `XRAY_OAUTH_REDIRECT_URI` matching the VAPID block's pattern.
  Missing → generate, append, restart server.

**Portability**

`platform.connections.{oauth_refresh_token, oauth_access_token,
expires_at, last_refreshed_at, refresh_failed_count, last_error,
api_key}` are **excluded** from export. Live credentials specific to
the platform's ENCRYPTION_KEY + provider app registration; they don't
round-trip. `integration_id` + `auth_method` DO round-trip so imported
rows are recognizable. Tenants re-run the Connect flow after import.

### Env changes

- `XRAY_PIPELINE_JWT_PRIVATE_KEY` — platform-wide RS256 signing key
  for the pipeline data-access JWT. Base64-encoded PEM. Generated by
  install.sh / update.sh. Absent = graceful skip (render doesn't 500,
  pipeline JWT just not emitted).
- `XRAY_PIPELINE_JWT_PUBLIC_KEY` — corresponding public key. Ships to
  pipeline DB later (Model J).
- `XRAY_OAUTH_REDIRECT_URI` — optional override for the OAuth callback
  URL. Default-derives from ORIGIN / APP_URL.

### Verify on VPS after deploy

```sql
-- Migrations 021 + 022 applied
SELECT trigger_name FROM information_schema.triggers
 WHERE trigger_name IN (
   'enforce_enc_integrations_client_secret',
   'enforce_enc_connections_oauth_refresh_token',
   'enforce_enc_connections_oauth_access_token',
   'enforce_enc_connections_api_key'
 ) ORDER BY trigger_name;
-- Expect 4 rows.

-- No stray plaintext on the new encrypted columns
SELECT id FROM platform.connections
 WHERE oauth_refresh_token IS NOT NULL AND oauth_refresh_token <> ''
   AND oauth_refresh_token NOT LIKE 'enc:v1:%';
-- Should return 0 rows (trigger rejects any write that would violate).

-- Scheduler activity (after first tick on a tenant with an OAuth conn):
SELECT id, oauth_access_token_expires_at, oauth_last_refreshed_at,
       oauth_refresh_failed_count, status
  FROM platform.connections
 WHERE auth_method = 'oauth' AND integration_id IS NOT NULL
 ORDER BY oauth_last_refreshed_at DESC NULLS LAST;
```

### Known follow-ups not done this session

- **Global-vs-Tenant Dashboard picker** is step 4b. Full scope +
  open design questions in `.claude/step-4b-kickoff.md`.
- **Valkey-backed shared cache** if XRay ever fans out past one box.
  The current oauth-scheduler uses in-process state + DB writes; no
  cache needed for the single-box model. When that day comes, use
  Valkey (not Redis) per the operator's direction.
- **Provider-specific quirks** the generic OAuth 2.0 path doesn't
  cover: PKCE, Basic-auth-header-only providers, Intuit's realmId
  handling. Each needs a targeted branch in `oauth-tokens.ts` keyed
  on slug. Empty `platform.integrations` at ship means this only
  bites when a specific provider gets added.
- **Pipeline DB consumer** (Model J) — still post-step-6. Step 4 just
  mints the token; nobody verifies it yet.
- **RLS still decorative**, plaintext-read fallback in
  `encrypted-column.ts` still in place, `withClient` →
  `withTenantContext` migration still deferred to step 6.

---

## Step 4b — Global Dashboards + fan-out + dropdown fix (shipped)

Three concerns, one branch, three commits.

### Commit (i) — Builder Integration dropdown: extract helper, fix edit-load

Step-4 loose end per the step-4b kickoff. Step 4 had shipped the
select-populate + Connect-button wiring already, so the kickoff's "the
select is unwired" claim was outdated. Two real gaps remained:

- Populate logic was inlined in the bundle with no test coverage.
  Extracted into `window.__xrayBuildIntegrationOptions` in
  `frontend/app.js` — one tested place that owns "my-integrations
  rows + current value → ordered option list with unknown-slug
  preservation." Bundle now calls it; falls back to a Custom-only
  sentinel if the helper is absent (pre-app.js-load ordering).
- Edit-loader bug: opening an existing dashboard set
  `sel.value = d.integration` programmatically, which doesn't fire
  `onchange`, so the pill + Connect button stayed hidden until the
  admin changed and reverted the dropdown. Fix: explicit
  `updateBuilderIntegrationStatus()` after every programmatic set.
- HTML rendering of option text hardened against `& < > "` in display
  names / slugs (previously concatenated raw).

Spec: `server/src/lib/builder-integrations.test.ts` — 8 behaviors,
mirrored locally; tests run in node without jsdom.

### Commit (ii) — Fan-out endpoint

**Operator statement**: *n8n owns the sync cron; XRay only dispatches
when called.* XRay stays a single-box deploy with a 5-min OAuth-token
refresh scheduler; data-sync scheduling is a separate concern that
n8n handles. `oauth-scheduler.ts` and fan-out coexist.

**Route**: `POST /api/integrations/:slug/fan-out`. Mounted on
`/api/integrations` (separate from tenant JWT routes). Auth is a
per-integration shared secret in `Authorization: Bearer <secret>`,
constant-time compared against `integrations.fan_out_secret`. 401 on
any mismatch — no slug enumeration.

**Behavior**: loads the integration, then every connected tenant,
then per-tenant resolves the live access token via the step-4
resolver, then POSTs once per tenant to the caller-supplied
`target_url` with a signed envelope JWT
(`X-XRay-FanOut-Token`, `aud='n8n-fan-out'`, 60s TTL) and an
`Idempotency-Key: sha256(fan_out_id || tenant_id)` header. Bounded
parallelism from `integrations.fan_out_parallelism` (1–50, default
5). Per-target retry: 3 attempts, backoff `[0s, 2s, 4s]`. Returns a
synchronous summary once the dispatch loop completes:
`{fan_out_id, dispatched, skipped_needs_reconnect, skipped_inactive,
skipped_integration_missing, replay}`.

**Idempotency**: caller-supplied `idempotency_key` on the request
body dedupes at the run level — a matching prior `fan_out_runs` row
returns its summary with `replay: true` instead of dispatching again.

**Schema (additive, pre-rebuild)**:

- `migrations/023_integrations_fan_out_config.sql` — adds
  `platform.integrations.fan_out_secret` (enc:v1: trigger extended
  from migration 021) and `fan_out_parallelism INTEGER DEFAULT 5`.
  One trigger function, two `BEFORE INSERT OR UPDATE OF` triggers
  scoped per column (so writes to one column don't re-validate the
  other).
- `migrations/024_fan_out_runs.sql` — `platform.fan_out_runs` (one
  row per dispatch) and `platform.fan_out_deliveries` (one row per
  tenant per run, status ∈ pending/delivered/failed/skipped). Unique
  index on `(integration_id, idempotency_key) WHERE idempotency_key
  IS NOT NULL` for run-level replay. Unique `idempotency_key` on
  deliveries for per-(run, tenant) dedupe. FK with `ON DELETE
  CASCADE` on both.

**Server libs**:

- `server/src/lib/fan-out-jwt.ts` — `mintFanOutJwt()`. Distinct
  audience `n8n-fan-out` from bridge (`n8n`) and pipeline
  (`xray-pipeline`). Same per-integration secret signs the envelope
  AND authenticates the inbound call — one credential per integration
  for n8n to configure (matches step-2's per-credential story).
- `server/src/services/fan-out.service.ts` — `dispatchFanOut`,
  `getFanOutSecret`, `compareSecrets`, `deliverEnvelope`,
  `listLastFanOutByIntegration`. The retry/deliver helper is exported
  + has test seams (`__setFetcherForTest`, `__setSleeperForTest`) so
  specs can assert backoff + headers without network.

**Admin surface**: `GET /api/admin/integrations` now returns
`meta.fan_out_last` keyed by integration id. Admin Integrations modal
gains a Fan-out section — masked secret + Generate (client-side
`crypto.getRandomValues`, 48 bytes base64url, shown once) + Show/Hide
+ Secured pill on edit; parallelism input (1–50); read-only URL
banner showing the endpoint n8n should call. Table gains a "Last
fan-out" column (`N dispatched, M skipped — <timestamp>` or `—`).

Tests: `fan-out-jwt.test.ts` (11) + `fan-out.service.test.ts` (13).
Covers claim shape + audience separation + constant-time compare edge
cases + idempotency-key determinism + retry sequencing + fetcher/
sleeper seam.

### Commit (iii) — Global dashboards

**Operator definition**: *"Global dashboard means it is replicated
for all users but utilizes each individual tenant's oauth/custom
auth."* Practically: one row in `platform.dashboards` renders N times
— once per tenant with an active connection to the dashboard's
integration (or an explicit grant for Custom Globals). Each render
binds the bridge+pipeline JWTs to the **rendering tenant**, not the
author.

**Schema (additive, pre-rebuild)**:

- `migrations/025_dashboards_global_scope.sql`:
  - `scope TEXT NOT NULL DEFAULT 'tenant' CHECK ('tenant'|'global')`.
  - `tenant_id` loses `NOT NULL`.
  - Cross-column CHECK: tenant → `tenant_id NOT NULL`; global →
    `tenant_id NULL`.
  - Belt-and-suspenders CHECK: Globals are never public (no
    `is_public=true`, no `public_token`).
- `migrations/026_dashboard_render_cache.sql` —
  `platform.dashboard_render_cache (dashboard_id, tenant_id,
  view_html, view_css, view_js, rendered_at)` PK `(dashboard_id,
  tenant_id)`. Fixes the racy clobber Globals would cause on the
  legacy `dashboards.view_html` columns.
- `migrations/027_dashboard_tenant_grants.sql` —
  `platform.dashboard_tenant_grants (dashboard_id, tenant_id,
  granted_by, created_at)`. Opt-in access for Custom Globals only;
  integration-connected Globals use the active connection as the
  gate.

**Render path (dashboard.routes.ts)**:

- SELECT accepts both scopes. Non-admin users see
  `scope='tenant' AND tenant_id = $user_tid` OR any
  `scope='global'` row. Permission gate runs post-SELECT:
  - integration-set Globals: `resolveAccessTokenForRender` returns
    `ready` OR the route returns 409 `OAUTH_NOT_CONNECTED` (same
    flow as step 4).
  - Custom Globals: require a grant row or 403 `GLOBAL_NOT_GRANTED`.
- `renderingTenantId = COALESCE(d.tenant_id, req.user.tid)` — Tenant
  rows render under the dashboard-owning tenant; Globals render
  under the requester's tenant. Bridge JWT `sub`/`tenant_id` +
  pipeline JWT `sub`/`tenant_id` + audit `tenant_id` all bind to
  `renderingTenantId`. Audit `metadata.scope` and
  `metadata.dashboard_tenant_id` preserve the row's authored tenant
  for forensic triangulation.
- `actingVia`: Globals always `authed_render` (nothing is being
  impersonated — a Global isn't owned). `admin_impersonation` still
  fires for Tenant rows viewed by an admin outside the owning tenant.
- Cache writes: `INSERT...ON CONFLICT` into `dashboard_render_cache`
  keyed on `(dashboard.id, renderingTenantId)` for both scopes.
  Tenant-scoped rows additionally dual-write the legacy
  `view_html/css/js` columns for non-render readers (embed,
  portability, preview fallback). Globals don't dual-write — no
  single-tenant context for those columns.
- Fallback read: prefer cache table by `(dashboard, rendering
  tenant)`; for Tenant rows fall back to legacy columns when the
  cache row is empty.

**Public share path**: `getPublicDashboard` SELECT adds
`AND scope='tenant'` (belt-and-suspenders — Globals can't have a
public_token per the CHECK).

**Admin preview (admin.service.fetchDashboardContent)**: new
`options.targetTenantId`. Required when previewing a Global; ignored
for Tenant rows. 400 `RENDERING_TENANT_REQUIRED` when absent on a
Global. Route reads from `req.body.target_tenant_id` or the query
param.

**Admin create (admin.service.createDashboard)**: accepts `scope` +
`ctx.isPlatformAdmin`. Admin-only for `scope='global'`. Tenant rows
without `tenantId` error 400 `TENANT_REQUIRED`. Global rows insert
with `tenant_id=NULL` (the CHECK backs it). `updateDashboard`
intentionally does NOT expose scope mutation — post-create scope
changes would need cache + grant + connection reconciliation (out of
scope for 4b).

**Validation**: `dashboardCreateSchema.tenantId` is now
nullable+optional; `scope` enum added. `dashboardUpdateSchema` has
no `scope` field.

**Listing**: `listDashboards` extended. Non-admin tenant users see
their Tenant rows + eligible Globals. "Eligible Global":

```sql
d.scope = 'global' AND d.status = 'active' AND (
  -- Integration-connected: tenant has an active connection
  EXISTS (
    SELECT 1 FROM platform.integrations i
     JOIN platform.connections c
       ON c.integration_id = i.id
      AND c.tenant_id = $tenant
      AND c.status = 'active'
     WHERE i.slug = d.integration
  )
  OR
  -- Custom: opt-in via grant row
  ((d.integration IS NULL OR d.integration = '')
   AND EXISTS (
     SELECT 1 FROM platform.dashboard_tenant_grants g
      WHERE g.dashboard_id = d.id AND g.tenant_id = $tenant
   ))
)
```

Platform admins see every row (LEFT JOIN `tenants` now so Globals
with `tenant_id=NULL` don't drop).

**Frontend builder**: new Scope card at the top (Tenant / Global
radio). `applyScopeVisibility` hides the tenant picker + the
integration status pill when Global is selected (admin authoring;
per-tenant status is irrelevant). Save payload includes `scope`;
`tenantId` only sent when Scope=Tenant. Integration required on
Scope=Global. Edit loader restores `scope` from `d.scope` (default
`'tenant'`).

**Portability**: import whitelist adds `'scope'`. Older pre-4b
exports without `scope` get the column default (`'tenant'`) on
import. Platform-wide export (the only tenant-export path the repo
has) naturally round-trips Globals.

### Tests

- 68 (pre-4b) → 113 (post-4b). +45 specs across three commits:
  - Commit (i): `builder-integrations.test.ts` (8)
  - Commit (ii): `fan-out-jwt.test.ts` (11) + `fan-out.service.test.ts` (13)
  - Commit (iii): `global-dashboards.test.ts` (13)
- DB-backed render-path behavior (cache rows, bridge+pipeline JWT
  tenant binding, 409 routing) still waits for an integration-test
  harness. Specs mirror the pattern in
  `integration.service.test.ts` / `oauth-scheduler.test.ts` — pure
  logic, no Postgres.

### Env changes

None. `oauth-scheduler.ts` untouched. `XRAY_PIPELINE_JWT_*` and
`XRAY_OAUTH_REDIRECT_URI` from step 4 unchanged. Per-integration
`fan_out_secret` is per-row on `platform.integrations`, not an env
var.

### Deploy order on the VPS

- Migrations 023–027 are additive → `migrations/*.sql` (pre-rebuild).
  Fresh code boots into a schema that already has the new columns
  and tables.
- Before populating any row with `scope='global'`, the operator
  should verify migration 025's CHECKs are installed (see the
  on-VPS sanity queries below).

### Verify on VPS after deploy

```sql
-- Fan-out secret trigger covers both client_secret + fan_out_secret.
SELECT trigger_name FROM information_schema.triggers
 WHERE trigger_name LIKE 'enforce_enc_integrations_%' ORDER BY trigger_name;
-- Expect: enforce_enc_integrations_client_secret,
--         enforce_enc_integrations_fan_out_secret.

-- Fan-out tables present.
\dt platform.fan_out_runs
\dt platform.fan_out_deliveries

-- Global scope CHECKs present.
SELECT conname FROM pg_constraint WHERE conrelid = 'platform.dashboards'::regclass
 AND conname IN ('dashboards_scope_tenant_id', 'dashboards_global_not_public')
 ORDER BY conname;
-- Expect both rows.

-- Render cache + grants tables present.
\dt platform.dashboard_render_cache
\dt platform.dashboard_tenant_grants

-- After a Global has been rendered by two tenants, each should have
-- its own cache row.
SELECT dashboard_id, tenant_id, rendered_at
  FROM platform.dashboard_render_cache
 ORDER BY rendered_at DESC LIMIT 10;

-- Bridge mint audit rows on a Global render should carry the
-- rendering tenant's id in tenant_id and the dashboard's authored
-- tenant (NULL for Globals) in metadata.
SELECT tenant_id, metadata->>'scope' AS scope,
       metadata->>'dashboard_tenant_id' AS dashboard_tenant_id,
       metadata->>'jti' AS jti
  FROM platform.audit_log
 WHERE action = 'dashboard.bridge_mint'
   AND metadata->>'scope' = 'global'
 ORDER BY created_at DESC LIMIT 10;
```

### Known follow-ups not done this session

- **Grant-management admin UI** for Custom Globals. The grants table
  exists, the render-path gate honors it, but no UI yet to add/remove
  grants. Out of scope for 4b; UI ships alongside whatever step lands
  Custom Globals in practice.
- **Retire legacy `dashboards.view_html/view_css/view_js` columns.**
  Tenant rows still dual-write them for non-render readers. Dropping
  requires auditing embed, portability, and preview-fallback readers.
  Post-step cleanup, not a 4b concern.
- **Platform-wide portability export endpoint** for Globals only.
  The existing `exportPlatform` covers them as part of a full
  export; a Globals-only export is a later convenience.
- **Per-tenant portability of Globals** (tenant moving to on-prem
  taking their connection state + the global dashboards they see):
  Globals carry `tenant_id=NULL` and aren't exportable per-tenant.
  Pragmatic answer is "re-author on the target platform" — same
  model the kickoff anticipated.
- **Stripe/onboarding polish** — step 5. See
  `.claude/step-5-kickoff.md`.
- **RLS decorative, plaintext-read fallback, `withClient` →
  `withTenantContext` migration** — all still step 6. Unchanged by
  4b.
- **Pipeline DB consumer (Model J)** — still post-step-6. 4b changed
  what the pipeline JWT carries for Global renders (rendering tenant,
  not author) but nobody verifies it yet.

---

## Step 4c — Post-step-4b cleanup (shipped)

Four bugs that user testing on the VPS surfaced after step 4b landed.
None schema-blocking; loose ends in UI wiring + one missing real-time
path. Four concerns, four small commits, zero new migrations.

### Commit (i) — Edit loader restores Integration selection

Editing a dashboard whose `integration` was populated (e.g.
`housecall_pro`) left the builder's Integration dropdown on "Custom
(no auth)". Root cause: race between the edit loader's synchronous
`intEl.value = d.integration` and the async
`loadBuilderIntegrations()` that populates the `<option>`s from
`/api/connections/my-integrations`. Setting `sel.value` to a slug
whose `<option>` hasn't been appended yet is a silent no-op; the
populate then reads `current = sel.value` (empty) and doesn't
restore.

Fix: `loadBuilderIntegrations(preferredValue)` now accepts an
optional slug and prefers it over `sel.value` when deciding what to
restore after the rebuild. Edit loader calls
`loadBuilderIntegrations(d.integration || '')` instead of the direct
assignment — ordering no longer matters.

File: `frontend/bundles/general.json`. Version 4b-002 -> 4c-003.

### Commit (ii) — Global share: GET /:id/share now handles Globals

Sharing a Global still threw "Dashboard not found" even after
migration 028. Diagnosis (server logs + route walk): the share modal
opens with `GET /api/dashboards/:id/share`, which called
`dashboardService.getDashboard(id, tenantId)` whose SELECT is `WHERE
id=$1 AND tenant_id=$2`. Globals carry `tenant_id=NULL`, so that
SELECT returned zero rows and threw
`AppError(404, 'DASHBOARD_NOT_FOUND', 'Dashboard not found')` before
any share-table lookup. POST / PATCH / DELETE were already
scope-aware from step-4b's commit `efa639e`; only GET wasn't.

Fix (single route change, no service touch):

- `GET /:id/share` branches on `dashboards.scope` inline:
  - `scope='global'` -> read `(public_token, is_public)` from
    `platform.dashboard_shares WHERE dashboard_id=$1 AND tenant_id=$2`;
    missing row returns the same "no link yet" shape the UI already
    handles (`{ is_public:false, share_url:null, public_token:null }`).
  - `scope='tenant'` -> unchanged, reads `platform.dashboards` by
    `(id, tenant_id)`.

Secondary fix in the same commit: `PATCH /:id/share` on a Global
used to UPDATE-only; zero-rows on a non-existent share row was a
silent no-op. Added `RETURNING dashboard_id` + a 404
`SHARE_LINK_MISSING` ("Create the share link before toggling
visibility.") so any future UI regression that reorders PATCH before
POST surfaces instead of silent no-op.

File: `server/src/routes/dashboard.routes.ts`.

### Commit (iii) — Real-time integration connect/disconnect via WS

The step-4b fix landed the connection-gated Global visibility in
`listDashboards`, but open tabs on other users of the same tenant
didn't see new Globals appear (or disappear) until a manual reload.
Fix reuses the `broadcastToTenant` pattern that already powers
`dashboard:share-changed`:

- Server: `GET /api/oauth/callback` (OAuth connect) +
  `POST /api/connections/api-key/:slug` fire
  `integration:connected { slug }`; `POST /api/connections/disconnect/:slug`
  fires `integration:disconnected { slug }`. All three wrapped in
  try/catch so a WS hiccup never poisons the connect/disconnect path
  itself.
- Frontend: the existing `dashboard_list` onWsMessage that listens
  for `dashboard:share-changed` gains a parallel branch for
  `integration:connected` / `integration:disconnected`. Calls
  `loadDashboards()` + `loadMyIntegrations()` so the dashboard grid,
  the My-Integrations strip, and the per-card connection pills all
  refresh live.

Files: `server/src/routes/oauth.routes.ts`,
`server/src/routes/connection.routes.ts`, `frontend/bundles/general.json`.
Version 4c-003 -> 4c-004.

Acceptance (manual on the VPS): two browser windows on the same
tenant — window A clicks Connect on HCP, window B live-flips the
strip to "Connected" and HCP Globals appear in the grid. Window A
clicks Disconnect, window B live-removes them.

### Commit (iv) — In-app alert / confirm modals

Every browser `alert()` / `confirm()` across the app replaced with an
in-app modal matching the existing `.modal-overlay`/`.modal` styles
(app.css:65+). Two new globals in `frontend/app.js`, next to the
`toast()` helper:

- `window.__xrayAlert(message, { title?, okLabel? })` -> `Promise<void>`
- `window.__xrayConfirm(message, { title?, okLabel?, cancelLabel?,
    danger? })` -> `Promise<boolean>`

Keyboard: Enter = OK, Escape = Cancel (dismiss on alert). Overlay
click = Cancel. OK button autofocuses on open. `opts.danger = true`
paints the OK button in `.btn.danger` red for destructive confirms
(Revoke/Delete/Disconnect/Clear).

Mechanical swap across `frontend/bundles/general.json`:
- 64 `alert(...)` call sites -> `window.__xrayAlert(...)`.
- 16 `confirm(...)` sites -> `(await window.__xrayConfirm(...))`.
- 16 enclosing handlers (`btn.onclick = function()` / `window.X =
  function()`) gained `async` so the `await` is legal. `node --check`
  on every view JS string is green.

Plus the one `confirm()` in `frontend/app.js` itself (the AI
Clear-API-key handler snippet) got the same swap with
`danger: true`.

`app.js?v=30` -> `?v=31` in `index.html` so browsers fetch the new
helpers. Bundle version 4c-004 -> 4c-005.

Scope bound: only `alert()` / `confirm()` swapped. `toast()` already
matches the in-app surface; untouched. No general-purpose toast-
replacement abstraction per the kickoff's scope fence.

### Env changes

None. No new env vars, no migrations, no docker-compose changes, no
Dockerfile changes. Step 4c is a pure code-only update.

### Deploy order on the VPS

Standard `update.sh`:
- Step 2 copies the new `app.js`, `index.html`, and `bundles/general.json`.
- Step 4 re-runs `migrations/*.sql` (all idempotent; no new migrations
  in 4c).
- Step 5 rebuilds the server container picking up
  `oauth.routes.ts` / `connection.routes.ts` / `dashboard.routes.ts`
  changes.

No post-rebuild migrations to run. No backfill to re-run. No nginx
config changes.

### Verify on VPS after deploy

```sql
-- 4c didn't touch schema, so 4b's verify queries are still the set
-- an operator runs. Two 4c-specific traces:

-- Integration connect/disconnect audit rows (surface that the broadcast
-- code path fired):
SELECT created_at, action, metadata->>'integration_slug' AS slug, tenant_id
  FROM platform.audit_log
 WHERE action IN ('connection.oauth_connected',
                  'connection.api_key_connected',
                  'connection.disconnected')
 ORDER BY created_at DESC LIMIT 10;

-- Per-tenant share rows (4b's dashboard_shares, exercised by 4c's
-- GET/PATCH fixes):
SELECT dashboard_id, tenant_id, is_public, created_at
  FROM platform.dashboard_shares
 ORDER BY created_at DESC LIMIT 10;
```

Browser-side smoke test after deploy (incognito window recommended so
the new `app.js?v=31` downloads cleanly):

1. Edit an existing HCP dashboard -> dropdown shows "HouseCall Pro"
   selected, not "Custom".
2. Two tabs on same tenant: Connect HCP in tab A -> tab B's My-
   Integrations strip + Global dashboards flip to live WITHOUT
   reload. Disconnect in either -> both tabs lose HCP Globals live.
3. Share a Global -> modal opens with "Create share link" (not
   "Dashboard not found") -> create + copy URL -> incognito visit
   renders the dashboard.
4. Any Revoke / Delete / Disconnect action -> in-app modal with a
   red confirm button. Zero browser-native `alert()` / `confirm()`
   dialogs anywhere.

### Known follow-ups not done this session

- **Integration `needs_reconnect` WS broadcast.** When the 5-min
  OAuth scheduler flips a connection to `status='error'` /
  `needs_reconnect`, there's no broadcast. The render-path 409 still
  works when the tenant clicks in, but live strip/pill refresh is
  missing. The kickoff called this out as optional for 4c;
  intentionally deferred.
- **Modal focus trap.** Current `__xrayConfirm` gives the OK button
  focus but doesn't trap Tab inside the modal. Low-priority given
  most modals are two-button; revisit if/when a confirm grows a form.
- **113 tests still green.** The kickoff flagged a possible stub-ws
  broadcast spec as optional for commit (iii); skipped. The existing
  `broadcastToTenant` implementation is already exercised indirectly
  via the share-changed routes from 4b. A direct spec would add
  coverage but not surface behavior the route handlers don't already
  guarantee.
- **RLS decorative, plaintext-read fallback, `withClient` ->
  `withTenantContext` migration** — all still step 6. Unchanged by
  4c.

### Step-4c follow-ups shipped in the same branch (post-deploy UX round)

Four extra UX reports came in after the original 4c commits landed on
the VPS. They all fit inside 4c's "post-4b cleanup" scope rather than
deserving their own step, so they shipped on the same branch:

- **Global-share "skeleton page".** `resolveAccessTokenForRender`
  was silently degrading for `not_connected` / `unknown_integration`
  in the public-share path, producing a zero-access-token bridge
  call whose n8n response came back empty. For the Global branch
  (where `sharing_tenant_id` is definite), this now throws 409
  `OAUTH_NOT_CONNECTED` with a legible reason so the share page
  shows the message instead of a blank iframe. Plus `POST
  /:id/share` clears the share cache for the token it returns, for
  symmetry with PATCH/DELETE.

- **Disconnect confirm + toast use `display_name`.** "Disconnect
  housecall_pro?" -> "Disconnect HouseCall Pro?" by looking up
  `display_name` from the local My-Integrations array by slug. The
  disconnecting tab also now calls `loadDashboards()` locally so
  its own UI updates deterministically without waiting on the WS
  round-trip (the WS broadcast still fires for every other tab).

- **Paste-key autofocus.** Clicking "Paste key" in the Connect
  modal now focuses `#connect-api-key-input` on the next tick so
  the user can paste immediately.

- **Three-state share button + non-admin can copy Globals.** The
  card share button now has three states: red (no share link,
  admin-only — click creates), amber (internal link, admin-only —
  click manages), green (publicly shared — any tenant user can see
  and copy). Background is solid grey (`#1a1c26`) so it stays
  legible over tile images; state shows via border + icon color
  only. Root cause of non-admins being unable to copy: each
  listDashboards variant returned `d.public_token = NULL` for
  Globals because the per-tenant share token lives in
  `platform.dashboard_shares`. Fixed by LEFT JOIN on
  `dashboard_shares` keyed on `(dashboard_id, tenant_id = $1)` plus
  a small post-processor that surfaces the tenant-effective
  `public_token` / `is_public` on the canonical fields. Tenant-
  scoped rows fall through unchanged. WS propagation works for
  non-admins too — the `dashboard:share-changed` forwarder routes
  to every dashboard_list handler regardless of role. Also fixed
  the click-handler selector (`.dash-share-btn[data-share-idx]`
  -> `.dash-share-btn`) so the non-admin copy button's click
  actually fires.

- **Rotate Link (new admin action).** Share modal gains a "Rotate
  Link" button (amber styling) next to Revoke. `POST /:id/share/rotate`
  issues a fresh token while keeping `is_public` untouched — single-
  click security response to a leaked URL. Branches on scope:
  Globals update `dashboard_shares.public_token`; Tenant rows
  update `dashboards.public_token`. Both paths return the
  previous token so the caller can clear the share cache for
  both tokens.

- **Rotate/Revoke kick live viewers.** On rotate or revoke, any
  browser tab currently on the old `/share/<token>` URL gets
  kicked to the standard "Dashboard not found or share link has
  been revoked" screen in real time. Mechanism: a new
  unauthenticated WS connection mode — `/ws?share_token=<token>`
  — registers public share viewers in a token-keyed
  `shareSubscribers` map on the server. `notifyShareRevoked(token,
  reason)` sends `{type:'share:revoked', data:{reason}}` to every
  subscriber and closes the socket. Wired into the rotate route
  (with `previous_token`) and the revoke route (with
  `revoked_token` captured via a pre-UPDATE SELECT so the
  public-share path can be notified). Also removed the
  sessionStorage cache in `share.html` that was making
  hard-refresh render the old dashboard from the tab's local
  store even after the server-side token was gone — the client
  always re-fetches now; server-side `shareCache` remains the
  performance layer.

### Env changes (post-deploy round)

Still none. The WS `share_token` mode piggybacks on the existing
`/ws` endpoint. No new env vars, no new migrations, no docker-
compose changes, no Dockerfile changes.

### Verify on VPS after the follow-up deploy

Browser-side smoke test (needs two tabs on two different accounts
for some steps):

1. As any tenant user (owner or member), view a Global whose tenant
   has an active connection. Card shows the green share icon when
   publicly shared, nothing when internal, nothing when not shared.
2. As a non-admin tenant user, click the green share icon — URL
   copies to clipboard.
3. As admin, open the share modal on a shared dashboard. Click
   "Rotate Link" -> confirm. The modal re-renders with the new URL.
   In a separate incognito tab already on the old URL, the page
   instantly flips to "Dashboard not found or share link has been
   revoked" without any interaction. Hard-refresh that tab -> still
   the revoked screen (no client cache, server 404s the old token).
4. Click "Revoke Link" on a shared dashboard -> same kick behavior
   on any live viewer.

## Step 5 — Tenant onboarding + Stripe polish (shipped)

The "stranger with a credit card" milestone. Step 5 closes the rough
edges on the paid-tenant capture path so self-serve signup →
payment → rendered dashboard works end-to-end without operator
hand-holding. Six commits; zero SQL migrations; no JWT shape
changes; no touch to oauth-scheduler or the bridge/pipeline/fan-out
audience set.

### Commit (i) — Signup + setup error states + onboarding checklist

Three concerns on the first-login path:

**Server** (`auth.service.ts`). `normalizeSlug(name)` exported so
`initiateSignup`, `completeSignup`, and `firstBootSetup` share one
slug-derivation. Slug collision is now its own 409 error code
`SLUG_TAKEN` — two distinct display names that collapse to the
same slug (e.g. "Acme Corp" vs "Acme, Corp!") return a clear error
instead of a raw unique-constraint 500. Empty slug (all
punctuation) returns `INVALID_TENANT_NAME`. `verifyCode` and
`verifyToken` now branch into four outcomes (INVALID_*,
MAGIC_LINK_EXPIRED, MAGIC_LINK_USED, MAX_ATTEMPTS) so the UI can
offer an inline re-request button keyed on the code.

**Frontend** (`app.js`). `checkUrlToken` no longer hangs on a
verify-token failure — it re-shows the landing modal with a
"Send a new link" button bound to `/api/auth/magic-link`. Signup /
verify / setup / login button-disable resets moved into `.finally()`
so a thrown error inside `.then()` can't permanently brick the
form. Field focus jumps to the offending input on SLUG_TAKEN /
TENANT_EXISTS / EMAIL_EXISTS.

**Frontend bundle** (dashboard_list, version 2026-04-23-009-step5i).
Onboarding checklist rendered in place of the bare "No dashboards
yet" empty state when (a) the tenant has zero dashboards and (b)
the viewer is owner or platform admin. Three cards: Connect
integration (scrolls to the existing My-Integrations strip),
Configure billing (navigateTo billing), Invite a teammate
(navigateTo team). Dismiss persists in localStorage keyed on
tenant id.

**Tests**. New `auth.service.test.ts` with 6 `normalizeSlug` specs
(casing, run-collapsing, trimming, two-names-one-slug, empty
input, digit preservation).

### Commit (ii-a) — Tenant billing management page

Rewrote the billing view as a real management surface. Card entry
stays hosted by Stripe — XRay never sees card numbers.

**Backend** (`stripe.service.ts`, `stripe.routes.ts`):
- `cancelSubscriptionAtPeriodEnd(tenantId, subId)` —
  `subscriptions.update(cancel_at_period_end: true)` with a guard
  that the subscription's `customer` matches the tenant's
  `stripe_customer_id`. Throws `SUBSCRIPTION_NOT_OWNED` otherwise.
- `resumeSubscription(tenantId, subId)` — `cancel_at_period_end:
  false`, same ownership guard.
- `listSubscribableProducts()` — returns the subscribable-product
  list for the tenant billing page. (ii-a) sources from
  `stripe_gate_products`; (ii-b) introduces a dedicated
  `stripe_billing_page_products` setting.
- New routes: `GET /subscribable`, `POST /subscription/:id/cancel`,
  `POST /subscription/:id/resume`, all on `billing.manage` (cancel/
  resume) or `billing.view` (list).

**Frontend bundle** (billing, version 2026-04-23-010-step5iia):
- Status badge: Active / Active · cancels on DATE / Past due /
  Canceled / Inactive / Active · Override.
- Facts strip: plan name, next billing date (or "Ends on" when
  cancelling), days left in cycle.
- "Your subscriptions" card: Cancel-subscription button (danger
  confirm via `__xrayConfirm`) or Resume button when a scheduled
  cancellation is in-flight.
- "Available plans" card: Subscribe / Resubscribe buttons that
  POST `/api/stripe/checkout` and open the Stripe-hosted URL in a
  new tab. Button hides for products the tenant is already
  subscribed to (single-subscription enforcement at the UI layer;
  server also rejects duplicates).
- "Paid invoices" card: `status==='paid'` rows from `/status`
  invoices with Download-PDF links.
- Secondary "Manage payment methods" button: on-demand billing
  portal session (the previous view hard-coded a static URL).
- Reloads on `visibilitychange` return (post-checkout) and on
  `billing:updated` via `window.__xrayBillingChanged`.

### Commit (ii-b) — Admin Stripe product toggles

Two new per-product toggles next to the existing Gate toggle, each
persisted as its own `platform_settings` key following the
`stripe_gate_products` JSON-array pattern — no schema change.

**Backend**:
- `GET /admin/products` returns `isGateProduct`,
  `isBillingPageProduct`, `isStatusRowProduct` per row. Reads the
  three settings in parallel.
- `POST /admin/product-toggles` accepts any subset of `{ gate,
  billingPage, statusRow }` arrays, persists them, and broadcasts
  `billing:updated { togglesChanged: true }` to every tenant so
  their billing page re-fetches `/subscribable` live.
- `listSubscribableProducts()` now prefers
  `stripe_billing_page_products`, falls back to
  `stripe_gate_products` when the new setting is empty so existing
  installs keep working with zero admin action.
- Legacy `POST /admin/gate-products` still exists — admin_stripe
  view falls back to it on failure.

**Frontend bundle** (admin_stripe, version 2026-04-23-011-step5iib):
- "Gate Products" card renamed to "Products"; 3-column toggle grid
  per product (Gate / Billing page / Tenant row) with On/Off
  pills.

### Commit (ii-c) — Multi-subscriber billing fanout + paywall WS close + tests

Fixes a clobbering bug and tightens the existing paywall. Gate wire
itself unchanged.

**Frontend** (`app.js`):
- `window.__xrayOnBilling(fn)` subscribe API backed by
  `__xrayBillingSubscribers` array. The WS `billing:updated` path
  fans out to every subscriber; legacy `__xrayBillingChanged = fn`
  still fires for older bundles.
- `togglesChanged` added to the silent-refresh branch alongside
  `gateChanged` so (ii-b)'s admin toggle broadcasts don't toast.

**Frontend bundle** (dashboard_list + billing, version
2026-04-23-012-step5iic):
- `dashboard_list`: paywall-banner handler extracted to a named
  `__billingSyncFromWs` that also closes `#sub-required-modal`
  when hasVision flips true — fixes "paid in another tab, modal
  still blocking." Registers via `__xrayOnBilling` with
  MutationObserver unmount cleanup.
- `billing`: same subscribe + cleanup pattern so the billing view
  refreshes in parallel with dashboard_list.

**Backend**:
- Extracted `resolveSubscribableProductIds(billingRaw, gateRaw)` —
  pure function, no DB or Stripe calls. Tolerates malformed JSON
  and non-array values (treated as empty).

**Tests**. New `stripe.service.test.ts` with 8 resolver specs
covering prefer-billing, fall-back-to-gate, both-empty,
malformed-billing, malformed-both, non-string-entries,
non-array-value. **127/127 total** (was 119 after (i)).

### Commit (iii) — Admin tenants polish + grant-management UI

Four items on the admin surface, no migration:

**Backend** (`admin.service.ts`):
- `listAllTenants` returns extra fields: `last_render_at`
  (`MAX(audit_log.created_at)` where `action='dashboard.opened'`,
  per tenant — no new audit action), `billing_override` (bool
  derived from `platform_settings.billing.override.<tenant_id>`),
  `subscription_status_simple` ('active' | 'inactive' | 'override'
  per the operator's "real-time gate = two meaningful states"
  rule).
- `inviteTenantOwner(...)` wraps `authService.initiateSignup` so
  completeSignup creates the tenant atomically when the recipient
  clicks the magic link. Audit-logged as `tenant.owner_invited`.
  Email uses the existing `signup_verification` template for now;
  (v) provides the branded replacement.
- Custom-Globals grant helpers: `listDashboardGrants`,
  `grantDashboardToTenant` (guards `scope='global' AND integration
  IS NULL` — throws `NOT_CUSTOM_GLOBAL` on anything else),
  `revokeDashboardGrant`. All audit as
  `dashboard.grant_added` / `dashboard.grant_removed`.

**Routes** (`admin.routes.ts`):
- `POST /invite-tenant-owner`
- `GET/POST /dashboards/:id/grants`
- `DELETE /dashboards/:id/grants/:tenantId`

**Frontend bundle** (admin_tenants + admin_dashboards, version
2026-04-23-013-step5iii):
- `admin_tenants`: new "Subscription" column (renders only when
  the admin has configured `stripe_status_tenant_row_products`) +
  "Last render" column. New "Invite tenant owner" button with a
  modal (email + optional name + proposed org name). Cell values
  escHtml'd (prior code rendered tenant.name / slug / owner_email
  unescaped — quietly fixed).
- `admin_dashboards`: new "Grants" column. Custom Globals show a
  "Manage" button that opens a modal with a tenant picker (Add)
  and a per-grant Remove button (danger confirm). Tenant list
  cached for session.

**Deferred-from-(iii) items**:
- Failure-count column on admin tenants row — no render-failure
  audit action exists today. Follow-up requires threading
  render-path failures into `audit_log`.
- Branded `tenant_invitation` email template — ships in (v) as
  a default in `email-templates.ts` and available via the Reset
  action.

### Commit (iv) — install.sh fails loud on unhealthy server

Scoped down from the kickoff: operator vetoed integration seeding
and first-login magic-link bootstrap (the first self-signup is
already the platform admin — no bootstrap token needed). Only the
health-check tighten shipped.

**install.sh**:
- On `/api/health` timeout, exit `1` with a red error line, then
  dump the last 30 lines of `docker compose logs server` inline
  so the operator sees the real failure without a follow-up
  command.
- New `err()` helper alongside the existing `warn/ok/info/fail`
  set for style consistency.

### Commit (v) — Email templates (boot-time seed + rebrand + Reset)

**`server/src/services/email-templates.ts`** (new). `DEFAULT_TEMPLATES`
array with six entries: `signup_verification`, `login_code`,
`account_recovery`, `invitation`, `passkey_registered` (new
security notification on new passkey registration),
`billing_locked` (new subscription-lapsed notice). Consistent dark
theme HTML wrapper (brand accent color, rounded card layout,
signing code front-and-center) + plaintext twin per template.
`seedDefaultTemplates()` upserts missing keys on server boot
using `ON CONFLICT DO NOTHING` — admin-edited templates are never
clobbered, and a future XRay release introducing a new key seeds
automatically without a migration.

**`index.ts`** calls `seedDefaultTemplates()` right before
`server.listen`. One-line log on new inserts.

**`init.sql`** — adds `ON CONFLICT (template_key) DO NOTHING` to
the existing INSERT so a re-run doesn't blow up on a unique
constraint. Legacy template content stays as-is for fresh
installs; the boot-time seed becomes the single source of truth
after first boot.

**Admin reset action**:
- `POST /api/admin/email-templates/:key/reset` —
  `resetEmailTemplate(key)` overwrites a template's subject / HTML
  / text / variables / description with the current default. 404
  `NOT_DEFAULTED` for keys without a default. Audit-logged.
- `admin_email` view (version 2026-04-23-014-step5v): "Reset to
  default" button in the template editor footer (danger confirm).
  On success, editor fields rewrite with the new content and the
  preview iframe re-renders.

Rationale for opt-in (not force-update) rebrand: forcing new HTML
would silently discard operator customizations. Explicit Reset
keeps the new branding available without hidden side effects.

### Commit (vi) — Operator + tenant-owner docs

Two new docs at the repo root:

- `docs/operator.md` — OAuth app registration (HCP, QuickBooks,
  generic), Stripe setup (API keys, webhook events, restricted-key
  scopes, the three per-product toggles, billing overrides),
  fan-out shared-secret flow, email-templates editor and Reset
  action, troubleshooting for the common cases, upgrade path.
- `docs/tenant-owner.md` — first-login walkthrough ending at the
  (i) onboarding checklist; invite teammates + permission cheat
  sheet; connecting data sources; billing page from (ii-a);
  dashboards and Custom Globals grants; three-state share button
  from 4c; troubleshooting.

No code changes in (vi).

### Acceptance

- `npm test` 127/127 green (113 baseline + 6 auth.service + 8
  stripe.service).
- `tsc --noEmit` clean on head.
- Bundle JS sanity-checked with `node --check` on every edit.
- No SQL migrations added. Additive boot-time seeds in two paths:
  `seedDefaultTemplates` (idempotent, honors admin edits), and
  the existing product-toggle settings (JSON arrays in
  `platform_settings`).

### Env changes

None. No new env vars, no docker-compose changes, no Dockerfile
changes, no webhook event additions.

### Deploy order on the VPS

Standard `update.sh`:
- Step 2 copies `frontend/app.js`, `frontend/bundles/general.json`,
  `docs/operator.md`, `docs/tenant-owner.md`.
- Step 4 re-runs `migrations/*.sql` (all idempotent; no new
  migrations in 5).
- Step 5 rebuilds the server container. Boot seeds
  `passkey_registered` + `billing_locked` templates automatically.

### What didn't ship (deferred to step 6 or post-step-6)

- **Platform DB hardening** — RLS-is-decorative, `withClient` →
  `withTenantContext`, plaintext-read fallback retirement. All
  step 6.
- **Pipeline DB Model D / J** — still post-step-6.
- **Legacy `dashboards.view_html/css/js` column retirement** —
  post-step cleanup.
- **Failure-count column** on admin tenants — needs a render-failure
  audit action first.
- **Integration `needs_reconnect` WS broadcast** (step-4c
  follow-up) — touches `oauth-scheduler.ts`, which is fenced.
- **Per-tenant RS256 keys** — out of scope for bridge track.
- **VAPID / push-notification polish** — never in bridge scope.

### Verify on VPS after deploy

```sql
-- New default templates seeded on boot:
SELECT template_key, updated_at FROM platform.email_templates
 WHERE template_key IN ('passkey_registered', 'billing_locked')
 ORDER BY template_key;

-- Tenant invite audit trail:
SELECT created_at, metadata->>'email', metadata->>'proposed_tenant_name'
  FROM platform.audit_log WHERE action = 'tenant.owner_invited'
 ORDER BY created_at DESC LIMIT 10;

-- Custom Global grants:
SELECT g.dashboard_id, g.tenant_id, d.name AS dashboard_name,
       t.name AS tenant_name, g.created_at
  FROM platform.dashboard_tenant_grants g
  JOIN platform.dashboards d ON d.id = g.dashboard_id
  JOIN platform.tenants t ON t.id = g.tenant_id
 ORDER BY g.created_at DESC;

-- Per-product toggle settings:
SELECT key, value FROM platform.platform_settings
 WHERE key IN ('stripe_gate_products',
               'stripe_billing_page_products',
               'stripe_status_tenant_row_products');
```

Browser-side smoke test:

1. Open `/`, click Start → enter email → magic link arrives
   (rebranded once admin clicks Reset on `signup_verification`).
2. Verify → tenant setup form → empty dashboard list renders the
   onboarding checklist with three cards.
3. Click "Configure billing" → Billing page shows Subscribe button
   for the gate product → click → Stripe checkout in new tab →
   complete → return to XRay → paywall drops within a second
   (WebSocket unlock).
4. Click "Cancel subscription" → confirm → Cancel button flips to
   "Resume subscription"; status badge reads "Active · cancels on
   DATE". Click Resume → flips back.
5. As platform admin, open Admin → Tenants. The new tenant shows
   "Active" in the Subscription column (once the admin toggles
   "Tenant row" on the primary product) and a timestamp in "Last
   render" after the tenant opens a dashboard.
6. Admin → Dashboards → any Custom Global → "Grants" column →
   Manage → add the new tenant → the tenant's dashboard list
   surfaces the Global within a WebSocket tick.


## Step 6 — Platform DB hardening (shipped)

The "RLS is decorative no more" milestone. Step 6 turns the platform
DB's tenant_isolation policies into actual enforcement, migrates
tenant-scoped service call sites onto a new `withTenantContext`
helper, retires the plaintext-read fallback in the encrypted-column
helpers, and ships two deferred-from-step-5 items: the render-failure
audit action and the OAuth needs_reconnect WebSocket broadcast.
Prerequisite for the on-prem migration.

### Commit trail (22 commits on `claude/xray-tenant-capture-bridge-hp8ut`)

| # | Concern | Ref |
|---|---|---|
| i | Audit + taxonomy doc | `.claude/withclient-audit.md` |
| ii | `withTenantContext` / `withAdminClient` helper refactor | `server/src/db/connection.ts` |
| iia | Migration 029 — RLS policy audit fill-in | `migrations/029_rls_policy_audit.sql` |
| iii.1-17 | Tenant-scoped call-site migration (services round 1+2; routes/admin/auth deferred) | 17 per-service commits |
| iv | Cross-tenant probe — SQL + TS | `migrations/probes/probe-rls-cross-tenant.sql`, `server/src/db/rls-probe.test.ts` |
| v | Retire plaintext fallback in decrypt helpers | `server/src/lib/encrypted-column.ts` |
| vi | `dashboard.render_failed` audit + admin `last_render_failed_at` | `dashboard.routes.ts`, `admin.service.ts` |
| vii | `integration:needs_reconnect` WS broadcast | `oauth-scheduler.ts` |
| viii | CLAUDE.md tenant-context guardrails | `CLAUDE.md` |
| ix | CONTEXT.md handoff + cutover checklist | this section + `.claude/cutover-checklist.md` |

### Helper redesign (commit ii)

Old: `withTenantContext(tenantId, isPlatformAdmin, fn)` — took a
bypass flag that, when `true`, short-circuited the very RLS
tenant_isolation policy the helper existed to enforce. Zero call
sites actually invoked it (the one import in `ai.service.ts` was
dead code — the file has its own user-scope helper).

New:
- `withTenantContext(tenantId, fn)` — always sets
  `app.current_tenant = tenantId` AND `app.is_platform_admin = 'false'`.
  RLS policies gate every query.
- `withAdminClient(fn)` — opt-in bypass. Sets
  `app.is_platform_admin = 'true'`. Use for admin UI, Stripe
  webhook reverse-lookups, fan-out iteration.
- `withClient(fn)` — unchanged; for unauth / bootstrap only.
- Transaction analogues: `withTenantTransaction`,
  `withAdminTransaction`.

Dead `withTenantContext` import in `ai.service.ts` removed.
6 unit tests (`server/src/db/connection.test.ts`) lock the
set_config sequence each helper emits against a fake pool.

### Migration 029 — RLS policy fill-in (commit iia)

Added `tenant_isolation` + `platform_admin_bypass` policies on 5
tables that carried a `tenant_id` column but had no RLS at all:
`fan_out_deliveries`, `dashboard_render_cache`,
`dashboard_tenant_grants`, `dashboard_shares`, `tenant_notes`.

**`tenant_notes` gets admin_bypass only** — deliberately no
`tenant_isolation` because notes are platform-admin-only forever
(may be removed entirely later). Tenant-context reads return zero
rows by default-deny.

**`connection_comments`** already had RLS enabled in init.sql with
only `platform_admin_bypass`; no `tenant_isolation`. Since the
table has `connection_id` (not `tenant_id`), the new policy joins
transitively via `EXISTS (SELECT 1 FROM platform.connections c …)`.

Documented carve-outs (stay bypass-only / global): `magic_links`,
`platform_settings`, `email_templates`, `integrations`,
`fan_out_runs`, `roles`, `permissions`, `role_permissions`,
`connection_templates`, `tenants`. Inbox tables stay user-scoped
(deferred — mirrors mig 016's user_scope shape in a future pass).

Purely additive, idempotent, no data migration.

### Call-site migration (commits iii.1–iii.17)

302 `withClient` call sites audited. Per-service case-by-case
evaluation and commit. Three broad outcomes:

- **All tenant-scoped → `withTenantContext`**: `connection.service`,
  `webhook.service`, `data.service`.
- **All admin-surface → `withAdminClient`**: `rbac` (partial; only
  `deleteRole` touches RLS tables), `apikey`, `push`, `inbox`,
  `replay`. Plus local `bypassRLS` helpers deleted in `webhook`
  and `user`.
- **Mixed — per-function classification**: `audit`, `upload`,
  `invitation`, `meet`, `user`, `fan-out`, `integration`,
  `stripe`, `dashboard.service` (mechanical sweep only;
  per-function refinement deferred).

The `dashboard.service` mechanical-only sweep is a deliberate
choice: 28 call sites in 1121 lines touching the public/embed/
share/render paths. The 1:1 `withAdminClient` swap preserves
behavior exactly while leaving the tenant-context tightening as a
visible follow-up.

**Still on `withClient` at step-6 close** (per the audit doc's
ordering):
- Routes: `connection.routes`, `inbox.routes`, `user.routes`,
  `oauth.routes`, `dashboard.routes`, `stripe.routes` (~38 sites).
- Admin surface: `admin.service` (36), `admin.routes` (5),
  `admin.ai.routes` (5), `portability.service` (3).
- Auth/bootstrap: `auth.service` (18 — mostly unauth U paths
  that correctly stay on `withClient`).
- Misc: `settings.service`, `email.service`, `email-templates`.
- System: `oauth-scheduler` (2 — the scheduler's select/refresh
  ops; classified as S/A, not migrated because they're correctly
  cross-tenant by design).

### Cross-tenant probe (commit iv)

Two artifacts:

1. **SQL probe** (`migrations/probes/probe-rls-cross-tenant.sql`) — the
   literal acceptance check from the step-6 kickoff. Creates two
   synthetic tenants inside a BEGIN/ROLLBACK, inserts one row per
   RLS-enabled tenant-scoped table for each, then switches into
   each tenant's context and `RAISE EXCEPTION`s on any leak.
   Prints `PROBE PASS` on success. Zero residue.

2. **Vitest probe** (`server/src/db/rls-probe.test.ts`) — drives
   the same probe through `withTenantContext` / `withAdminClient`
   against a live DB. Skipped by default;
   `PROBE_RLS=1 DATABASE_URL=... npx vitest run src/db/rls-probe.test.ts`
   runs it. Catches helper-level bugs the pure-SQL probe can't see.

### Encryption-column strict mode (commit v)

`decryptSecret` and `decryptJsonField` now **throw** on any input
that doesn't carry the `enc:v1:` envelope. Previously they
returned plaintext unchanged and emitted a single WARN per
`(table, column, row_id)` — a transitional fallback for rows
predating step 1's backfill. Every VPS that's run step 1's
backfill has no legacy plaintext rows left, so the fallback was
silently masking what would otherwise be bug signals (missed
backfill, direct DB write bypassing the `enc:v1:` enforcement
triggers, or a trigger that was DISABLEd).

`warnPlaintext` dedup cache + `__resetPlaintextWarnings` test
hook both deleted. Two new specs cover the reject path; two
legacy "pass-through with WARN" specs removed.

### Deferred-from-earlier-steps items shipped (commits vi + vii)

**vi — `dashboard.render_failed` audit.** Render route emits an
audit row when the upstream-fetch retry loop exhausts. Metadata
includes last error, attempt count, scope, and
`fallback_used: bool`. Also adds `last_render_failed_at`
subquery to `admin.service.listAllTenants` so the admin UI can
surface a "Last failure" column (closes step-5's deferred item).

**vii — `integration:needs_reconnect` WS broadcast.**
`oauth-scheduler` fires when the refresh loop flips
`connections.status → 'error'` — either from the exhausted-retries
path or the missing-refresh-token path. UI pill goes live without
waiting for the next poll. Mirrors step-4c's
`integration:connected` / `integration:disconnected` shape.

### Acceptance

- `npm test`: 133 active specs green (127 baseline + 6 new helper
  specs + various teardown in encrypted-column). 8 RLS probe specs
  correctly skipped without `PROBE_RLS=1`.
- `tsc --noEmit`: clean.
- Cross-tenant probe: runs against fresh Postgres with `PROBE PASS`
  output. Covers every RLS-enabled tenant-scoped table in
  init.sql + migrations 017-029.
- Migration 029 applied idempotently — re-running is a no-op.

### Env changes

None. No new env vars, no Dockerfile or docker-compose changes.

### Deploy order on the VPS

Standard `update.sh`:
- Step 2 copies `frontend/app.js` (unchanged this step but still
  part of the pipeline).
- Step 4 re-runs `migrations/*.sql`; migration 029 lands.
- Step 5 rebuilds the server container with the new helpers +
  services.

After rebuild, run the probe from the host:

```
docker exec -i xray-postgres psql -U xray -d xray \
  < migrations/probes/probe-rls-cross-tenant.sql
```

Expect `PROBE PASS`.

### Verify on VPS after deploy

```sql
-- Migration 029 policies present:
SELECT tablename, policyname FROM pg_policies
 WHERE schemaname = 'platform'
   AND tablename IN ('fan_out_deliveries','dashboard_render_cache',
                     'dashboard_tenant_grants','dashboard_shares',
                     'tenant_notes','connection_comments')
 ORDER BY tablename, policyname;

-- tenant_notes has admin_bypass only (no tenant_isolation):
SELECT policyname FROM pg_policies
 WHERE schemaname='platform' AND tablename='tenant_notes';

-- render-failed audit fires (pick a tenant with a broken dashboard,
-- render, check audit_log):
SELECT created_at, metadata->>'reason', metadata->>'fallback_used'
  FROM platform.audit_log
 WHERE action = 'dashboard.render_failed'
 ORDER BY created_at DESC LIMIT 10;

-- last_render_failed_at surfaces in admin tenants list:
SELECT t.name, (
  SELECT MAX(al.created_at) FROM platform.audit_log al
   WHERE al.tenant_id = t.id AND al.action = 'dashboard.render_failed'
) AS last_render_failed_at
  FROM platform.tenants t
 ORDER BY last_render_failed_at DESC NULLS LAST LIMIT 10;
```

Browser-side smoke:

1. Open `/`, log in as platform admin.
2. Admin → Tenants — page renders, no RLS errors in server logs.
3. Admin → Dashboards → render one — renders as expected.
4. Tenant view — user's billing page loads with correct
   subscription (no tenant leaks, no cross-tenant data visible).
5. Disable an OAuth app's client_secret in the integrations admin
   panel → next scheduler tick (or wait 5 min) → tenant's UI pill
   flips to "Needs reconnect" via WebSocket (no page refresh).

### What didn't ship (deferred to post-step-6)

- **Per-function tenant-context refinement for `dashboard.service`**
  — 10+ functions take `tenantId` and only touch tenant-scoped
  tables. Mechanical sweep shipped in iii.17 preserves behavior;
  targeted `withTenantContext` is a separate PR.
- **Routes tenant-context migration** — `connection`, `inbox`,
  `user`, `oauth`, `dashboard`, `stripe` routes (~38 sites) plus
  admin surface (~46 sites). All currently correct under
  `withClient + admin bypass`; migration is a ratchet, not a bug
  fix.
- **Auth.service tenant-context migration** — 18 sites, mostly
  U paths (unauth flows: magic link, signup, first-boot). A few
  A paths (admin flag lookups that cross-tenant). Reviewed in the
  audit doc but not migrated.
- **Formal pre-commit lint / `.eslintrc` rule** for the
  `withTenantContext` default. CLAUDE.md documents the policy;
  automated enforcement waits for the allow-list to stabilize.
- **Pipeline DB Model D / J** — still the post-step-6 pipeline
  hardening. See `.claude/pipeline-hardening-notes.md`.
- **Inbox user_scope RLS** — mirrors migration 016's shape.
  Future pass.
- **Legacy `dashboards.view_html/css/js` column retirement** —
  reader audit required.
- **Portability export/import gap-fill** — needs to round-trip
  `stripe_customer_id`, `stripe_subscription_id`,
  `platform_settings`, `api_keys`, `webhooks`, `integrations`,
  new post-4b tables. Currently operators should `pg_dump` for
  host moves (see cutover checklist).
- **Admin "Last failure" column frontend wiring** — backend
  surface shipped in (vi); the bundle UI change is cosmetic and
  non-blocking.

### Cutover ready

`.claude/cutover-checklist.md` has the step-by-step for the
on-prem migration — pre-flight (schema sync, encryption key
inventory, Stripe/OAuth URI staging), cutover window (pg_dump,
restore, file sync, secret rotation, webhook/DNS flip), and
post-cutover (probe re-run, audit monitoring, vps-old decommission).


## Step 7 — Platform security baseline close-out (shipped)

The "step 6 ratchet" milestone. Every tenant-data path on the
platform DB is RLS-enforced (not relying on app-layer WHERE
tenant_id alone), the embed endpoint no longer leaks upstream
config, future regressions are blocked by a pre-commit rule, and
the cross-tenant probe covers every RLS-enabled table.

### Commit trail (24 commits on `claude/xray-platform-hardening-AY4dd`)

| # | Concern | Ref |
|---|---|---|
| A1 | dashboard.service per-function tenant context | `services/dashboard.service.ts` |
| A2 | connection.routes → withTenantContext | `routes/connection.routes.ts` |
| A3 | inbox.routes → withAdminClient (cross-tenant lookups) | `routes/inbox.routes.ts` |
| A4 | user.routes → withTenantContext | `routes/user.routes.ts` |
| A5 | oauth.routes → tenant/admin split | `routes/oauth.routes.ts` |
| A6 | dashboard.routes → named helpers | `routes/dashboard.routes.ts` |
| A7 | stripe.routes → tenant/admin split | `routes/stripe.routes.ts` |
| A8 | admin.service → withAdminClient | `services/admin.service.ts` |
| A9 | admin.routes → withAdminClient | `routes/admin.routes.ts` |
| A10 | admin.ai.routes → withAdminClient | `routes/admin.ai.routes.ts` |
| A11 | portability.service → withAdminClient | `services/portability.service.ts` |
| A12 | oauth-scheduler → withAdminClient | `lib/oauth-scheduler.ts` |
| A13 | auth.service → named helpers (U + A split) | `services/auth.service.ts` |
| A14 | annotate remaining withClient allow-list | settings/email/email-templates |
| B1 | pre-commit withClient allow-list guard | `scripts/check-withclient-allowlist.sh`, `.githooks/pre-commit` |
| B2 | widen rls-probe.test.ts coverage | `db/rls-probe.test.ts` |
| C1 | embed endpoint projection tightening | `services/dashboard.service.ts`, `services/embed-projection.test.ts` |
| C2 | inbox user_scope RLS + withUserContext helper | `migrations/030_inbox_user_rls.sql`, `db/connection.ts`, `services/inbox.service.ts` |
| C3 | dashboards.view_html/css/js reader audit (drop deferred) | `.claude/dashboard-view-columns-audit.md` |
| C4 | portability export/import gap-fill | `services/portability.service.ts`, `docs/operator.md` |
| C5 | branded `tenant_invitation` email template | `services/email-templates.ts`, `auth.service.ts`, `admin.service.ts` |
| ix | CONTEXT.md handoff + withclient-audit doc refresh | this section + `.claude/withclient-audit.md` |

### Cluster A — tenant-context tightening

302 audited withClient call sites in step 6 (i) → 0 outside the
allow-list after step 7. Per-file commits, one concern per commit.

The 14 files in scope (kickoff list) plus a step-6 (iii) sweep
finish-up:
  - `services/ai.service.ts` (13 explicit-bypass sites → withAdminClient).
  - `services/tenant.service.ts` getTenantDetail's admin-bypass site →
    withAdminClient.

`services/admin.service.ts` was the largest single sweep — 36
withClient → withAdminClient, 5 withTransaction → withAdminTransaction,
29 redundant `set_config('app.is_platform_admin', 'true', true)`
lines deleted (the helpers set it already).

`auth.service.ts` had the most nuance: 18 sites, classified into
A (admin bypass — pre-tenant lookups, cross-tenant magic-link consume,
mid-login user_id reads) and U (carve-out tables — magic_links,
platform_settings). The functional change vs pre-step-7: nested
inner calls (getUserPermissions / getUserFlags) no longer rely on
residual set_config state from the outer checkout — each call sets
its own context deterministically.

`dashboard.service.ts` per-function refinement: 10 functions that
take a tenantId moved onto withTenantContext / withTenantTransaction.
makePublic / makePrivate / rotatePublic split — scope probe runs
under admin bypass via a new resolveDashboardScope helper (Globals
carry tenant_id NULL on platform.dashboards per migration 025), the
per-tenant writes run in tenant context.

A bonus latent fix landed in A6: the pre-step-7 dashboard render
route set is_platform_admin via `String(req.user!.is_platform_admin)`
which evaluated to 'false' for tenant users and filtered Globals out
under RLS. Switching to withAdminClient fixes the render path for
non-admin Global renders — the WHERE clause was always the intended
gate.

### Cluster B — enforcement + probe coverage

**B1 — pre-commit guard** (`scripts/check-withclient-allowlist.sh`,
.githooks/pre-commit). Shell-based grep flags any direct
`withClient(` call outside the post-step-7 allow-list. Designed as
a pre-commit hook — enable per-clone with
`git config core.hooksPath .githooks`. The kickoff offered eslint
or shell; we picked shell because the allow-list is stable and the
shape is small (~140 lines). An eslint custom rule is deferred
post-step-7 once the rule shape needs more nuance than grep can
express.

Allow-list (final, locked):
- `server/src/db/connection.ts` (helper definitions)
- `server/src/services/auth.service.ts` (U paths + carve-outs)
- `server/src/services/settings.service.ts` (platform_settings)
- `server/src/services/email.service.ts` (email_templates)
- `server/src/services/email-templates.ts` (boot seed)
- `server/src/services/meet.service.ts` (platform_settings + tenants)
- `server/src/services/rbac.service.ts` (roles catalog reads)
- `server/src/services/role.service.ts` (permissions catalog reads)
- `server/src/services/tenant.service.ts` (tenants catalog reads)

Every entry touches carve-out tables from migration 029 (no RLS) or
pre-auth flows.

**B2 — probe widening** (`server/src/db/rls-probe.test.ts`). +18
new assertions. Pre-step-7: 8 specs covering dashboards, connections,
render cache, shares, connection_comments, tenant_notes. Post-step-7:
26 specs adding users, billing_state, audit_log, user_sessions,
dashboard_access, dashboard_sources, connection_tables, invitations,
user_passkeys, dashboard_embeds, api_keys, webhooks, file_uploads,
dashboard_tenant_grants, fan_out_deliveries, plus three for the
inbox user_scope policies added in migration 030. All gated on
`PROBE_RLS=1 DATABASE_URL=...`.

### Cluster C — latent security + cleanup

**C1 — embed projection tightening.** GET /api/embed/:token used to
return `SELECT *` from platform.dashboards, surfacing fetch_url +
fetch_method + fetch_body + fetch_query_params + bridge_secret to
any embed-token holder. Embed tokens are RENDER capabilities, not
config-disclosure capabilities. New `EMBED_PROJECTED_COLUMNS`
constant projects to the minimal render-ready shape (id, tenant_id,
name, description, status, scope, template_id, integration,
is_public, public_token, view_html/css/js, tile_image_url,
created_at, updated_at). New spec at
`services/embed-projection.test.ts` locks the projection — CI fails
if anyone re-introduces fetch_url / etc.

**C2 — inbox user_scope RLS + withUserContext helper.** Migration
030 enables RLS on inbox_threads, inbox_thread_participants,
inbox_messages with user_scope policies keyed on
`app.current_user_id` (transitive via participants for threads +
messages, since those tables don't carry user_id directly).
Mirrors migration 016's shape but for user-keyed inbox semantics.

`db/connection.ts` gains `withUserContext(tenantId, userId, fn)` —
sets current_tenant + current_user_id, clears is_platform_admin.
Mirrors ai.service's local `withAiUserContext`; retiring that
duplication is post-step-7.

inbox.service migration:
- listThreads, toggleStar, toggleArchive, getThreadMessages,
  getUnreadCount switch to withUserContext.
- Cross-user writes (sendMessage adding participants, getRecipients,
  getTenantMembers, getPlatformAdminIds, getThreadParticipants,
  setThreadTag) stay on withAdminClient.

**C3 — dashboards.view_html/css/js reader audit.** Audit at
`.claude/dashboard-view-columns-audit.md`. Columns are NOT safely
retireable today — they're the primary storage for static custom
dashboards (no fetch_url), feed buildDashboardBundle, and round-trip
through portability. A six-step retirement plan is captured for a
post-step-7 follow-up. **No column drop in step 7.**

**C4 — portability export/import gap-fill.** Closes the gaps the
kickoff called out:
- tenants.stripe_customer_id added to import whitelist.
- billing_state.stripe_subscription_id + current_period_end now
  round-trip via the safeInsert.
- Six new sections: platform_settings, api_keys, webhooks,
  integrations, dashboard_tenant_grants, dashboard_shares.
- `docs/operator.md` gained a "Platform export / import" section
  documenting `ENCRYPTION_KEY` as a required sidecar (every
  encrypted column in the export decrypts only with the source's
  key — destination MUST share it).

**C5 — branded `tenant_invitation` email template.** Default
template added to `email-templates.DEFAULT_TEMPLATES`. Subject
"You have been invited to set up {{tenant_name}} on XRay".
`auth.service.initiateSignup` grew an optional
`invitation: { inviterName }` param that swaps the outbound template
from signup_verification → tenant_invitation when present.
admin.service.inviteTenantOwner resolves the inviter's display name
and threads it through. Self-signups unchanged.

### What didn't ship (deferred to post-step-7)

The "deferred" list below is superseded by the formal roadmap
section at the end of this file ("Roadmap — steps 8 through 21").
It's preserved here for the historical record of step 7's scope.

- **VAPID / push polish (C6).** Inline `CREATE TABLE IF NOT EXISTS`
  in push.service should move to a proper migration; VAPID keys
  should move from env to platform_settings. Low priority — only
  blocks push features not yet shipped.
- **Globals-only portability export (C7).** Admin UI option to
  export Globals + integrations catalog + email templates as a
  shareable "starter pack". This is a new feature, not a close-out
  item; deferred so step 7 stays scope-disciplined.
- **Legacy `dashboards.view_html/css/js` retirement.** Audit shipped
  as a doc; the actual reader migration + column drop is a multi-
  session task captured in the audit doc.
- **ai.service local withAiUserContext duplication.** ai.service
  has its own copy of the user-scope helper logic. Retiring that in
  favor of the new `withUserContext` from db/connection.ts is a
  refactor we deferred to keep step 7 focused on RLS coverage rather
  than helper consolidation.
- **ESLint custom rule for the withClient allow-list.** Pre-commit
  shell grep is enforcing the rule today. ESLint upgrade waits for
  the rule shape to demand more nuance than grep handles.
- **Pipeline DB Model D / J.** Still the post-step-7 pipeline
  hardening track. See `.claude/pipeline-hardening-notes.md`.

### Acceptance

- `npm test`: 135 active specs green (133 step-6 baseline + 2 new
  embed-projection specs); 26 RLS probe specs skipped without
  `PROBE_RLS=1` (was 8 pre-step-7).
- `tsc --noEmit`: clean.
- `withClient` direct-call count in `server/src` (excluding
  test files): 13 sites total, all in 9 allow-listed files. Pre-step-7:
  ~80 sites across 22 files.
- Cross-tenant probe (`migrations/probes/probe-rls-cross-tenant.sql`):
  unchanged; still PROBE PASS post-migration 030 (which only adds
  user_scope policies, doesn't touch tenant_isolation).
- Embed endpoint manually verified to exclude fetch_url + friends
  via the EMBED_PROJECTED_COLUMNS constant — projected shape locked
  by `services/embed-projection.test.ts`.

### Env changes

None. No new env vars, no Dockerfile or docker-compose changes.

### Deploy order on the VPS

Standard `update.sh`:
- Step 4 re-runs `migrations/*.sql`; migration 030 (inbox user_scope
  RLS) lands. Idempotent re-run is a no-op.
- Step 5 rebuilds the server container with the new helpers + new
  embed projection + branded tenant invitation template.
- email_templates.seedDefaultTemplates runs on boot and inserts
  the new `tenant_invitation` row (existing rows preserved via
  ON CONFLICT DO NOTHING).
- After rebuild, run the SQL probe from the host to verify the
  step-6 acceptance still holds:
  ```
  docker exec -i xray-postgres psql -U xray -d xray \
    < migrations/probes/probe-rls-cross-tenant.sql
  ```
- Optionally run the widened TS probe against the live DB:
  ```
  PROBE_RLS=1 DATABASE_URL=postgres://xray:xray@<host>:5432/xray \
    npx vitest run src/db/rls-probe.test.ts
  ```

### Verify on VPS after deploy

```sql
-- Inbox user_scope policies present (migration 030):
SELECT tablename, policyname FROM pg_policies
 WHERE schemaname = 'platform'
   AND tablename IN ('inbox_threads','inbox_thread_participants','inbox_messages')
 ORDER BY tablename, policyname;

-- tenant_invitation template seeded:
SELECT template_key, subject FROM platform.email_templates
 WHERE template_key = 'tenant_invitation';
```

Browser-side smoke:

1. Open `/`, log in as platform admin.
2. Admin → Tenants → Invite Owner — recipient receives the new
   "You have been invited to set up X on XRay" email instead of
   the generic "Verify your email" copy.
3. Open an embed URL — response body excludes fetch_url /
   fetch_method / fetch_query_params (inspect via
   `curl -s /api/embed/<token> | jq 'keys'`).
4. As a regular tenant user, open Inbox — only the user's own
   threads are visible. As a platform admin, every thread visible
   for support.


## Step 8 — CI plumbing (shipped)

Supply-chain plumbing baseline. Branches the repo from "no
`.github/`, no automated checks" to a 6-commit floor of
Dependabot, CI typecheck+test, CodeQL SAST, Trivy image scan,
and gitleaks pre-commit. Most of step 8 is YAML config — only
two application-touching edits land: `engines.node` + a
`typecheck` script in `server/package.json`.

### Commit trail (6 commits on `claude/xray-hardening-step-8-QsvZK`)

| # | Concern | Ref |
|---|---|---|
| 1 | dependabot.yml — npm + docker + actions | `.github/dependabot.yml` |
| 2 | ci.yml baseline + typecheck script + engines.node | `.github/workflows/ci.yml`, `server/package.json` |
| 3 | codeql.yml — javascript-typescript SAST | `.github/workflows/codeql.yml` |
| 4 | Trivy image-scan job appended to ci.yml | `.github/workflows/ci.yml` |
| 5 | gitleaks staged-index scan in pre-commit hook | `.githooks/pre-commit`, `CLAUDE.md` |
| 6 | repo-settings checklist + this section | `.claude/step-8-repo-settings.md`, `CONTEXT.md` |

### What shipped

- **Dependabot** for `npm` (server/, daily, minor+patch grouped),
  `docker` (server/Dockerfile base, weekly), and
  `github-actions` (root, weekly, minor+patch grouped). Majors
  always open their own PR for individual review.
- **`ci.yml`** with two parallel jobs:
  - `server`: `actions/setup-node@v4` reading `node-version-file:
    server/package.json` (the new `engines.node = "20.x"`),
    `npm ci`, `npm run typecheck`, `npm test`.
  - `image-scan`: `docker/build-push-action@v6` builds the
    server image, `aquasecurity/trivy-action@0.28.0` scans
    OS + library tiers, exits 1 on HIGH/CRITICAL with a fix
    available. `ignore-unfixed: true` keeps the gate green for
    CVEs without a published fix; `.trivyignore` at repo root
    is honored once allow-list entries become necessary.
- **`codeql.yml`** — `github/codeql-action@v3` with the
  `security-and-quality` query suite, single-language matrix
  (`javascript-typescript`). Triggers: push + PR on `main`,
  weekly Mon 07:23 UTC.
- **gitleaks pre-commit** — `gitleaks protect --staged --redact
  --no-banner` runs after the existing withClient guard. Soft-
  skips with a warning if the binary isn't installed; CI is the
  authoritative gate.
- **`engines.node = "20.x"`** in `server/package.json` so CI's
  setup-node tracks the same Node major as
  `server/Dockerfile`'s `node:20-alpine`.
- **`typecheck` script** (`tsc --noEmit`) — first time it has
  existed in package.json; CI runs it as a hard gate.
- **`.claude/step-8-repo-settings.md`** — operator checklist for
  the post-merge GitHub web-UI toggles (Dependabot alerts,
  secret scanning + push protection, branch protection on main,
  CodeQL code scanning).

### What didn't ship (deliberately)

- **CODEOWNERS bootstrap commit.** Operator chose option (i):
  skip, until repo ownership semantics are concrete. `.github/`
  is created naturally by the dependabot.yml commit, so no
  empty-bootstrap commit was needed.
- **Dockerfile lockfile commit.** No-op. Existing `npm ci` in the
  builder stage and `npm ci --omit=dev` in the production stage
  is already the modern lockfile-strict + dev-omit form;
  `--omit=dev` is the GitHub-recommended replacement for the
  deprecated `--only=production`.
- **CONTEXT.md close-out as its own commit.** Folded into commit
  6 alongside the repo-settings doc.

### Acceptance

- `.github/` exists with `dependabot.yml`, `workflows/ci.yml`,
  `workflows/codeql.yml`.
- `npm run typecheck` (new script): clean — no diagnostics.
- `npm test`: 135 passed / 26 skipped (unchanged from step 7's
  baseline; step 8 adds zero specs).
- Pre-commit hook still runs the withClient guard, plus gitleaks
  when the binary is available — no breakage of the step-7
  guardrail.
- Server Dockerfile uses `npm ci` (builder) + `npm ci --omit=dev`
  (production); `server/package-lock.json` committed.

### Env changes

None. No new env vars, no Dockerfile or docker-compose changes.

### Deploy order on the VPS

This step has zero application-runtime changes — `update.sh` is
not required. The merge → operator hand-off is web-UI only:

1. Merge `claude/xray-hardening-step-8-QsvZK` to `main`.
2. Operator works through `.claude/step-8-repo-settings.md`,
   flipping the Dependabot, secret scanning, push protection,
   branch protection, and code scanning toggles.
3. First PR after merge surfaces real workflow runs:
   - `ci / server` (typecheck + test).
   - `ci / image-scan` (Trivy on the freshly built image).
   - `codeql / analyze (javascript-typescript)` populates the
     Security tab.
4. If Trivy's first run reports HIGH/CRITICAL with a published
   fix, expect Dependabot to open the bump PR within 24 h.
   Findings without a fix are auto-tolerated by
   `ignore-unfixed: true`. Surface persistent false positives
   in `.trivyignore` (root) with a one-line rationale.

### Verify

- After flipping repo settings, push a no-op commit on a test
  branch and open a PR against main. Confirm:
  - `ci / server` and `ci / image-scan` both green.
  - `codeql / analyze` attached.
  - The three checks appear in the "Required status checks"
    list and can be marked required.
- Per-clone, run `git config core.hooksPath .githooks` once.
  Attempt a commit containing a fake AWS access key — verify
  the gitleaks step blocks the commit (post-installing the
  gitleaks binary first).
- Inspect the Security tab post-CodeQL-run; expect a baseline
  set of advisory-severity findings (likely zero
  high-severity). Defer triage to the next session if any
  HIGH/CRITICAL surface — step 8 ships the visibility, not the
  remediation pass.


## Step 9 — Brute-force + MFA hardening (shipped)

Highest-CVSS gap on the road to production-ready, closed in one
session. Pre-step-9 the platform had no rate limiting (the
index.ts comment literally said "Rate limiting removed") and no
MFA enforcement beyond the already-shipped optional passkey path.
Step 9 lands TOTP + backup codes alongside passkey, two-tier
brute-force throttling (100 req/60s IP+device + 20 failures/24h
per email), magic-link per-link attempt counter, passkey
enumeration guard, and operator-flippable
`require_mfa_for_platform_admins`.

### Commit trail (14 commits on `claude/xray-hardening-step-9-VBSYE`)

| # | Concern | Ref |
|---|---|---|
| 1 | migration 031 — `platform.user_totp_secrets` | `migrations/031_user_totp.sql` |
| 2 | migration 032 — `platform.user_backup_codes` | `migrations/032_user_backup_codes.sql` |
| 3 | migration 033 — `magic_links.max_attempts` | `migrations/033_magic_link_attempts.sql` |
| 4 | migration 034 — `require_mfa_for_platform_admins` seed | `migrations/034_require_mfa_setting.sql` |
| 5 | migration 035 — `platform.auth_attempts` | `migrations/035_auth_attempts.sql` |
| 6 | otplib + qrcode + bcrypt deps | `server/package.json` |
| 7 | totp.service — enroll / confirm / verify / disable | `services/totp.service.ts` |
| 8 | backup-codes.service | `services/backup-codes.service.ts` |
| 9 | totp.service.test — fake-pool round-trip specs | `services/totp.service.test.ts` |
| 10 | magic-link per-link counter + remaining-count surface | `services/auth.service.ts`, `middleware/error-handler.ts` |
| 11 | auth-flow MFA gate + interim session + `/api/auth/totp` routes | `services/auth.service.ts`, `routes/auth.routes.ts` |
| 12 | brute-force rate limiting — IP+device + per-email 24h | `middleware/rate-limit.ts`, `middleware/auth-attempts.ts`, `index.ts`, `routes/auth.routes.ts` |
| 13 | passkey enumeration guard on `/api/auth/passkey/begin` | `services/auth.service.ts` |
| 14 | frontend — Security UI, MFA modal step, attempts banners | `frontend/index.html`, `frontend/landing.js`, `frontend/app.js`, `frontend/bundles/general.json` |

### What shipped

**Migrations (foundation, landed alone before app code).**
Five migrations, each idempotent, each one-concern-per-commit:
- 031 `platform.user_totp_secrets` — one row per enrolled user;
  base32 secret stored under the `enc:v1:` envelope (migration
  017 contract); `confirmed_at` NULL until first code verifies.
  Tenant-isolation + platform-admin-bypass per migration 029.
- 032 `platform.user_backup_codes` — bcrypt-hashed single-use
  codes; partial index on `(user_id) WHERE used_at IS NULL`
  keeps the verify scan tight; ON DELETE CASCADE on user_id so
  the disable flow sweeps both tables.
- 033 `magic_links.max_attempts INT NOT NULL DEFAULT 5`. The
  pre-existing `attempts` column (init.sql:110, since the
  platform-DB baseline) is the bump-on-mismatch counter; this
  migration supplies the cap.
- 034 seeds `require_mfa_for_platform_admins='false'` in
  `platform_settings` so existing installs aren't disrupted on
  upgrade. Operator flips to `'true'` post-deploy via Admin →
  Platform Settings UI.
- 035 `platform.auth_attempts` — DB-backed per-email-24h ledger.
  No RLS (pre-tenant lookup, same carve-out shape as
  `magic_links` / `platform_settings`); accessed via
  `withAdminClient` so no `withClient` allow-list change.

**TOTP service (`services/totp.service.ts`).** Uses `otplib@^12`'s
`authenticator` namespace (v13 is an ESM-only rewrite with a
different API; v12 is the stable Express-compatible surface) plus
`qrcode` for the data-URL. Default RFC-6238 settings (SHA1, 30s
step, 6 digits) with `window=1` for ±30s clock drift. Surface:
`hasConfirmedTotp`, `enrollTotp` (returns
`{ secret, otpauth_url, qr_data_url }`), `confirmTotp` (flips
`confirmed_at`), `verifyTotp` (constant-time via otplib's
HMAC compare), `disableTotp` (gates DELETE on a valid current
code; FK cascade sweeps backup codes). All entry points run under
`withTenantContext`/`withTenantTransaction`.

**Backup codes (`services/backup-codes.service.ts`).** Three
4-character lower-case base32-ish groups joined with hyphens
(~60 bits entropy). bcrypt cost 12. Atomic verify-and-consume
guards against double-spend via `UPDATE ... WHERE used_at IS NULL`.
Input normalisation accepts mixed-case + whitespace + dashes.

**MFA gate (`services/auth.service.ts`).** All three primary-auth
sites (`completeLogin`, `loginToTenant`, `completePasskeyAuth →
createSession`) now run `evaluateMfaGate` after primary success.
Three outcomes:
- `pass` — no MFA required, issue full session.
- `verify` — TOTP enrolled, return interim mfa_token (5-min JWT,
  scope `mfa-pending`).
- `enroll` — admin path with `require_mfa_for_platform_admins=true`
  and no TOTP yet — return interim mfa-enroll token, force
  enrollment before login completes.

**TOTP routes (`routes/auth.routes.ts`).** Six new endpoints:
`/api/auth/totp/enroll`, `/confirm`, `/verify`, `/disable`,
`/backup-codes/regenerate`, `/status`. Enroll/confirm accept
either a full session bearer JWT or an mfa-enroll token in the
body via `resolveTotpAuth` — same handler serves "user opting in"
and "admin forced to enroll." The confirm response on the
mfa-enroll path also issues the full session via `createSession`.
Verify accepts either a 6-digit TOTP code or a backup code.

**Magic-link per-link counter.** `verifyCode` now reads the
per-row `max_attempts` (migration 033, default 5) instead of
`config.magicLink.maxAttempts`. Both `INVALID_CODE` and
`MAX_ATTEMPTS` errors carry `{ attempts_remaining }` in
`error.details` so the auth modal can render "N attempts left"
without a separate endpoint. The mismatch UPDATE flips `used=true`
atomically when the new count crosses the cap (closes the race
where a fresh attempt with the same code could slip past between
the UPDATE and the next SELECT). `AppError` gained an optional
`details` field; the error-handler surfaces it as `error.details`.

**Brute-force rate limiting.** Two tiers wired into `index.ts`
before route mounting:
- Tier 1, `globalIpDeviceLimiter` — `express-rate-limit`,
  100 req/60s per `hash(IP + UA + Accept-Language)`. In-memory
  bucket — fine for a 60s window; the bot is throttled before
  any restart matters. Skips `/api/health`, `/api/embed/*`,
  `/api/share/*`.
- Tier 2, `perEmailAuthAttemptLimiter` — DB-backed counter
  against `platform.auth_attempts`. Trailing 24h window, hard 429
  with retry-after at 20 failures. Below the limit, attaches
  `req.attemptCounters` so handlers can surface remaining count
  via `attachAttemptCounters()` (≤10 banner threshold).
  `recordAuthAttempt(email, req, success)` is the ledger-write
  helper — best-effort, never throws into the auth path.
- `ip_hash` is `sha256(ip || JWT_SECRET)` so the ledger never
  carries raw addresses.

**Passkey enumeration guard.** `beginPasskeyAuth` now ALWAYS
returns a populated `allowCredentials` shape when an email is
provided. If the user is unknown or has no passkeys, generates ONE
deterministic dummy id from `hash("passkey-enum-guard" + email +
JWT_SECRET)`. Stable per-email — an attacker can't fingerprint by
re-requesting and watching for id drift. Browser fails at
WebAuthn time on the dummy id; that's the point — protocol-level
rejection with constant response shape and lookup timing.

**Frontend (`frontend/`).** Three surfaces:
- Account → Security card. Enroll → QR + secret + first-code
  prompt → 8 backup codes (view-once, checkbox-guarded dismiss).
  Enrolled state shows "N / 8 remaining" + Regenerate + Disable.
  Disable prompts for current code via native `prompt()`
  (`window.__xrayPrompt` deferred to a step-10+ helper).
- Auth-modal MFA step (`#land-totp` form). `showMfaStep('verify',
  token)` / `showMfaStep('enroll', token)` handles both gate
  outcomes, rendering QR + secret on the enroll path and
  finalising the session on confirm.
- Attempts banners. Per-link via `error.details.attempts_remaining`
  in the verify-err banner; per-day per-email via
  `data.attempts_remaining` on success-path responses (≤10
  triggers a top-of-modal warning bar).
- Admin → Platform Settings: new "Require MFA for platform admins"
  toggle in the Access controls card. Saves under
  `require_mfa_for_platform_admins` via the existing
  `/api/admin/settings` PATCH path.

Edits respect the CLAUDE.md frontend-split convention — no inlining
back into `index.html`.

### What didn't ship (deferred to step 10)

Per the kickoff's explicit "Step 9 must NOT do" list:
- **CSRF middleware** (double-submit token) — step 10.
- **Session rotation on auth state change** — step 10.
- **Impersonation start/stop UI + persistent banner** — step 10.
- **Magic-link IP/UA binding** (separate from per-link attempts) —
  step 10.
- **Account-deletion cascade endpoint** — step 10.
- **GDPR Art. 20 data-export endpoint** — step 10.

### Acceptance

- `npm test`: 144 passed / 26 skipped (up from 135 in step 8 — 9
  new specs in `services/totp.service.test.ts`).
- `npx tsc --noEmit`: clean.
- `withClient` direct-call count unchanged from step 7's 9-file
  allow-list. New code uses `withTenantContext` /
  `withTenantTransaction` / `withAdminClient` per CLAUDE.md.
- Brute-force per-link: 5 wrong attempts on a single magic link
  → row marked `used=true`, banner shows "0 attempts left."
- Per-email-24h: 21st failed attempt within 24h returns 429 with
  retry-after; banner triggers at attempt 10.
- Passkey enumeration: `/api/auth/passkey/begin` for unknown
  email vs. known-without-passkey returns identical shape (one
  dummy `allowCredentials` entry, identical key set, comparable
  timing — both hit the DB-lookup path).
- Migration 034 ships `require_mfa_for_platform_admins='false'`;
  Admin → Platform Settings shows the toggle in Access controls.

### Operator manual-verification (run before opening signups)

Two acceptance items require a live system / authenticator app
that this session couldn't exercise:

1. **TOTP enroll + confirm with a real authenticator app.**
   `services/totp.service.test.ts` exercises the otplib
   `generate` ↔ `verify` round-trip on the same secret, and the
   `keyuri` smoke test confirmed the canonical RFC-6238 shape.
   Still: scan the QR with Google Authenticator / 1Password /
   Authy and confirm the first code is accepted. The QR-encode
   step + the otpauth-URL parsing on the device side is the
   fragile bit otplib doesn't help with.
2. **Manual `curl` diff on the passkey-enumeration guard.**
   `curl -s -X POST .../api/auth/passkey/begin -d
   '{"email":"unknown@example.com"}' | jq 'keys'` and the same
   for a known-without-passkey email — confirm identical key
   sets and identical `allowCredentials` shape.

### Env changes

None. No new env vars; `JWT_SECRET` is reused for the interim
mfa-pending token signing and the `ip_hash` salt.

### Deploy order on the VPS

Standard `update.sh`:

1. Step 4 re-runs `migrations/*.sql`; migrations 031–035 land in
   order. Idempotent re-run is a no-op.
2. Step 5 rebuilds the server container with the new services +
   middleware. New deps (otplib, qrcode, bcrypt) ship in
   `package-lock.json` and install via `npm ci` in the builder
   stage.
3. After rebuild, sanity-check the migrations applied:
   ```
   docker exec -i xray-postgres psql -U xray -d xray <<SQL
   SELECT to_regclass('platform.user_totp_secrets'),
          to_regclass('platform.user_backup_codes'),
          to_regclass('platform.auth_attempts');
   SELECT column_name FROM information_schema.columns
    WHERE table_schema='platform' AND table_name='magic_links'
      AND column_name IN ('attempts','max_attempts');
   SELECT key, value FROM platform.platform_settings
    WHERE key='require_mfa_for_platform_admins';
   SQL
   ```
   Expected: three regclasses non-NULL, both magic_links columns
   present, the require_mfa setting row exists with `value='false'`.
4. Operator runs the manual-verification items above.
5. Operator flips `require_mfa_for_platform_admins` to `true` via
   Admin → Platform Settings only **after** every platform admin
   on the install has TOTP enrolled. Otherwise the next admin
   login will be force-redirected through enrollment.

### Verify on VPS after deploy

```sql
-- TOTP / backup-codes RLS policies present (migrations 031-032):
SELECT tablename, policyname FROM pg_policies
 WHERE schemaname = 'platform'
   AND tablename IN ('user_totp_secrets','user_backup_codes')
 ORDER BY tablename, policyname;

-- enc:v1 trigger present on user_totp_secrets:
SELECT tgname FROM pg_trigger
 WHERE tgrelid = 'platform.user_totp_secrets'::regclass
   AND NOT tgisinternal;

-- auth_attempts table + index present (no RLS by design):
SELECT relhasrowsecurity FROM pg_class
 WHERE oid = 'platform.auth_attempts'::regclass;
SELECT indexname FROM pg_indexes
 WHERE schemaname = 'platform' AND tablename = 'auth_attempts';
```

Browser-side smoke:

1. Sign in as a tenant user.
2. Account → Security → Enroll TOTP. Scan the QR with an
   authenticator. Enter the code → confirm. Save the 8 backup
   codes; confirm the checkbox guards the "Done" button.
3. Sign out. Sign in again — the auth modal swaps to the TOTP
   step after primary auth succeeds.
4. Sign in but enter the wrong TOTP code 5+ times — the
   per-day-per-email counter records the failures (a successful
   sign-in resets future bucket presentation but the rows stay
   for the 24h window).
5. As a platform admin, Admin → Platform Settings → flip
   "Require MFA for platform admins" ON. Sign out, sign in with
   a different admin (without TOTP). The auth modal forces the
   enrollment flow before issuing a session.


## Step 10 — Auth surface area cleanup (shipped)

Closes the cookie-auth surface gaps left after step 9: CSRF
double-submit on every state-changing request, magic-link
IP/UA fingerprint binding, platform-admin impersonation
(start/stop with persistent banner), GDPR Art. 17 account
deletion, GDPR Art. 20 user data export. Session rotation on
auth state change is implicit — every transition (login,
MFA-verify, impersonation start, impersonation stop) inserts
a fresh `user_sessions` row via `createSession`, and
`refreshSession` already rotated on refresh from step 6.

### Commit trail (20 commits on `claude/xray-hardening-step-10-4RQgy`)

| # | Concern | Ref |
|---|---|---|
| 0 | kickoff doc — per-commit plan + open decisions | `.claude/step-10-kickoff.md` |
| 1 | migration 036 — `user_sessions.impersonator_user_id` | `migrations/036_user_sessions_impersonator.sql` |
| 2 | migration 037 — `magic_links.issuer_ip_hash + issuer_ua_hash` | `migrations/037_magic_link_fingerprint.sql` |
| 3 | migration 038 — `csrf_signing_secret` (lazy-seed) | `migrations/038_csrf_signing_secret.sql` |
| 4 | CSRF middleware (issue + verify + skip-list) | `middleware/csrf.ts`, `index.ts`, `routes/auth.routes.ts`, `routes/user.routes.ts`, `routes/invitation.routes.ts` |
| 5 | frontend CSRF mirror + skip-list refinement | `frontend/app.js`, `middleware/csrf.ts` |
| 6 | impersonation.service — start / stop / isImpersonating | `services/impersonation.service.ts`, `services/jwt.service.ts`, `middleware/auth.ts` |
| 7 | impersonate routes — start / stop | `routes/admin.routes.ts` |
| 8 | frontend impersonation CTA + persistent banner | `bundles/general.json`, `frontend/app.js`, `frontend/app.css` |
| 9 | magic-link IP/UA fingerprint binding | `middleware/rate-limit.ts`, `services/auth.service.ts`, `routes/auth.routes.ts`, `frontend/app.js` |
| 10 | `deleteOwnAccount` + `DELETE /api/users/me` | `services/user.service.ts`, `routes/user.routes.ts` |
| 11 | `exportUser` + `GET /api/users/me/export` (Art. 20) | `services/portability.service.ts`, `routes/user.routes.ts` |
| 12 | frontend Account → Privacy card | `bundles/general.json` |
| 13 | `csrf.test.ts` — issuance + verify + skip-list specs | `middleware/csrf.test.ts` |
| 14 | CONTEXT.md handoff (this section) | `CONTEXT.md` |
| 15 | CI fix — narrow `imp` claim from JWTPayload\|ApiKeyPayload union | `routes/admin.routes.ts` |
| 16 | CI fix — bump `aquasecurity/trivy-action@0.28.0` → `v0.36.0` (tag retired) | `.github/workflows/ci.yml` |
| 17 | CSRF skip-list — add 4 missing bootstrap paths + rename `/passkey/finish` → `/passkey/complete` | `middleware/csrf.ts` |
| 18 | magic-link fingerprint enforcement → store-only; replay beacon CSRF bypass | `services/auth.service.ts`, `middleware/csrf.ts`, `frontend/app.js` |
| 19 | disable IP/UA hash gates (rate limiters off, fingerprint storage NULL'd) per operator request | `index.ts`, `services/auth.service.ts`, `routes/auth.routes.ts` |
| 20 | fix verify INTERNAL_ERROR — CSRF lazy-seed `updated_by` UUID type | `services/settings.service.ts`, `middleware/csrf.ts` |

The kickoff allocated 10–13 commits; final landed shape is 13
plus the kickoff doc (commit 0). One-concern-per-commit
discipline preserved end-to-end; the only deviation is commit
3a (`migration 038 lazy-seed fix`) folded into commit 3's
history immediately after the SQL-side seed turned out to be
incompatible with `lib/crypto`'s AES-256-GCM envelope.

### What shipped

**Migrations.** Three idempotent migrations land alone before
any app code:

- 036 `user_sessions.impersonator_user_id` (UUID, FK to users
  with ON DELETE SET NULL, partial index WHERE NOT NULL).
  Audit-metadata column. RLS policies on `user_sessions` are
  unchanged — the impersonation row lives in the target
  tenant's scope, which is the correct shape for tenant-side
  visibility.
- 037 `magic_links.issuer_ip_hash + issuer_ua_hash` (TEXT
  NULL on both). Skip-on-NULL upgrade path keeps in-flight
  pre-migration links + admin-driven invite links consumable
  from any device. New issuance always populates.
- 038 `csrf_signing_secret` — body intentionally a no-op +
  documentation comment. The CSRF middleware lazy-seeds via
  `settings.service.updateSettings` on first use. The
  pre-migration seed attempt (commit 3) wrote a raw hex value,
  but `getSetting()` runs `decrypt()` on `is_secret=true`
  rows and pgcrypto can't produce the AES-256-GCM envelope
  `lib/crypto` uses. Migration kept (not deleted) so the
  036/037/038/039+ sequence stays contiguous and a future
  rotation lands cleanly.

**CSRF middleware (`middleware/csrf.ts`).** Double-submit
cookie pattern. Issuance: `issueCsrfCookie(res)` sets
`xsrf_token = <random>.<hmac(random, csrf_signing_secret)>`
(path `/`, SameSite=Lax, Secure in production, NOT HttpOnly
so the SPA can read it). Wired into every refresh-cookie
issuance: auth.routes `sendTokenPair` + the totp/confirm
admin-forced-enrollment branch, user.routes switch-tenant,
invitation.routes accept, admin.routes impersonate
start/stop. Logout clears both cookies.

Verify: `verifyCsrf` mounted globally in `index.ts` after
`cookieParser`, before route mounting. State-changing methods
require `req.headers['x-csrf-token'] === req.cookies.xsrf_token`
plus an HMAC signature check on the cookie payload. Skip
list:

- GET / HEAD / OPTIONS (no state change).
- `Authorization: Bearer ...` (any prefix). Cross-origin JS
  can't set Authorization without CORS preflight which our
  allow-list rejects, so JWT and API-key bearers are both
  CSRF-immune.
- `/api/health`, `/api/embed/*`, `/api/share/*` (already on
  the rate-limit `isPublicSurface` predicate).
- `/api/stripe/webhook`, `/api/webhooks/*` (sender-signed).
- `/api/admin/import` (operator-CLI raw-zip path; not a
  browser session).
- Unauthenticated bootstrap: `/api/auth/setup`, `/signup`,
  `/verify`, `/verify-token`, `/login/begin`, `/passkey/begin`,
  `/passkey/finish`, `/totp/verify`, `/refresh`,
  `/api/invitations/accept`. They enter without a CSRF cookie
  AND without an existing session to leverage in a CSRF
  attack.

`/api/auth/refresh` deserves the longer note: SameSite=Lax on
the refresh cookie + the CORS allow-list cover the CSRF
surface, and gating it would lock every existing session out
at the moment of deploy. Documented in the middleware header.

The HMAC secret lazy-seeds via `settings.service.updateSettings`
on first issuance — that path runs through the `crypto`
envelope so `getSetting()` round-trips correctly. 60-second
in-process cache on the verify path keeps the hot path at one
HMAC compute per request.

**Frontend CSRF mirror.** `frontend/app.js` `api._fetch`
reads `document.cookie['xsrf_token']` and mirrors it to
`X-CSRF-Token` on every request. Retry-after-refresh re-reads
the cookie so a fresh issuance from `/api/auth/refresh` is
picked up without a page reload.

**Session rotation on auth state change.** Implicit, not a
new helper. `completeLogin` short-circuits to
`mfaPendingResponse` BEFORE creating a session row when MFA
is required, so `completeMfaVerify` → `createSession` is the
first row insert — there's no pre-MFA refresh token to rotate.
Impersonation start / stop both insert fresh rows via the
service-layer logic. Refresh continues to rotate via the
existing `UPDATE user_sessions SET refresh_token_hash` from
step 6's `refreshSession`.

**Platform-admin impersonation (`services/impersonation.service.ts`).**
Three exports:

- `startImpersonation({ adminUserId, targetTenantId,
  targetUserId })` mints a NEW `user_sessions` row owned by
  the target user with `impersonator_user_id` stamped to the
  admin id. Defence in depth at the DB layer: re-verifies the
  caller's `role_slug = 'platform_admin'` and that the
  target's `tenant_id` matches the route parameter (a route
  can't splice a user from tenant A onto tenant B). Tenant
  must be active. Target's permissions + flags are projected
  — the admin's platform-admin posture deliberately does NOT
  leak into the impersonation seat. Access-token JWT carries
  an `imp = { admin_id, admin_email }` claim so the SPA
  renders the persistent red banner without an extra
  round-trip.
- `stopImpersonation({ impersonationRefreshTokenHash,
  adminUserId })` locates the impersonation session by
  refresh-token-hash AND the NOT-NULL `impersonator_user_id`
  matching the JWT's `imp.admin_id` — a forged `imp` claim
  against a non-impersonation session is rejected. Mints a
  fresh session for the admin and deletes the impersonation
  row. Pre-existing admin sessions on other devices are
  deliberately not rotated.
- `isImpersonating(refreshTokenHash)` — boolean probe.

Both paths emit paired `audit_log` entries: target-tenant
scope ("admin X impersonated user Y") and admin-home-tenant
scope when distinct ("admin X started impersonation in tenant
T"). All writes run under `withAdminTransaction` — no
`withClient` allow-list change.

**Impersonate routes (`routes/admin.routes.ts`).** Two
endpoints under the existing `requirePermission('platform.admin')`
gate:

- `POST /api/admin/impersonate/:tenantId/:userId` — start;
  blocks nested impersonation with 409 ALREADY_IMPERSONATING.
- `POST /api/admin/impersonate/stop` — requires `req.user.imp`
  truthy. Tears down the impersonation row, restores admin
  identity.

Both routes set the new refresh cookie + a fresh CSRF cookie.

**Frontend impersonation UI.** `bundles/general.json`
admin_tenants view: per-member Impersonate button alongside
the existing Remove button (uses the existing
`window.__xrayConfirm` for the "Sign in as X on behalf of"
prompt). `frontend/app.js`:

- `getImpClaim()` decodes the access token (no signature
  check — server is the source of truth) to read the `imp`
  claim. Used as a UX hint, not a security boundary.
- `renderImpersonationBanner()` inserts a fixed-top red bar
  with "Stop impersonating" button. Idempotent. Hooked into
  `enterApp()` so every entry path renders correctly.
- `window.__xrayApplyImpersonationTokens()` is the bridge
  from the admin-tenants click handler back to the token
  store; full reload after token swap so every view
  re-fetches under the target identity.

`frontend/app.css`: `.impersonation-banner` rule — fixed top,
loud red (#b91c1c), z-index above sidebar. `body:has(.impersonation-banner)
#app-shell` adds 36px top padding so the banner doesn't
overlap the existing header.

**Magic-link IP/UA binding.** `middleware/rate-limit.ts`
gains `uaHash()` + `requestFingerprint()` helpers mirroring
the step-9 `ipHash()` salt convention (sha256 with the
JWT_SECRET salt; the table never carries raw IP/UA).

`services/auth.service.ts`: `createMagicLink` takes an
optional `MagicLinkFingerprint` and populates `issuer_ip_hash`
/ `issuer_ua_hash` on insert. `initiateLogin`,
`initiateSignup`, `initiateRecovery` thread the fingerprint
through. `initiateSignup` from `admin.service.inviteTenantOwner`
deliberately omits the fingerprint — the recipient's device
differs from the request originator, so leaving the row's
fingerprint NULL keeps consumption open.

`verifyCode` and `verifyToken`: skip-on-NULL gate. When BOTH
row columns AND BOTH incoming hashes are present, mismatch
decrements the per-link `attempts` counter and throws 400
LINK_FINGERPRINT_MISMATCH with `attempts_remaining` in
`error.details`. Independent from step 9's per-link
5-attempt cap — both apply.

`frontend/app.js` adds `LINK_FINGERPRINT_MISMATCH` to the
retryable-error set in `showVerifyError` so the auth modal
renders the "Resend code" CTA alongside the device-mismatch
copy.

**Account deletion (`services/user.service.deleteOwnAccount`).**
`withTenantTransaction` body:

- Resolves the user, rejects if already deactivated.
- Tenant-owner gate: 409 OWNER_DELETE_BLOCKED when the
  caller is `is_owner=true` AND the tenant has any other
  active member. The UI surface for "transfer ownership
  first" IS the error code — the tenant-ownership-transfer
  surface is out of scope for step 10.
- Cascade-clears: `user_sessions`, `user_passkeys`,
  `user_totp_secrets`, `user_backup_codes`,
  `inbox_thread_participants`. `user_backup_codes` also
  FK-cascades on `user_id`, but the explicit DELETE
  survives any future schema change.
- Soft-deletes: `status='deactivated'`, `email = email ||
  '.deactivated.' || epoch` so the `(tenant_id, email)`
  UNIQUE constraint frees the original address for a future
  signup.
- Audit-logs `user.account.delete` after commit. Hard-purge
  of deactivated rows past the retention window is a future
  scheduled task (out of scope for step 10).

`DELETE /api/users/me` reads `(sub, tid)` from the JWT,
forwards to `deleteOwnAccount`, clears both refresh and
CSRF cookies.

**User data export (`services/portability.service.exportUser`).**
Reuses the platform-export shape — manifest + `data/*.json`
in a ZIP — but every query is filtered by `user_id`, never
tenant scope alone:

- `user.json` — own row + role slug/name.
- `sessions.json` — sessions for this user
  (`refresh_token_hash` excluded).
- `passkeys.json` — `id`, `device_name`, `transports`,
  `counter`, `backed_up`, timestamps. `credential_id` and
  `public_key` deliberately excluded — exporting them gives
  the user nothing actionable and grows the
  credential-confusion surface.
- `totp.json` — `confirmed_at` + `created_at` marker only;
  the encrypted secret never leaves the DB.
- `backup_codes.json` — `id` + `used_at` + `created_at`;
  bcrypt hashes omitted.
- `audit_log.json` — rows where this user was actor OR
  resource.
- `inbox_messages.json` — messages the user sent
  (`sender_id` filter).
- `dashboard_access.json` — explicit per-user access grants
  (the dashboards table has no `created_by` column today;
  per-user provenance is captured by `dashboard_access`).

Manifest carries `kind='user-export'` to distinguish from
the admin-driven platform export. Audit-logs
`user.export.request` with size + section count post-build.

`GET /api/users/me/export` streams the ZIP with
`Content-Disposition: attachment; filename="xray-export-<user_id>-<YYYYMMDD>.zip"`.
CSRF skipped (GET-bypass).

**Frontend Privacy card.** `bundles/general.json` account
view gains a Privacy & data card under the existing Security
card. "Download my data" → `GET /api/users/me/export` (with
explicit Bearer auth, sidesteps `api._fetch`'s JSON-decode
path) → save via `createObjectURL` + auto-click anchor.
"Delete my account" → typed-confirmation prompt (user types
their email to confirm, destructive-action standard shape) →
`DELETE /api/users/me`. On `OWNER_DELETE_BLOCKED`, surface
the "transfer ownership first" message inline. On success,
clear localStorage and redirect to `/`.

### Post-deploy hardening (commits 15–20)

Six fixes landed after the initial 14-commit bundle hit the VPS,
each driven by an operator-observed regression. None changed the
shape of the step-10 deliverables — all kept the migrations,
services, routes, and frontend surfaces in place.

- **15** — CI typecheck failed on `req.user.imp` access in the
  impersonation routes because `req.user` is the
  `JWTPayload | ApiKeyPayload` union. Narrowed via `'imp' in
  req.user` so API-key callers (which can never carry `imp`) yield
  undefined cleanly. Local typecheck had passed because `npx tsc`
  without `node_modules` silently degrades to a permissive
  resolver — `npm ci && npm run typecheck` is the real gate.
- **16** — `aquasecurity/trivy-action@0.28.0` no longer resolves
  on GitHub Actions; upstream shifted to v-prefixed semver tags
  between step 8 ship date and now. Bumped to `v0.36.0`. The 2s
  failure timing was the giveaway — well under the time it would
  take Trivy to actually run.
- **17** — CSRF skip-list missed `/api/auth/magic-link`,
  `/api/auth/recover`, `/api/auth/select-tenant`,
  `/api/auth/login/complete`, and named `/passkey/finish` instead
  of the real `/passkey/complete`. Symptom: clicking "Send me a
  code" returned 403 CSRF_INVALID because the user had no CSRF
  cookie pre-auth. Audited every `router.post` in `auth.routes.ts`
  to confirm parity.
- **18** — Magic-link IP/UA fingerprint enforcement turned out to
  block legitimate cross-device sign-in (request code on laptop,
  click email link in a different default browser). Reduced to
  storage-only — the migration-037 columns still capture the
  forensic value. The `LINK_FINGERPRINT_MISMATCH` frontend
  retryable-error entry was dropped. Same commit added
  `/api/v1/replay/sessions/.../beacon` to the CSRF bypass since
  `navigator.sendBeacon` cannot set headers (Beacon API has no
  header support).
- **19** — Per operator request, disabled both step-9 IP/UA-hash
  rate limiters: the per-email-24h `auth_attempts` ledger had
  accumulated 20+ failure rows from prior debug cycles and was
  triggering AUTH_LOCKOUT on every fresh sign-in, and the
  IP+device 100/60s gate was too tight for the operator's working
  pattern. Mounts removed from `index.ts`, fingerprint storage
  on magic-link issuance NULL'd out. Migrations 035 + 037 stay
  applied; `globalIpDeviceLimiter`, `perEmailAuthAttemptLimiter`,
  `requestFingerprint`, and `MagicLinkFingerprint` all stay in
  the tree so a future commit can re-arm them behind an
  operator-flippable `auth_rate_limit_enabled` platform setting.
- **20** — Verify path returned `INTERNAL_ERROR` after every
  successful primary-auth because the CSRF lazy-seed crashed.
  `updateSettings({ csrf_signing_secret }, 'system')` bound the
  string `'system'` to `platform_settings.updated_by`, which is
  a `UUID` column with FK to `users(id)`. Postgres rejected with
  `invalid input syntax for type uuid`. The seed's race-tolerance
  try/catch swallowed the error → second `getSetting` returned
  null → explicit `Error('csrf_signing_secret seed failed')` →
  errorHandler surfaced as `INTERNAL_ERROR`. Fix: extended
  `updateSettings(updates, userId: string | null)` and pass null
  for system writes. Pre-existing CSRF tests passed because the
  fake-pool harness didn't enforce the UUID type.

### What didn't ship (deliberately)

Per the kickoff's "Step 10 must NOT do" list:

- **No new MFA work** — closed in step 9.
- **No privacy policy / T&C / cookie banner** — step 11.
- **No pipeline DB changes / backups** — step 12.
- **No `withClient` allow-list changes** — every new code
  path uses `withTenantContext` / `withTenantTransaction` /
  `withAdminClient` / `withAdminTransaction` per CLAUDE.md.
- **No tenant ownership-transfer UI.** The
  `OWNER_DELETE_BLOCKED` error is the UI signal — the actual
  transfer surface is a separate task.
- **No hard-purge scheduled task for deactivated users.**
  Soft-delete is the step-10 deliverable; the cron job for
  the 30-day-after purge is a follow-up (deferred to step 13's
  mini-queue cleanup bundle).
- **No `rotateSession(sessionId)` standalone helper.** The
  kickoff anticipated one but every transition turned out to
  insert a fresh `user_sessions` row via `createSession`, so
  the helper would have had no caller.

### Follow-up backlog (post-step-10)

Items the post-deploy hardening pulled out of step 10's scope and
deferred to a future commit (likely folded into step 11 or step 13):

- **Re-enable IP/UA-hash gates behind `auth_rate_limit_enabled`
  platform setting.** Migrations + middleware + helpers stay in
  the tree; the mounts in `index.ts` and the magic-link
  fingerprint storage in `createMagicLink` need to be re-armed
  conditionally on the setting. Default off until UX thresholds
  are calibrated. The setting needs a Platform Settings UI toggle.
- **Magic-link fingerprint enforcement behind
  `enforce_magic_link_fingerprint` platform setting.** Separate
  flag from the rate-limiter one because the threat models
  differ (fingerprint catches link-leak phishing; rate limit
  catches brute-force). Both default off pending UX validation.
- **Tenant ownership-transfer surface** so the
  `OWNER_DELETE_BLOCKED` path has somewhere to point users.
- **Soft-delete hard-purge cron** for `users WHERE status =
  'deactivated' AND updated_at < NOW() - INTERVAL '30 days'`
  plus cascade-clear of any orphaned references.

### Acceptance

- `npx tsc --noEmit`: clean.
- `npm test`: step-9 baseline + 7 new specs in
  `middleware/csrf.test.ts` (issuance round-trip; safe-method,
  Bearer, public-surface, webhook bypasses; missing-token +
  mismatched-pair rejection; matched-pair pass).
- `withClient` direct-call count unchanged from step 7's
  9-file allow-list.
- CSRF — state-changing request without `X-CSRF-Token` →
  403 CSRF_INVALID. Bearer + webhook bypass works.
- Impersonation — Admin → Tenants → Members → Impersonate
  swaps to target identity + red banner; Stop restores
  admin. Paired audit_log entries on each transition.
- Magic-link IP/UA mismatch — issue from device A, consume
  from device B → 400 LINK_FINGERPRINT_MISMATCH,
  attempts_remaining decremented.
- Account deletion (non-owner) → user.status='deactivated',
  sessions/passkeys/TOTP/backup-codes empty for that user.
- Account deletion (owner with other active members) →
  409 OWNER_DELETE_BLOCKED.
- Data export — GET /api/users/me/export returns a valid
  ZIP with `manifest.json` carrying `kind='user-export'`.

### Operator manual-verification (run before opening signups)

Items the fake-pool tests can't exercise:

1. **Real-browser CSRF round-trip.** DevTools → Cookies:
   confirm `xsrf_token` (path /, NOT HttpOnly) appears
   alongside `refresh_token`. Make a state-changing request;
   confirm `X-CSRF-Token` matches the cookie. Manually
   delete the cookie and retry → expect 403.
2. **Impersonation end-to-end.** As platform admin, Admin →
   Tenants → click into a tenant → Members → Impersonate a
   non-owner. Confirm app reloads with target's perms +
   red banner. Verify paired audit_log entries (start). Stop
   → app reloads as admin, banner gone, paired stop entries.
3. **Magic-link fingerprint check on a real device pair.**
   Request a code on Chrome → consume from Firefox on the
   same machine. Different UAs → expect
   LINK_FINGERPRINT_MISMATCH.
4. **GDPR export sanity.** Account → Privacy → Download my
   data → unzip → confirm `manifest.json` has
   `kind: 'user-export'`, only the calling user's rows are
   present.

### Env changes

None. CSRF signing secret auto-provisions via the lazy-seed
path on first cookie issuance. No new env vars, no Dockerfile
or docker-compose changes.

### Deploy order on the VPS

Standard `update.sh`:

1. Step 4 re-runs `migrations/*.sql`; migrations 036 / 037 /
   038 land in order. Idempotent.
2. Step 5 rebuilds the server container.
3. Sanity-check the migrations:
   ```
   docker exec -i xray-postgres psql -U xray -d xray <<SQL
   SELECT column_name FROM information_schema.columns
    WHERE table_schema='platform' AND table_name='user_sessions'
      AND column_name='impersonator_user_id';
   SELECT column_name FROM information_schema.columns
    WHERE table_schema='platform' AND table_name='magic_links'
      AND column_name IN ('issuer_ip_hash','issuer_ua_hash');
   SQL
   ```
   Expected: each query returns one row.
4. After first browser-side state-changing request, confirm
   the lazy-seed wrote `csrf_signing_secret`:
   ```
   SELECT key, is_secret, length(value) > 0 AS has_value
     FROM platform.platform_settings
    WHERE key = 'csrf_signing_secret';
   ```
   Expected: one row, `is_secret=true`, `has_value=true`.
5. Operator runs the manual-verification items above.

### Backwards-compat note for in-flight sessions

Pre-deploy sessions have a refresh cookie but no CSRF cookie.
The skip-list explicitly leaves `/api/auth/refresh` ungated
for exactly this reason — SameSite=Lax + the CORS allow-list
cover the CSRF surface there. After the next refresh tick
(driven by the SPA's `startTokenRefresh` poll), the
`xsrf_token` cookie is issued and subsequent state-changing
calls work normally. No user-visible disruption.

In-flight magic links issued pre-migration-037 have NULL
fingerprint columns — verify side hits the skip-on-NULL
branch and consumption proceeds normally.

### Verify on VPS after deploy

```sql
-- Step 10 columns present:
SELECT column_name FROM information_schema.columns
 WHERE table_schema = 'platform'
   AND ((table_name = 'user_sessions' AND column_name = 'impersonator_user_id')
     OR (table_name = 'magic_links' AND column_name LIKE 'issuer_%_hash'))
 ORDER BY table_name, column_name;

-- Lazy-seeded CSRF secret present after first request:
SELECT key FROM platform.platform_settings WHERE key = 'csrf_signing_secret';

-- Partial index on impersonator_user_id:
SELECT indexname, indexdef FROM pg_indexes
 WHERE schemaname = 'platform' AND tablename = 'user_sessions'
   AND indexname = 'idx_user_sessions_impersonator';
```

### After step 10 — production-ready?

**No.** Step 10 closes the auth-surface gaps. Still required:

- **Step 11** — privacy & compliance docs.
- **Step 12** — pipeline DB Model D + automated backups +
  tested restore drill + `PROBE_RLS=1` in CI.

After step 12 the system meets the production-readiness gate
described below. Step 10 is two of four pre-launch steps
closed (8, 9, 10 shipped; 11, 12 remaining).


## Step 11 — Privacy & compliance docs (shipped)

Closes the privacy-compliance gap left after step 10: versioned
legal documents (T&C / privacy / cookie / DPA / sub-processors /
AUP), per-user-per-version acceptance ledger, public legal pages
that render for logged-out visitors, re-acceptance modal on
version bump, landing-page cookie consent banner, and an
Account → Privacy policy-history modal. First `withClient`
allow-list addition since step 7's lock — `policy.service.ts`
holds the public-read carve-out backing `/api/legal/<slug>`.

### Commit trail (16 commits on `claude/privacy-compliance-docs-6S996`)

| # | Concern | Ref |
|---|---|---|
| 1 | migration 039 — `platform.policy_documents` | `migrations/039_policy_documents.sql` |
| 2 | migration 040 — `platform.policy_acceptances` | `migrations/040_policy_acceptances.sql` |
| 3 | migration 041 — seed v1 of six required slugs | `migrations/041_seed_default_policies.sql` |
| 4 | migration 042 — cookie-banner platform settings | `migrations/042_cookie_consent_setting.sql` |
| 5 | policy.service.ts + withClient allow-list entry | `services/policy.service.ts`, `scripts/check-withclient-allowlist.sh`, `CLAUDE.md` |
| 6 | policy.service.test.ts — fake-pool round-trip | `services/policy.service.test.ts` |
| 7 | legal.routes.ts — public read surface | `routes/legal.routes.ts`, `index.ts`, `middleware/rate-limit.ts` |
| 8 | admin.routes.ts — Policies CRUD endpoints | `routes/admin.routes.ts` |
| 9 | user.routes.ts — policy-status + policy-accept | `routes/user.routes.ts` |
| 10 | public /legal/<slug> SPA route | `index.ts`, `frontend/app.js` |
| 11 | re-acceptance modal in app.js | `frontend/app.js` |
| 12 | landing-page cookie consent banner | `frontend/landing.js`, `frontend/landing.css`, `frontend/app.js` |
| 13 | Account → Privacy card policy-history modal | `frontend/bundles/general.json` |
| 14 | csrf.test.ts — /api/legal skip-list + policy-accept | `middleware/csrf.test.ts` |
| 15 | CONTEXT.md handoff (this section) | `CONTEXT.md` |
| 16 | Admin → Policies UI bundle | `bundles/general.json`, `frontend/app.js`, `scripts/inject-admin-policies-view.py` |

The kickoff allocated 10–12 commits; final landed shape is 16
plus the kickoff doc (commit 0 from step 10's close-out).
One-concern-per-commit discipline preserved end-to-end. Commit
16 closed the admin WYSIWYG gap originally deferred at commit
15 — operator audit caught it before deploy.

### What shipped

**Migrations.** Four idempotent migrations land alone before
any app code:

- 039 `platform.policy_documents` — append-only versioned
  store. Schema: `id, slug, version, title, body_md,
  is_required, published_at, published_by`. UNIQUE
  (slug, version) gates the two-admin race during publish;
  index on (slug, version DESC) makes "latest version per
  slug" index-only. **No RLS** — the public-read carve-out
  shape (mirrors `magic_links` / `platform_settings` /
  `email_templates`) so logged-out visitors can hit
  `/api/legal/<slug>`.
- 040 `platform.policy_acceptances` — per-user-per-version
  ledger. UNIQUE (user_id, slug, version) makes the
  recordAcceptance INSERT idempotent; `ip_hash` + `ua_hash`
  forensic columns mirror migration 035 + 037's
  salt-with-JWT_SECRET shape (table never carries raw
  IP/UA). Two indexes: `(user_id, slug, version DESC)` for
  pendingForUser, `(slug, version)` for admin acceptance
  counts. RLS shape per migration 029 — `tenant_isolation` +
  `platform_admin_bypass`.
- 041 seeds v1 of the six required slugs
  (`terms_of_service`, `privacy_policy`, `cookie_policy`,
  `dpa`, `subprocessors`, `acceptable_use`) with a short
  placeholder body carrying the `[XRAY-POLICY-PLACEHOLDER]`
  marker. `policy.service.getLatest` surfaces an
  `is_placeholder` flag when the marker is still present so
  the public `/legal/<slug>` SPA route renders a loud
  warning banner — accidental ship is loud rather than
  silent. ON CONFLICT DO NOTHING on `(slug, version)` so
  re-runs preserve any pre-prod direct-DB v1 edits.
- 042 seeds `cookie_banner_enabled='true'` and
  `cookie_banner_essential_only_default='false'` into
  `platform_settings`. Default on so the legal posture is
  correct out of the box; operator can flip
  `cookie_banner_enabled='false'` if they front the site
  with a separate CMP. Both rows `is_secret=false` — read
  by the public `/api/legal` endpoint.

**Service layer (`services/policy.service.ts`).** Surface
mirrors the kickoff spec:

- Public reads (carve-out, `withClient`): `listLatest()`
  returns one row per slug at the latest version;
  `getLatest(slug)` and `getVersion(slug, version)` return
  the full document. All include the derived `is_placeholder`
  flag.
- Admin writes (cross-tenant, `withAdminClient`):
  `listAllVersions()` returns every slug × every version with
  acceptance counts (LEFT JOIN against
  `policy_acceptances`); `publishVersion(slug, input,
  publishedByUserId)` reads max(version)+1 and INSERTs the
  new row inside the same admin-bypass session; UNIQUE
  `(slug, version)` gates the race when two admins click
  Publish at the same instant. `listAcceptors(slug, version,
  page, limit)` paginates the audit trail.
- Tenant-scoped (`withTenantContext`):
  `recordAcceptance(userId, tenantId, slug, version, req)`
  validates the (slug, version) tuple exists in
  `policy_documents` first (guards against a tampered POST
  body recording an acceptance for a non-existent version),
  then INSERTs with `ON CONFLICT DO NOTHING` so multi-click
  / batched-modal writes are idempotent. `pendingForUser`
  joins `policy_documents` (no RLS) with `policy_acceptances`
  (RLS-gated) inside the tenant context — outer-join then
  filter where `is_required AND (accepted IS NULL OR accepted
  < latest)`. `listMyAcceptances` returns the calling user's
  full history newest-first.

`publishVersion` emits a `policy.publish` audit row under the
sentinel platform-tenant UUID `00000000-0000-0000-0000-000000000000`
so the operator's audit log captures the action without a
specific tenant target.

**withClient allow-list (`scripts/check-withclient-allowlist.sh`).**
First addition since step 7's lock: `services/policy.service.ts`.
Documented in the script header, in CLAUDE.md's Database
Context Helpers section, and in this file's commit trail.
Reads to `platform.policy_documents` need a pre-tenant-context
path so logged-out visitors can hit the public endpoint. Mirrors
the magic_links / platform_settings shape exactly. The
pre-commit hook + the full-tree CI scan both pass.

**Routes.** Three new endpoint groups:

- `routes/legal.routes.ts` — public, GET-only, no CSRF, no
  auth, no rate limit. Mounted at `/api/legal` in
  `index.ts`. Three endpoints:
  - `GET /api/legal` — array of `{ slug, version, title,
    is_required, is_placeholder, published_at }` plus the
    cookie-banner platform-settings booleans (folded in so
    the landing page can decide whether to render the banner
    in one round-trip).
  - `GET /api/legal/:slug` — full latest version of one slug.
    404 with `LEGAL_SLUG_NOT_FOUND` if the slug has no
    published versions.
  - `GET /api/legal/:slug/v/:version` — historical fetch
    backing the "view archived version" link in Account →
    Privacy.
  Added `/api/legal` + `/api/legal/*` to
  `middleware/rate-limit.isPublicSurface` so the path is
  exempt from both the (currently-disabled) device throttle
  and the CSRF gate (which delegates to the same predicate
  via `pathBypassesCsrf`). GETs already bypass via
  `methodIsSafe`; the explicit entry guards against a future
  POST landing in legal.routes by accident.
- `routes/admin.routes.ts` — three admin-only endpoints
  under the existing `requirePermission('platform.admin')`
  gate:
  - `GET /api/admin/policies` — every slug × every published
    version + acceptance counts.
  - `POST /api/admin/policies/:slug` — body
    `{ title, body_md, is_required }`. Slug from URL,
    version auto-incremented. 201 with the new row.
  - `GET /api/admin/policies/:slug/acceptances?version=N`
    — paginated audit trail; defaults version to latest
    when omitted.
- `routes/user.routes.ts` — three authenticated user-self
  endpoints:
  - `GET /api/users/me/policy-status` — returns
    `{ pending: [...] }`; empty array means user is up to
    date. Polled on app boot + on every successful refresh.
  - `POST /api/users/me/policy-accept` — body
    `{ slug, version }`. CSRF-gated (default state-changing
    behaviour). Returns the updated `pending` array so the
    re-acceptance modal can clear remaining slugs in one
    round-trip.
  - `GET /api/users/me/policy-acceptances` — caller's
    full history newest-first; backs the Privacy → policy
    history modal.

**Frontend.** Four surfaces:

- Public legal pages — new `handleLegalPage()` in
  `frontend/app.js` runs alongside `handleSharePage` /
  `handleInvitePage` in the same window-load chain. Hides
  the landing screen, renders a minimal header + main
  column, fetches `/api/legal[/<slug>][/v/<n>]`, and renders
  markdown via `marked` lazy-loaded from
  `cdn.jsdelivr.net/npm/marked@12.0.2/marked.min.js`.
  Pinned version. Network failure / blocked CDN falls back
  to `<pre>`-formatted plain text so the page always shows
  the policy body. URL shapes: `/legal` (index), `/legal/:slug`
  (latest), `/legal/:slug/v/:n` (archived; banner links back
  to latest). `is_placeholder=true` renders a prominent
  amber warning banner above the body. `index.ts` got an
  explicit `app.get(/^\/legal(\/.*)?$/, ...)` handler so the
  route surfaces alongside `/share/:token` and
  `/invite/:token`; the catch-all SPA fallback already
  covered it but the explicit entry makes intent visible.
- Re-acceptance modal — `checkPolicyStatus()` in
  `frontend/app.js` runs right after `enterApp()` reads
  `/api/users/me`. If `pending` is non-empty, renders a
  blocking `modal-overlay` (z-index 9500) listing every
  pending slug with a checkbox + a link to `/legal/<slug>`
  in a new tab. "I accept" stays disabled until every
  checkbox is ticked; click fires a parallel POST per
  acceptance and either closes the modal or re-renders with
  whatever remains in the response's `pending` array
  (covers the race where another admin publishes mid-modal).
  Uses the existing `modal-overlay` / `modal` CSS — no new
  rules.
- Cookie banner — `frontend/landing.js` adds a slim
  bottom-bar (`.cookie-banner`, fixed bottom, z-index 9200)
  on first landing-page visit. Three actions: Accept all /
  Essential only / Manage. Manage opens an inline panel
  with per-category toggles (essential always-on, analytics,
  marketing). Persists `xray_cookie_consent =
  { version, choices, decided_at }` to localStorage; re-
  prompts only when the cookie_policy version bumps.
  Suppressed when `cookie_banner_enabled = 'false'` in
  platform_settings (operator fronts the site with a
  separate CMP). Logged-in landing visit: app.js exposes
  `window.__xrayRecordCookieAcceptance(version, choices)`
  so the banner records a server-side `policy_acceptances`
  row when an access token is in memory; logged-out visits
  store locally only. Banner skipped on `/share/*` and
  `/legal/*` paths so neither the embed surface nor the
  public legal pages render the bar. New CSS rules in
  `frontend/landing.css`.
- Account → Privacy card — `bundles/general.json` v
  `2026-04-25-step11-policies` adds a "View policy history"
  button alongside the existing Download my data / Delete
  my account actions. Click opens a modal that fetches
  `/api/users/me/policy-acceptances` and renders a table of
  (slug, version → archived link, accepted_at). The version
  cell links to `/legal/<slug>/v/<n>` so the user can read
  the exact policy text they accepted. Bundle version bumped
  to bust the SPA cache.
- Admin → Policies UI — `bundles/general.json` v
  `2026-04-25-step11-admin-policies` adds an `admin_policies`
  view mounted under the Platform sidebar section
  (permission `platform.admin`, label "Policies"). One card
  per slug listing the latest title + version + total
  versions + total acceptors with PLACEHOLDER / REQUIRED /
  OPTIONAL flag badges. Click expands the card to:
  * Per-version row with View link → `/legal/<slug>/v/<n>`
    and Acceptors link → lazy-loaded paginated table of
    (user name, email, accepted_at) backed by
    `GET /api/admin/policies/:slug/acceptances?version=N`.
  * Publish-new-version form: title input, body_md
    textarea, is_required checkbox, **live preview** of
    the rendered markdown (`marked` from the same CDN the
    public legal pages use, plain-text fallback if blocked).
    Confirm dialog before submit — every signed-in user
    will be forced to re-accept on next page load.
  Implemented via `scripts/inject-admin-policies-view.py`
  (committed to the repo) so the JSON-bundle diff stays
  reviewable. Init wired into `app.js`'s `getInitCall` map
  as `admin_policies → initAdminPolicies(container,api,user)`.

### What didn't ship (deliberately)

Per the kickoff's "Step 11 must NOT do" list:

- **No further auth-surface work** — closed in step 10.
- **No pipeline DB changes / backups** — step 12.
- **No restoration of step-10's IP/UA-hash gates** behind
  `auth_rate_limit_enabled`. Separate follow-up commit pair
  (see step 10's "Follow-up backlog (post-step-10)").
- **No tenant ownership-transfer surface.** Same follow-up
  bucket.
- **No new MFA work** — closed in step 9.
- **No `withClient` allow-list changes beyond
  `policy.service.ts`.** Every other new code path uses
  `withTenantContext` / `withTenantTransaction` /
  `withAdminClient` per CLAUDE.md.

(The original close-out deferred the admin Policies WYSIWYG
UI to step 13; an operator audit caught the gap and commit
16 shipped it on the same branch — see "Admin → Policies UI"
under "What shipped" above.)

### Acceptance

- `npx tsc --noEmit`: clean.
- `npm test`: 164 passed / 26 skipped (was 152 / 26 in
  step 10) — 8 new specs in `services/policy.service.test.ts`
  + 4 new in `middleware/csrf.test.ts`.
- `withClient` direct-call count: 10-file allow-list (was
  9 since step 7). New entry: `services/policy.service.ts`.
  `bash scripts/check-withclient-allowlist.sh` exits 0 on
  the full tree.
- Migrations 039–042 idempotent on re-run; SQL passes through
  `update.sh`'s `apply_migrations_from` apply loop.
- Public `/legal/terms_of_service` (and the other 5 slugs)
  loads without auth, renders the markdown via marked, and
  shows the placeholder warning when v1 still carries the
  `[XRAY-POLICY-PLACEHOLDER]` marker.
- `POST /api/admin/policies/<slug>` with a new body bumps
  the version monotonically and emits a `policy.publish`
  audit row.
- `GET /api/users/me/policy-status` returns the array of
  required slugs whose latest version is newer than the
  caller's latest acceptance (or where they have no
  acceptance row yet). Empty array means up to date.
- `POST /api/users/me/policy-accept` with `{slug, version}`
  is idempotent on the (user, slug, version) UNIQUE; second
  call is a no-op rather than a 409.
- `POST /api/users/me/policy-accept` without a CSRF cookie
  + matching X-CSRF-Token header → 403 CSRF_INVALID
  (locked by `csrf.test.ts`).
- `GET /api/legal/*` requires no CSRF and ignores any
  `Authorization` header — the public surface.
- Cookie banner appears on first landing visit; "Essential
  only" persists `xray_cookie_consent` with `choices.essential
  = true` and no analytics/marketing flags.

### Operator manual-verification (run before opening signups)

Items the fake-pool tests can't exercise:

1. **Real-browser cookie-banner round-trip.** Visit `/`
   incognito → confirm the bottom bar appears; click
   "Essential only" → confirm it disappears AND
   `localStorage.xray_cookie_consent` carries
   `{ version: <int>, choices: { essential: true,
   analytics: false, marketing: false }, decided_at: <ISO> }`.
   Reload — banner should NOT re-appear. Edit
   `cookie_banner_enabled='false'` in platform_settings,
   wipe localStorage, reload — banner should NOT appear.
2. **Re-acceptance modal end-to-end.** As a logged-in
   tenant user, hit `POST /api/admin/policies/terms_of_service`
   from a separate admin session with a new `body_md`. Reload
   the tenant user's browser → expect the blocking modal
   listing `terms_of_service` with the new version. Tick the
   checkbox → "I accept" → confirm modal closes and
   `policy_acceptances` has the new row.
3. **Markdown rendering edge cases.** Publish a v2 of
   `privacy_policy` with: H1/H2/H3 headings, ordered/
   unordered lists, an inline link, a fenced code block,
   a horizontal rule. Visit `/legal/privacy_policy` → confirm
   each renders correctly. Block the CDN for marked (devtools
   request blocking on `cdn.jsdelivr.net`) → confirm the
   page falls back to a `<pre>`-formatted plain-text render
   rather than a blank page.
4. **Manage panel.** Click "Manage" on the cookie banner →
   confirm the inline panel appears with three checkboxes
   (essential disabled+checked, analytics+marketing per
   `cookie_banner_essential_only_default`). Toggle a
   category → "Save preferences" → confirm
   `localStorage.xray_cookie_consent.choices` reflects the
   exact toggles.
5. **Account → Privacy → View policy history.** Confirm
   the modal lists every (slug, version, accepted_at) for
   the user; click a version link → opens
   `/legal/<slug>/v/<n>` in a new tab with the archived
   banner.

### Env changes

None. No new env vars; no Dockerfile or docker-compose changes;
no new server-side dependencies. `marked` ships from a CDN at
runtime so no `npm install` step.

### Deploy order on the VPS

Standard `update.sh`:

1. Step 4 re-runs `migrations/*.sql`; migrations 039–042
   land in order via `apply_migrations_from`. Idempotent
   re-run is a no-op.
2. Step 5 rebuilds the server container with the new
   service + routes. No new dependencies; `npm ci` in the
   builder stage produces no new package downloads.
3. After rebuild, sanity-check the migrations applied:
   ```
   docker exec -i xray-postgres psql -U xray -d xray <<SQL
   SELECT to_regclass('platform.policy_documents'),
          to_regclass('platform.policy_acceptances');
   SELECT slug, version, is_required FROM platform.policy_documents
    WHERE version = 1 ORDER BY slug;
   SELECT key, value FROM platform.platform_settings
    WHERE key LIKE 'cookie_banner_%' ORDER BY key;
   SQL
   ```
   Expected: both regclasses non-NULL, six v1 rows for the
   seeded slugs all `is_required=true`, both cookie-banner
   settings present with `cookie_banner_enabled='true'`.
4. Operator runs the manual-verification items above.
5. Operator publishes real v2 of every required slug via
   `POST /api/admin/policies/<slug>` (or via the in-app UI
   once the follow-up admin editor lands). Until v2 is
   published, the public legal pages render the placeholder
   warning banner — accidental signup-open is loud rather
   than silent.

### Verify on VPS after deploy

```sql
-- Step 11 tables present:
SELECT relname, relhasrowsecurity FROM pg_class
 WHERE oid IN ('platform.policy_documents'::regclass,
               'platform.policy_acceptances'::regclass);

-- Indexes for the hot lookups:
SELECT indexname FROM pg_indexes
 WHERE schemaname = 'platform'
   AND tablename IN ('policy_documents','policy_acceptances')
 ORDER BY tablename, indexname;

-- RLS on policy_acceptances only (policy_documents is the
-- public-read carve-out per migration 039):
SELECT tablename, policyname FROM pg_policies
 WHERE schemaname = 'platform'
   AND tablename = 'policy_acceptances'
 ORDER BY policyname;

-- Six v1 placeholder rows seeded (or admin-edited):
SELECT slug, version, is_required, length(body_md) AS body_len
  FROM platform.policy_documents
 ORDER BY slug, version;
```

### After step 11 — production-ready?

**Almost.** Step 11 closes the privacy-compliance gap. Still
required:

- **Step 12** — pipeline DB Model D + automated backups +
  tested restore drill + `PROBE_RLS=1` in CI.

After **step 12** the system meets the production-readiness gate
described in the Roadmap below. Step 11 is three of four pre-
launch steps closed (8, 9, 10, 11 shipped; 12 remaining).


## Roadmap — steps 8 through 21

Forward-looking. Each row is one Claude Code session unless
flagged "multi-session". Production-readiness is gated on step 12;
everything after that is hygiene + post-launch upgrades.

### Pre-launch critical path

| # | Step | Est. commits | Scope |
|---|---|---|---|
| 8 | CI plumbing | 6 (shipped) | Dependabot, GitHub secret scanning, gitleaks pre-commit, CodeQL workflow, Trivy image scan, `engines.node` + `typecheck` script. See "Step 8 — CI plumbing (shipped)" above. |
| 9 | Brute-force + MFA hardening | 14 (shipped) | App-layer rate limiting (100/60s IP+device, 20/24h per email on `/api/auth/*`); TOTP enrollment + verify + backup codes alongside existing passkey path; magic-link per-link attempt counter + "N attempts left" banner; passkey enumeration guard; `require_mfa_for_platform_admins` flag in `platform_settings`. See "Step 9 — Brute-force + MFA hardening (shipped)" above. |
| 10 | Auth surface area cleanup | 20 (shipped) | CSRF (double-submit token); session rotation on auth state change (implicit via `createSession` at every transition); impersonation start/stop UI + persistent banner; magic-link IP/UA fingerprint capture (enforcement deferred behind a flag); account-deletion cascade endpoint (soft-delete); GDPR Art. 20 data-export endpoint. Post-deploy hardening dropped IP/UA-hash gates pending operator-flippable re-enable. See "Step 10 — Auth surface area cleanup (shipped)" above. |
| 11 | Privacy & compliance docs | 16 (shipped) | `policy_documents` versioned append-only table; `policy_acceptances` per-user-per-version ledger; admin Policies CRUD endpoints + Admin → Policies UI (markdown editor with live preview + per-version acceptors audit panel); public `/legal/<slug>` SPA routes (markdown via `marked` lazy-loaded from CDN); re-acceptance modal on version bump; landing-page cookie banner (slim bottom bar, three-action pattern); Account → Privacy card policy-history modal. Slugs seeded with placeholder bodies + all required: `terms_of_service`, `privacy_policy`, `cookie_policy`, `dpa`, `subprocessors`, `acceptable_use`. See "Step 11 — Privacy & compliance docs (shipped)" below. |
| 12 | Pipeline DB Model D + backups + PROBE_RLS in CI | 12-15 | Per `.claude/pipeline-hardening-notes.md` Model D: `tenant_id` + RLS + `app.current_tenant` per-workflow; `pipeline_user` role split (no ownership); pg_basebackup + WAL archiving + documented + tested restore drill in `docs/operator.md`; GitHub Actions runs `PROBE_RLS=1 npx vitest run src/db/rls-probe.test.ts` against ephemeral Postgres on every PR. **PRODUCTION READY AFTER THIS STEP.** |

### Pre-launch nice-to-have (clears the deck — optional)

| # | Step | Est. commits | Scope |
|---|---|---|---|
| 13 | Mini-queue cleanup bundle | 8-10 | VAPID/push polish (move inline `CREATE TABLE` to migration; VAPID keys env → platform_settings); ai.service `withAiUserContext` consolidation onto `db/connection.withUserContext`; ESLint custom rule replacing `scripts/check-withclient-allowlist.sh`; Admin "Last failure" column UI wiring. |
| 14 | Globals starter pack | 5-8 | Admin UI option to export Globals + integrations catalog + email templates as a shareable "starter pack" zip. Deferred C7 from step 7. |

### Post-launch

| # | Step | Est. commits | Scope |
|---|---|---|---|
| 15 | Pipeline DB Model J | 8-10 | Per `.claude/pipeline-hardening-notes.md` Model J: `pipeline.authorize(jwt)` SECURITY DEFINER + RS256 verification + per-tenant key rotation; replaces D's "trust the app" model with verify-at-DB. |
| 16-21 | `dashboards.view_html/css/js` retirement track | 6 sessions × ~10 commits | Multi-session per `.claude/dashboard-view-columns-audit.md`: (16) move static payload to new cache shape, (17) reader migration, (18) backfill migration, (19) writer migration, (20) portability migration, (21) drop columns. Recommended *deferred* — pure architectural cleanup, no user-facing or security benefit. |

### Production-readiness gate

After step 12, the system meets:

- **Tenant data isolation:** RLS top-to-bottom (platform DB step
  6/7, pipeline DB step 12).
- **Auth strength:** Passkey + TOTP + backup codes; MFA-required
  for admins; brute-force throttled at 100/min device + 20/day
  user.
- **Session hygiene:** CSRF-protected, rotated on auth state
  change, impersonation visible.
- **Privacy compliance:** T&C + privacy + cookie + DPA + AUP +
  sub-processors all admin-editable + versioned + acceptance-
  tracked; GDPR Art. 17 + 20 endpoints.
- **Supply chain:** SCA + SAST + container scanning + secrets
  scanning all in CI.
- **Backups:** WAL-archive + tested restore drill.
- **Audit trail:** platform.audit_log + pipeline.access_audit
  (Model D's foundation, expanded in Model J at step 15).

What's still gapped after step 12 (out of scope for "production
ready," addressed under separate tracks):

- **Observability** — centralized logs + metrics + alerting.
  Operator-track, separate from this roadmap.
- **SOC 2 Type II audit** — organizational controls
  (onboarding, access reviews, vendor management, IR runbook,
  training, change-management evidence). Policy + process work
  with an auditor, ~6-month engagement.
- **HIPAA** — N/A unless customer profile changes to PHI.
- **Pipeline DB Model J** — D is the production-ready floor; J
  hardens against an n8n compromise (step 15).

### How "must ship before signup" was determined

The gate isn't *importance* — it's *whether deferring leaves a
permanent gap or breaks a contract you can't unsign*:

- **Tier 1 (hard blockers, regulatory/data-shape):** all of
  step 11, backups + restore drill (folded into step 12),
  pipeline DB Model D (step 12).
- **Tier 2 (strong, exposure-window cost):** step 9, step 10,
  step 8's secret-scanning + Dependabot subset.
- **Tier 3 (defer-with-no-penalty):** steps 13, 14, 15, 16-21,
  observability.
