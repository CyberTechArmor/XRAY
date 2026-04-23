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
