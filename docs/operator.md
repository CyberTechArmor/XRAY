# XRay Operator Guide

This is the doc for someone running an XRay platform instance. It
covers the three configuration surfaces the platform needs before
paying tenants can sign up, pay, and see a dashboard: OAuth
integrations, Stripe billing, and the n8n fan-out secret. The
troubleshooting section at the bottom covers the most common
"something's off" questions.

Everything in this doc assumes you've already run `./install.sh`
successfully and have platform-admin access.

## Integrations — OAuth app registration

XRay ships with a catalog table (`platform.integrations`) but no
pre-seeded rows. Each provider gets one entry that carries the
client ID, client secret, and any auth-URL overrides. You register
the OAuth app once with the provider, paste the credentials into
XRay, and every tenant connects through that shared app.

### HouseCall Pro

1. In your HouseCall Pro developer portal, create an OAuth app.
2. Set the **redirect URI** to the value shown in
   **Admin → Integrations → HouseCall Pro** (identical for every
   provider — platform-wide callback).
3. Copy the client ID and client secret back into XRay's
   Integrations tab.
4. Flip the status from `pending` to `active` once you've pasted
   both values.

A tenant Owner can now click "Connect HouseCall Pro" from their
My Integrations strip.

### QuickBooks Online

1. Register a production app in the Intuit developer portal.
2. Set the redirect URI to the same value XRay shows you.
3. Scopes: `com.intuit.quickbooks.accounting` at minimum.
4. Paste the client ID / secret into XRay and flip the row
   to `active`.

QuickBooks sandbox and production use different client IDs. If
you're testing, add a second integration row with sandbox
credentials and mark it as `pending` until you're ready.

### Other providers

The catalog supports any OAuth 2.0 provider. For an API-key-based
provider (no OAuth), leave the OAuth fields blank and flip
`supports_api_key` to true. Tenants then see a "Paste key" flow
instead of a "Connect" button.

## Stripe billing

XRay's billing gate is WebSocket-backed: a tenant's dashboard
access unlocks the moment the webhook says payment succeeded. You
configure this once per install, not per tenant.

### 1. API keys

In **Admin → Stripe**, enter:
- Publishable key (pk_live_…)
- Secret key (sk_live_…) — stored encrypted
- Webhook signing secret (whsec_…) — stored encrypted

The secret key and webhook secret can also be supplied via the env
vars `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`; env vars take
precedence over the stored setting if both are present.

### 2. Webhook endpoint

Copy the webhook URL from the Stripe admin card, paste it into
Stripe's [Developers → Webhooks](https://dashboard.stripe.com/webhooks)
page, and enable these events:

- `checkout.session.completed`
- `invoice.paid`
- `invoice.payment_succeeded`
- `invoice.payment_failed`
- `customer.subscription.updated`
- `customer.subscription.deleted`
- `payment_intent.succeeded`

That's the full set XRay consumes today. Adding others won't break
anything — XRay ignores unrecognized events.

### 3. Stripe API key scopes (restricted key)

If you use a restricted key instead of a full secret key, grant
read and write on:

- Customers
- Subscriptions
- Invoices
- Checkout Sessions
- Billing Portal Sessions
- Products
- Prices

And read on:

- Payment Methods (needed for the "saved cards reused" behavior on
  repeat checkouts)

### 4. Per-product toggles

**Admin → Stripe → Products** lists every active product Stripe
knows about. Each row has three toggles:

| Toggle | What it does |
|---|---|
| **Gate** | This product unlocks dashboard access. An active subscription to any Gate product grants the tenant `hasVision`. Multiple Gate products are OR'd. |
| **Billing page** | This product appears on the tenant's own Billing page as a Subscribe / Resubscribe button. If unset, falls back to the Gate list so upgrading installs keep working. |
| **Tenant row** | The tenant's subscription status to this product is shown as a column on the admin Tenants list. Turn this on for your primary subscription product. |

Changes broadcast to all connected tenant sessions immediately, so
a toggle flip you make in this tab reflects on tenant billing pages
without a page reload.

### 5. Billing overrides

On any row in **Admin → Tenants**, open the detail modal and
toggle "Billing override". That bypasses the Stripe gate for that
tenant specifically — useful for comped accounts, internal
demos, and pre-launch partners. The override is durable (stored in
`platform_settings`) and broadcasts over WebSocket so the tenant's
UI unlocks immediately.

## Fan-out secret (n8n cron dispatcher)

XRay doesn't schedule data refreshes itself. n8n does, and it
calls XRay's fan-out endpoint with a shared secret.

### Setup

1. In **Admin → Integrations**, open the row for the provider you
   want n8n to refresh on a schedule.
2. Scroll to "Fan-out secret" and click **Generate**. Copy the
   value — it's shown once.
3. In n8n, build a workflow with an HTTP Request node pointed at
   `POST /api/fan-out/:integration_slug` on your XRay host.
4. In the HTTP Request node, set the `X-XRay-Fan-Out-Secret`
   header to the value you copied.

You can rotate the secret any time from the same UI — generate a
new one, paste it into n8n, save the workflow. The old secret
continues to work until you click **Save** on the new one.

Parallelism is configurable per integration ("fan out to at most N
tenants at once"). Default is 5. The "last fan-out" status line
shows dispatch count, skip count, and last-run timestamp.

## Email templates

**Admin → Email → Templates** is the per-template editor. Each
template has a subject line, HTML body, and plaintext body; both
bodies use `{{variable}}` substitution for dynamic content.

XRay ships these defaults:

- `signup_verification`
- `login_code`
- `account_recovery`
- `invitation`
- `passkey_registered` (security notification on new passkey
  registration)
- `billing_locked` (sent when a tenant's subscription lapses)

Edit any template in place and click **Save**. If you later want
the shipped default back, click **Reset to default** in the
editor — this overwrites your edits with the current XRay default.
There is no opt-out: if you prefer your own branding, simply don't
click Reset.

New templates introduced in a future XRay release are seeded
automatically on server boot (admin-edited templates are never
overwritten — only missing keys are inserted).

## Troubleshooting

### Magic link expired

Default expiry is 10 minutes. If a user reports the link isn't
working, check `platform.magic_links.expires_at` — if the row is
still there but expired, they just need to request a new code
from the verify screen's "Resend code" button.

### Integration stuck on "needs reconnect"

The OAuth scheduler flags a connection as `needs_reconnect` when
a refresh attempt fails (typically because the user revoked the
app or the refresh token hit a hard expiry). The tenant Owner has
to click "Reconnect" from their My Integrations strip — there's
no way to rehydrate the token without their action.

Diagnose with:

```sql
SELECT tenant_id, slug, status, last_error, updated_at
  FROM platform.connections
 WHERE status = 'needs_reconnect'
 ORDER BY updated_at DESC;
```

### Fan-out returning 401

The n8n workflow's `X-XRay-Fan-Out-Secret` header doesn't match
the value stored on the integration row. Either:

- The secret was rotated but the n8n workflow wasn't updated
- The workflow is targeting the wrong integration slug

Cross-reference the n8n workflow's HTTP Request node against
**Admin → Integrations → (provider) → Fan-out secret**. If in
doubt, rotate the secret fresh and paste the new value on both
sides.

### Webhook from Stripe isn't firing

1. In the Stripe dashboard, open the webhook endpoint and look
   at the recent delivery list. 400/401 responses mean the
   signing secret is wrong; 500s mean XRay crashed on the event.
2. Check XRay logs: `docker compose logs -f server | grep -i
   stripe`. Signature mismatches log `STRIPE_WEBHOOK_NOT_CONFIGURED`
   or `Invalid signature`.
3. The webhook URL must be reachable from Stripe's IP ranges —
   verify your reverse proxy / firewall isn't blocking them.

### Tenant says "Subscription required" even though they paid

1. Open **Admin → Stripe → Tenant Billing Status**.
2. Find the tenant. If `stripeSubscriptions` is empty, either the
   checkout didn't complete or the Stripe customer isn't linked
   to the tenant.
3. Use **Link Stripe Customer** if the customer ID is known —
   recovers missed `checkout.session.completed` webhooks.
4. If the subscription exists but `isGateProduct` is false for
   every one of their active subs, make sure the correct product
   IDs are toggled **Gate** in **Admin → Stripe → Products**.

### Tenant's email address changed

There's no self-service email change today. Admin workaround:
update `platform.users.email` directly with psql. Magic links
and invitations are keyed on `email`, so after the update the
next login attempt will use the new address.

## Upgrading XRay

Run `./install.sh` again. It's idempotent:

- Docker images are rebuilt only if source changed
- `init.sql` runs inside `CREATE TABLE IF NOT EXISTS` / `ON
  CONFLICT DO NOTHING` guards
- Numbered additive migrations (`migrations/0NN_*.sql`) run
  once each — the server tracks which have been applied
- Email templates: new default keys seed on boot; existing
  admin-edited templates are preserved

The post-boot `/api/health` check fails loud on regression: if
the server isn't healthy within 60 seconds, the installer exits
non-zero and prints the last 30 lines of the server log inline.

## Platform export / import

`/api/admin/export` produces a ZIP bundle of the platform database
shape (tenants, users, dashboards, connections, integrations, email
templates, platform_settings, api_keys, webhooks, dashboard grants &
shares). Use it for host moves, staging-↔-prod sync, or backup-style
snapshots. `/api/admin/import` rehydrates the same shape with
no-overwrite semantics — existing rows skip, new rows insert.

### `ENCRYPTION_KEY` is a required sidecar

Several columns in the export carry **ciphertext** under the
`enc:v1:` envelope:

- `connections.api_key`, `connections.oauth_*_token`
- `dashboards.bridge_secret`
- `integrations.client_secret`
- `webhooks.secret`
- `platform_settings.value` rows where `is_secret = true`

The ciphertext is bound to the `ENCRYPTION_KEY` env variable that
was active when the source platform encrypted it. **The destination
platform MUST be configured with the SAME `ENCRYPTION_KEY`** before
importing, otherwise every read of those columns throws at
application time (encrypted-column strict mode — there is no
plaintext fallback).

Treat `ENCRYPTION_KEY` as a sidecar that travels with the export
ZIP through whatever secure channel you use (1Password, Vault,
out-of-band file). Without it, the export is a brick — the columns
that matter most (OAuth tokens, signing secrets, webhook secrets)
won't decrypt.

After import on the destination host, tenants still re-run any
OAuth Connect flows whose tokens were excluded from the export
(`oauth_refresh_token`, `oauth_access_token`, `api_key` ciphertexts
on `platform.connections`). The `integration_id` + `auth_method`
columns ARE round-tripped so the tenant's connection rows are
recognised by the scheduler post-import — only the live credentials
need re-issue.

### Excluded by design

- Live OAuth tokens / API keys on `platform.connections` (above).
- `platform.audit_log` rows (operational telemetry, not config).
- `platform.user_sessions` (session state, not config).
- `platform.user_passkeys` (passkeys are device-bound credentials —
  users re-register on a new host).
- Inbox threads / messages (operational; out-of-band if needed).
- Render cache rows (`platform.dashboard_render_cache`) — repopulated
  on next render.

## Backups

The platform Postgres has continuous WAL archiving + nightly base
backups. Local-first by design: the local volume is the primary
target; an S3-compatible offsite mirror layers on top of that and is
opt-in via env vars. Step 12 ships the scripts; the operator
schedules them via host cron.

The n8n DB is **out of scope** for this backup track — n8n keeps its
own state (workflow history, execution logs) on a separate cadence,
treated as operational telemetry, not config.

### What the backup volume contains

Inside the named volume `xray_pg_backups` (mounted at
`/var/lib/postgresql/backups` in the postgres container):

```
/var/lib/postgresql/backups/
├── base/
│   ├── 20260426T0230Z/
│   │   ├── base.tar.gz       — pg_basebackup tar payload
│   │   ├── pg_wal.tar.gz     — WAL captured during the base run
│   │   └── MANIFEST.txt      — version + timestamp + restore hint
│   └── 20260427T0230Z/
│       └── …
└── wal/
    ├── 000000010000000000000003   — archived WAL segments
    ├── 000000010000000000000004
    └── …
```

WAL segments arrive every ~5 minutes (`archive_timeout=300`) or
sooner if write traffic fills a 16 MB segment. Base backups arrive
nightly per the operator's cron entry.

### 1. Schedule (host cron)

Add to the host's crontab (`crontab -e`):

```cron
# Nightly base backup at 02:30 UTC + retention prune + S3 base sync
30 2 * * * cd /opt/xray && ./scripts/backup-platform.sh >> /var/log/xray-backup.log 2>&1

# Mirror new WAL segments to S3 every 5 minutes (no-op if BACKUP_S3_BUCKET unset)
*/5 * * * * cd /opt/xray && ./scripts/backup-s3-sync.sh wal >> /var/log/xray-backup.log 2>&1

# Monthly restore drill — proves the backups are restorable
0 3 1 * * cd /opt/xray && ./scripts/restore-drill.sh >> /var/log/xray-restore-drill.log 2>&1
```

Tune the times to your timezone and traffic pattern. Keep the
restore drill date predictable — operators set a calendar alert to
verify the log emitted `PASS` and there's no growing backlog of
orphan sidecar volumes.

### 2. Retention

`BACKUP_RETAIN_DAYS=14` is the default in `scripts/backup-platform.sh`
and matches the chosen retention window. Override per-deploy with
the env var. The most recent base backup is kept regardless of age
so a misconfigured `RETAIN_DAYS=0` can't leave you empty-handed.

WAL segments older than `BACKUP_RETAIN_DAYS` are pruned at the same
time. The S3 side intentionally does NOT delete on every WAL sync —
remote prune is a separate, operator-driven mode:

```sh
./scripts/backup-s3-sync.sh prune
```

…and is safe to run after the local prune step. Use sparingly; an
accidental run with the wrong `BACKUP_S3_PREFIX` deletes more than
you want.

### 3. S3 mirror — opt-in offsite

Set in `.env`:

```sh
BACKUP_S3_BUCKET=xray-backups-prod
BACKUP_S3_ENDPOINT=https://s3.us-east-005.backblazeb2.com    # omit for AWS S3
BACKUP_S3_REGION=us-east-005
BACKUP_S3_ACCESS_KEY_ID=...
BACKUP_S3_SECRET_ACCESS_KEY=...
BACKUP_S3_PREFIX=platform                                     # default
```

Any S3-compatible endpoint works (AWS S3, Backblaze B2,
DigitalOcean Spaces, Cloudflare R2, MinIO). The script invokes the
official `amazon/aws-cli:latest` image via `docker run --rm` so the
host doesn't need `aws` installed — only Docker.

Decoupled from Postgres on purpose: WAL `archive_command` writes to
the local volume only and ALWAYS succeeds (assuming local disk has
space). An S3 outage doesn't stall WAL recycling — exactly the
failure mode you don't want under network glitches.

If `BACKUP_S3_BUCKET` is unset, every script stays on the local-only
behavior. No errors, no fallback, no fan-out attempts.

### 4. Restore drill (monthly)

`scripts/restore-drill.sh` spins up a SIDECAR Postgres container,
restores the latest local base backup + replays WAL into it, runs
schema + smoke queries, and tears down. **Never** touches the live
platform DB.

Run interactively:

```sh
./scripts/restore-drill.sh                     # latest base, all WAL, teardown after
./scripts/restore-drill.sh --base 20260426T0230Z
./scripts/restore-drill.sh --target-time '2026-04-26 03:15:00'
./scripts/restore-drill.sh --keep              # leave sidecar up for triage
./scripts/restore-drill.sh --teardown          # clean up after a --keep run
./scripts/restore-drill.sh --from-s3           # cold-restore-from-S3 dry-run
```

A green run prints `PASS — schema present + smoke query OK` and
exits 0. A red run leaves the sidecar in place for triage; tear it
down with `--teardown`.

#### First-run output (paste here on first execution)

```
# Operator: replace this fenced block with the verbatim output of
# `./scripts/restore-drill.sh` against your live system. The block
# is the proof the backups are restorable on your hardware. Date the
# run and keep prior outputs in the section below for trend
# tracking.

# Date: <YYYY-MM-DD>
# Host: <hostname>
# Operator: <name>
```

## Cold-restore — when the platform DB is gone

Use this runbook when (a) the host is dead and you're spinning up a
fresh server, (b) the data volume is corrupted or accidentally
deleted, or (c) you need to clone production into a staging host.

### Pre-flight

You need:

- The `.env` file from the previous host (or its values rebuilt
  from your secret store). **`ENCRYPTION_KEY` MUST match** — every
  encrypted column on the restored DB is bound to the
  `ENCRYPTION_KEY` that signed it. A mismatch is a bricked DB.
  Same for `JWT_SECRET` (existing sessions / magic links).
- The base + WAL backup material. Either:
  - The `xray_pg_backups` Docker volume from the old host, copied
    into the new host's Docker volume directory, OR
  - S3 access to the offsite mirror (`BACKUP_S3_*` env vars).

### Steps

1. **Bring up the new host.** Install Docker, clone the XRay repo,
   write `.env` with the SAME `ENCRYPTION_KEY` + `JWT_SECRET` as
   the source host:
   ```sh
   git clone <xray repo url> /opt/xray
   cd /opt/xray
   cp /path/to/saved/.env .                  # or rebuild from secret store
   ```

2. **Stage the backups.** Either copy the volume directly or pull
   from S3:
   ```sh
   # Option A — copy the local volume from the old host
   docker volume create xray_pg_backups
   tar -xzf /backups/old-host-pg_backups.tar.gz \
     -C /var/lib/docker/volumes/xray_pg_backups/_data

   # Option B — pull from S3
   docker volume create xray_pg_backups
   ./scripts/backup-s3-sync.sh all  # reads BACKUP_S3_* from .env
   ```

3. **Run the restore drill against the staged backups.** This
   verifies the material is intact BEFORE you bring up the
   production stack on top of it:
   ```sh
   ./scripts/restore-drill.sh --keep
   ```
   Expect `PASS`. If `--keep` was specified, the drill sidecar is
   still running and you can interactively inspect it. Tear down
   after:
   ```sh
   ./scripts/restore-drill.sh --teardown
   ```

4. **Restore into the production data volume.** With the drill
   green, restore the same base + WAL into `xray_pg_data` (the
   actual production volume). Easiest path: extract the base into
   an empty `xray_pg_data` and let Postgres replay WAL on startup.

   ```sh
   # Pick a base
   BASE_TS=$(docker run --rm -v xray_pg_backups:/data:ro \
              postgres:16-alpine ls /data/base | sort | tail -n 1)

   # Reset the production data volume
   docker volume rm xray_pg_data 2>/dev/null || true
   docker volume create xray_pg_data

   # Extract the base + pg_wal
   docker run --rm \
     -v xray_pg_backups:/backups:ro \
     -v xray_pg_data:/var/lib/postgresql/data \
     --entrypoint sh \
     postgres:16-alpine \
     -c "
       set -eu
       cd /var/lib/postgresql/data
       tar -xzf /backups/base/${BASE_TS}/base.tar.gz -C .
       mkdir -p pg_wal
       tar -xzf /backups/base/${BASE_TS}/pg_wal.tar.gz -C pg_wal
       cat >> postgresql.auto.conf <<'CFGEOF'
   restore_command = 'cp /backups/wal/%f %p'
   CFGEOF
       touch recovery.signal
       chown -R postgres:postgres .
       chmod 700 .
     "
   ```

5. **Bring up the stack.**
   ```sh
   docker compose up -d
   ```
   Postgres starts in recovery mode (because `recovery.signal` is
   present) and replays every WAL segment in the archive before
   accepting writes. Watch the logs:
   ```sh
   docker compose logs -f postgres
   ```
   Wait for `database system is ready to accept connections`.

6. **Verify the migrations + RLS shape.**
   The server's startup self-heal applies any migrations not yet
   recorded as applied; for a same-version restore this is a no-op.
   Run the cross-tenant probe to confirm RLS is intact post-restore:
   ```sh
   docker compose exec -T postgres \
     psql -U xray -d xray < migrations/probes/probe-rls-cross-tenant.sql
   ```
   Expect `PROBE PASS`.

7. **Smoke-test the app.** Hit `/api/health` (returns 200), log in
   as platform admin, render a dashboard. Tenants whose OAuth
   refresh tokens have expired since the backup will need to
   reconnect — the same caveat as the export/import flow.

If anything fails between step 5 and step 7, the safest revert is
to wipe the production data volume + stack, restore from a known-
good base, and re-run from step 4.
