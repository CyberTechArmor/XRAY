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
