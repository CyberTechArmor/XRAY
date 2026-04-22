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

## Step 3 — Next up: schema refactor + dashboard-template cutover

See `.claude/step-3-kickoff.md` for details.
