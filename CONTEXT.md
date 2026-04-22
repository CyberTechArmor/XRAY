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

`update.sh` handles this end-to-end (migrations-before-rebuild ordering
is the post-step-2 fix). Manual equivalent for step 3:

1. Deploy the new server code. Renders JWT-only; no more legacy branch.
   A misconfigured dashboard (fetch_url without integration) will now
   error at render instead of proxying through legacy headers — run the
   cutover-safety queries *before* this deploy step to catch it.
2. Apply migration 020. Trigger + function + column all drop in one
   transaction. Idempotent: `DROP ... IF EXISTS` / `DROP COLUMN IF EXISTS`.

Order matters: a DB that still has the column but server code that no
longer SELECTs it is fine. The reverse (column dropped, old code still
SELECTing it) would throw at render. Deploy server code first, then
migrate.

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

## Step 4 — Next up: OAuth access_token population + RS256 keypair

See `.claude/step-4-kickoff.md` for details.
