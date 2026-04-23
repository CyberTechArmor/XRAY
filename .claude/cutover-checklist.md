# On-prem cutover checklist

Ordered steps for moving the XRay platform from the current VPS to
on-prem hardware. Written at the close of step 6 (platform DB
hardening). Every step is idempotent / retryable unless marked
ONE-SHOT.

Assumes:
- Old host (`vps-old`) is running a green step-6-hardened build.
- New host (`vps-new`) has Docker, Docker Compose, a registered
  domain, TLS certs ready, and postgres + server image builds
  tested from a clean checkout.

## Pre-flight (do these days before cutover)

1. **Freeze schema drift.** Confirm both hosts are on the same
   migration head (`SELECT MAX(...) FROM …` — or just compare
   `migrations/*.sql` vs what's been applied). Any divergence
   fails the cutover fast; easier to fix before the maintenance
   window.

2. **Confirm ENCRYPTION_KEY lives in both `.env` files.** Secret
   columns round-trip only when both hosts agree on the key. Miss
   this and every decrypt throws after cutover (step 6 v's hard
   rejection is explicit — no silent plaintext fallback).

3. **Inventory Stripe webhook endpoints.** Open the Stripe
   dashboard → Developers → Webhooks. Record the current endpoint
   URL, signing secret, and the event list. Needed for the flip.

4. **Inventory OAuth app redirect URIs.** HousecallPro, QuickBooks,
   any active provider — each registered app needs its redirect
   URI updated to `vps-new`'s domain. Stage the changes in the
   provider consoles but don't apply yet.

5. **Capture fan-out shared secret.** `SELECT value FROM
   platform.platform_settings WHERE key = 'fan_out_shared_secret'`.
   Note it; n8n needs the new value after cutover.

6. **Dry-run a restore into `vps-new`.** `pg_dump` from `vps-old`,
   `pg_restore` into `vps-new`'s empty postgres. Run
   `migrations/probe-rls-cross-tenant.sql` and confirm PROBE PASS.
   Back out the restore.

## Cutover window

### Step 1 — put `vps-old` in read-only mode (ONE-SHOT)

```
docker exec xray-server touch /tmp/MAINTENANCE
```

If the server respects this flag (future work — not wired today),
all non-GET requests return 503. For now, announce maintenance via
status page and proceed.

### Step 2 — take the snapshot (ONE-SHOT, ~2-5 min for a small DB)

On `vps-old`:

```bash
docker exec xray-postgres pg_dump -U xray -d xray \
  --schema=platform \
  --no-owner --no-privileges \
  -Fc -f /tmp/platform-snapshot.dump
docker cp xray-postgres:/tmp/platform-snapshot.dump .
```

Ship `platform-snapshot.dump` to `vps-new` via rsync or scp.

Critical: the dump preserves `tenants.id`, `tenants.stripe_customer_id`,
`billing_state.stripe_subscription_id`, `dashboards.bridge_secret`,
`integrations.client_secret`, and every encrypted column. Paired
with the matching `ENCRYPTION_KEY` on `vps-new`, nothing in the
application layer needs to change.

### Step 3 — restore on `vps-new`

```bash
docker cp platform-snapshot.dump xray-postgres:/tmp/
docker exec xray-postgres pg_restore -U xray -d xray \
  --clean --if-exists \
  /tmp/platform-snapshot.dump
```

Verify:

```bash
docker exec -i xray-postgres psql -U xray -d xray \
  < migrations/probe-rls-cross-tenant.sql
```

Expect `PROBE PASS`. Any leak blocks the cutover — do not DNS-flip.

### Step 4 — sync file uploads

```bash
rsync -a vps-old:/var/lib/xray/uploads/ vps-new:/var/lib/xray/uploads/
```

Or whichever path the `file_uploads.stored_name` column points at
in your deployment. `file_uploads` rows reference local disk
paths — they round-trip via `pg_dump` but the actual files don't.

### Step 5 — rotate fan-out shared secret (ONE-SHOT)

```sql
UPDATE platform.platform_settings
   SET value = encode(gen_random_bytes(32), 'base64')
 WHERE key = 'fan_out_shared_secret';
```

Copy the new value. Paste into n8n's Fan-out workflow credential
store. The old VPS's secret keeps working until n8n reloads;
coordinate with whoever owns n8n so the secret update lands
before the DNS flip.

### Step 6 — re-register Stripe webhook (ONE-SHOT)

In the Stripe dashboard:
- Create a new webhook endpoint pointing at `https://vps-new.example.com/api/stripe/webhook`
- Subscribe to the same events: `checkout.session.completed`,
  `invoice.payment_succeeded`, `invoice.payment_failed`,
  `customer.subscription.updated`, `customer.subscription.deleted`,
  `payment_intent.succeeded`.
- Copy the signing secret; paste into `vps-new`'s
  `STRIPE_WEBHOOK_SECRET` env var.
- **Do not delete the old endpoint yet** — keep it active until
  DNS has propagated and the old host has stopped receiving
  webhooks for 24h. Then disable (don't delete — Stripe's audit
  log wants the historical record).

### Step 7 — update OAuth app redirect URIs (ONE-SHOT per provider)

For each provider in `platform.integrations` with
`supports_oauth = true`:
- HCP / QBO / etc. admin console → add
  `https://vps-new.example.com/api/oauth/callback` to the
  allowlist.
- Leave the old URI in place until tenants have all re-connected
  (next step).

Some tenants will need to click "Reconnect" after cutover because
OAuth refresh tokens may be provider-bound to the old redirect
URI. The scheduler's `integration:needs_reconnect` broadcast
(step 6 vii) surfaces this automatically in the tenant UI.

### Step 8 — DNS flip (ONE-SHOT, propagation ≤ TTL)

Flip the A/AAAA records for the primary domain (and any
subdomains: `n8n.`, `meet.`, etc.) from `vps-old` to `vps-new`.
Expect 1-30 min propagation depending on TTL; lower TTL the day
before cutover.

Validate:
- `curl https://vps-new.example.com/api/health` returns `ok`
- Open `/` in an incognito window; the landing page loads
- Log in as a platform admin; admin dashboard renders
- Pick one subscribed tenant; verify billing page shows their
  correct Stripe subscription

### Step 9 — re-seed admin user (if needed)

If the new host started fresh (no restore) the owner/admin path
is first-signup per install.sh. If the restore happened in step 3
the admin users are already present.

### Step 10 — post-cutover smoke

Run this within 30 min of DNS flip:

- Render any dashboard end-to-end (user → bridge JWT → pipeline
  JWT → n8n → upstream → cached render).
- Trigger a Stripe test webhook from the dashboard ("Send test
  webhook"). Verify it hits the new endpoint and logs
  `billing.invoice_paid` or equivalent in audit_log.
- Visit the admin → Integrations tab; verify each integration
  row's "Last fan-out" timestamp shows recent activity.
- Confirm one tenant's OAuth connection refreshes on the next
  scheduler tick (watch `platform.audit_log` for
  `oauth.token_refreshed` or
  `UPDATE platform.connections SET oauth_last_refreshed_at`).

## Post-cutover (first week)

1. Leave `vps-old` running in read-only mode for 7 days. Stripe
   retries, tenants with stale DNS caches, and background jobs
   may still try to reach it; reply with 503 + a static "we've
   moved" page rather than 404.
2. Monitor `dashboard.render_failed` audit volume on `vps-new`.
   A post-cutover spike is expected (OAuth reconnect required,
   stale bridge secrets); it should tail off within 48h.
3. Run `migrations/probe-rls-cross-tenant.sql` one more time
   against live data. PROBE PASS before closing the cutover
   ticket.
4. Decommission `vps-old` only after the week is clear. Keep the
   final pg_dump off-host for audit/rollback purposes — 90 days
   is a reasonable window.

## Failure modes and rollbacks

- **Probe fails after restore.** Stop cutover. The source of
  truth is `vps-old`; DNS has not flipped. Investigate which
  table/policy leaked, fix, re-dump, retry step 3.
- **Stripe webhook signing fails on `vps-new`.** Check
  `STRIPE_WEBHOOK_SECRET` in the new `.env`. Stripe's test-webhook
  button produces a distinct signing secret — make sure the
  production endpoint's secret is what's in the env file.
- **Every dashboard shows "Needs reconnect."** The scheduler has
  flipped every tenant's connection because refresh failed. Most
  likely cause: `ENCRYPTION_KEY` mismatch between hosts —
  `decryptSecret` throws (step 6 v) and the scheduler interprets
  the failure as exhausted retries. Verify env, re-deploy, watch
  for successful refreshes on the next tick.
- **Tenants see zero dashboards.** RLS regression — a call site
  that expected admin bypass is running under `withTenantContext`
  with a mismatched tenant. Run the JS probe
  (`PROBE_RLS=1 DATABASE_URL=... npx vitest run src/db/rls-probe.test.ts`).
  Correlate failures with the service's commit in the step-6 log.

## Known residual follow-ups (not blocking cutover)

These ship post-cutover as separate PRs. Listed so the on-prem
team knows what's still open:

- Dashboard.service per-function `withTenantContext` refinement
  (step 6 iii.17 shipped the mechanical sweep; the targeted
  tenant-context pass is deferred).
- Routes and admin surface tenant-context migration (connection,
  inbox, user, oauth, dashboard, stripe, admin.\*).
- Portability export/import gap-fill: `stripe_customer_id`,
  `stripe_subscription_id`, `platform_settings`, `api_keys`,
  `webhooks`, `integrations`, `dashboard_tenant_grants`,
  `dashboard_shares`.
- Inbox RLS (user_scope, mirrors migration 016).
- Pipeline DB hardening Phase A / B (Model D → Model J).
- Legacy `dashboards.view_html` column retirement.
- eslint rule / pre-commit enforcement for the
  `withTenantContext` vs `withAdminClient` guardrails.
