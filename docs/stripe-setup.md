# Stripe setup — operator guide

Step-by-step for wiring a Stripe account to a running XRay install. The
frontend is already built; this is the configuration on both sides.

**Prerequisites:** an XRay install reachable at a public HTTPS URL, and a
platform-admin login. The webhook step will not work against `localhost` — see
§7 for the local-development path.

**Before you start — pick a mode.** Stripe's test and live modes are entirely
separate universes: separate API keys, separate webhook endpoints and signing
secrets, and separate products. Anything you create in test mode is invisible in
live mode. Do the whole of Part A in test mode first, verify end to end, then
repeat it in live mode. The toggle is top-right in the Stripe dashboard.

---

## Part A — Stripe dashboard

### A1. Create your products and prices

**Products → Add product.** For each thing a customer can subscribe to:

- **Name** — customers see this on the checkout page, on their invoice, and on
  the XRay billing page.
- **Description** — shown on the XRay billing page under "Available plans".
- **Price** — set **Recurring**, pick monthly or yearly, set the amount.

Create one product per plan (e.g. "XRay Starter", "XRay Professional").

Two things matter downstream:

- **XRay gates on the product ID, not the price ID.** A product can carry
  several prices (monthly/yearly, currencies) and any active subscription to
  that product satisfies the gate.
- **Every product needs at least one active price.** Checkout resolves the
  product's first active price at purchase time and errors with `NO_PRICE`
  without one.

Do this step **first**. XRay's product list is fetched live from Stripe, so
there's nothing to configure on the app side until products exist.

### A2. Copy your API keys

**Developers → API keys.** You need two:

| Key | Looks like | Sensitivity |
| --- | --- | --- |
| Publishable key | `pk_test_...` / `pk_live_...` | Safe in the browser |
| Secret key | `sk_test_...` / `sk_live_...` | Server-only, never expose |

The secret key is shown once on creation — use "Reveal" if it's an existing key,
or roll a new one.

### A3. Create the webhook endpoint

**Developers → Webhooks → Add endpoint.**

**Endpoint URL:**
```
https://<your-xray-domain>/api/stripe/webhook
```

XRay shows you this exact URL, prefilled and copyable, at **Admin → Stripe →
Webhook Endpoint**.

**Select these six events** — these are the ones XRay handles:

```
checkout.session.completed
invoice.paid
invoice.payment_failed
customer.subscription.updated
customer.subscription.deleted
payment_intent.succeeded
```

Don't select "all events". XRay logs and ignores unrecognized types, so extras
are harmless but they'll clutter your delivery log and make real failures harder
to spot.

**Then copy the signing secret** — after creating the endpoint, click into it
and reveal **Signing secret** (`whsec_...`). This is *not* your API key. XRay
verifies every incoming webhook against it, and the wrong value means every
delivery fails with a signature error.

### A4. Activate the customer portal

**Settings → Billing → Customer portal.** Turn it on and choose what customers
may do (update payment method, cancel, view invoices). XRay's billing page has a
"Manage billing" button that mints a portal session for the tenant's customer.

Without activating the portal here, that button errors.

### A5. Optional extras

**Promotion codes** — create under **Products → Coupons**. XRay only shows the
promo-code field at checkout when you also flip the toggle in §B1; it's off by
default, since promo eligibility is a deliberate billing decision.

**Pricing table** — if you want Stripe's hosted pricing table embedded rather
than XRay's own "Available plans" list, build one under **Products → Pricing
tables** and copy its ID (`prctbl_...`).

---

## Part B — XRay admin

Sign in as a platform admin and go to **Admin → Stripe**.

### B1. API Keys card

| Field | Paste | Stored as |
| --- | --- | --- |
| Publishable key | `pk_...` from A2 | `stripe_publishable_key` |
| Secret key | `sk_...` from A2 | `stripe_secret_key` (**encrypted**) |
| Webhook signing secret | `whsec_...` from A3 | `stripe_webhook_secret` (**encrypted**) |
| Pricing table ID | `prctbl_...` from A5, or leave blank | `stripe_pricing_table_id` |
| Customer portal URL | from A4, or leave blank | `stripe_portal_url` |

Click **Save Keys**.

The secret key and webhook secret are encrypted at rest under `ENCRYPTION_KEY`
and are masked with bullets when the form reloads. Re-saving without editing
them leaves the stored values alone — the form skips any value still containing
the mask characters.

The **Allow promotion codes** toggle auto-saves on flip (no Save needed) and
writes `stripe_allow_promotion_codes`.

> **Use the admin UI for the secret key, not an environment variable.** The
> server code reads `process.env.STRIPE_SECRET_KEY` as a fallback, but
> `docker-compose.yml` does not pass that variable into the container — only
> `STRIPE_WEBHOOK_SECRET` is forwarded. On a standard Docker install the env
> fallback for the secret key is dead, and the admin UI is the only path that
> works. (Setting `STRIPE_WEBHOOK_SECRET` in `.env` *does* work, but the admin
> UI takes precedence and is easier to rotate.)

### B2. Products card — the actual gate

Click **Refresh from Stripe**. Your active products from A1 appear, each with
three independent toggles:

| Toggle | Setting key | Effect |
| --- | --- | --- |
| **Gate** | `stripe_gate_products` | An active subscription to this product unlocks dashboard access |
| **Billing page** | `stripe_billing_page_products` | Product appears as purchasable under "Available plans" |
| **Tenant row** | `stripe_status_tenant_row_products` | Subscription status shows on the Admin → Tenants row |

They're independent on purpose. A legacy plan can keep granting access (Gate on)
while no longer being sellable (Billing page off).

**For a typical setup: turn on Gate and Billing page for every plan you sell.**

Saving broadcasts a `billing:updated` event to every connected tenant, so open
billing pages refresh their plan list without a reload.

#### Read this before you touch the Gate toggles

The gate has three states, and the middle one catches people out:

| Gate list | Behavior |
| --- | --- |
| Never configured (setting absent) | Falls back to `plan_tier != 'free'` on the local billing record |
| Configured with products | Only an active subscription to a listed product grants access |
| **Configured but empty** | **Nobody gets access** |

Once you save the Products card even once, the gate is "configured" permanently.
Clearing every Gate toggle afterwards locks out **all** tenants — it does not
revert to the permissive fallback. If you need to open access temporarily, use
the billing override (§C3) rather than emptying the list.

The gate also **fails closed**: if the Stripe API is unreachable and the gate is
configured, access is denied rather than granted. Use the override for
emergencies.

### B3. Verify

**Admin → Stripe → Status** shows whether keys are present and the API responds.

**Stripe dashboard → Developers → Webhooks → your endpoint** shows every
delivery attempt. You want `200`s. The common failures:

| Symptom | Cause |
| --- | --- |
| `400`, signature verification failed | Wrong signing secret, or you pasted the API key |
| `404` | Wrong URL — check the path is exactly `/api/stripe/webhook` |
| Timeouts / no attempts | Endpoint not publicly reachable; proxy or DNS |
| `500`, `STRIPE_NOT_CONFIGURED` | Secret key never saved (see the env-var note in B1) |

Use **Send test webhook** on the endpoint page to fire one without a real
purchase.

---

## Part C — End-to-end test and day-two operations

### C1. Run a real test purchase

In **test mode**, as a tenant user with `billing.manage`:

1. Go to **Billing → Available plans**, pick a plan, click subscribe.
2. Pay with Stripe's test card `4242 4242 4242 4242`, any future expiry, any CVC.
3. On completion you should see, in order:
   - a `checkout.session.completed` delivery logged `200` in Stripe
   - a subscription under **Billing → Your subscriptions**
   - dashboard access unlocked **in the already-open tab, without a reload** —
     that's the WebSocket `billing:updated` broadcast landing

If the payment succeeds but access doesn't unlock, the webhook didn't arrive or
couldn't be attributed. Check the Stripe delivery log first, then §C2.

### C2. Fixing a missed webhook

**Admin → Stripe → Tenant Billing Status** lists every tenant's subscription
state and lets you manually attach a Stripe customer ID to a tenant. This is the
repair tool for a payment that completed while your webhook endpoint was down or
misconfigured — it sets `stripe_customer_id` and marks billing active.

For diagnosing one customer, `GET /api/stripe/admin/debug/<customer_id>`
(platform admin) dumps what Stripe reports for that customer, which tells you
whether the problem is on Stripe's side or the mapping's.

### C3. Comping an account

`POST /api/stripe/override/<tenantId>` with `{"enabled": true}` (platform admin)
grants full access with no subscription, checked before any Stripe lookup. This
is the right tool for trials, comps, support incidents, and any moment the gate
is misbehaving. It broadcasts to that tenant immediately. Set `enabled: false`
to lift it.

### C4. Going live

Repeat **all of Part A in live mode** — live products, live keys, a live webhook
endpoint with its own signing secret — then update the three key fields in §B1
and re-run **Refresh from Stripe** in §B2 to re-toggle the live product IDs.
Product IDs differ between modes, so the test-mode gate list means nothing in
live mode. Verify with one real card charge you then refund.

---

## Local development

Stripe cannot reach `localhost`, so use the CLI instead of a dashboard endpoint:

```bash
stripe login
stripe listen --forward-to localhost:3000/api/stripe/webhook
```

`stripe listen` prints its own `whsec_...` — put **that** in the webhook secret
field for local work; it's different from any dashboard endpoint's secret.

Then fire events by hand:

```bash
stripe trigger checkout.session.completed
stripe trigger customer.subscription.deleted
```

---

## Settings reference

Everything the admin UI writes, for anyone reading `platform_settings` directly:

| Key | Set at | Encrypted |
| --- | --- | --- |
| `stripe_publishable_key` | Admin → Stripe | no |
| `stripe_secret_key` | Admin → Stripe | **yes** |
| `stripe_webhook_secret` | Admin → Stripe (or `STRIPE_WEBHOOK_SECRET` env) | **yes** |
| `stripe_pricing_table_id` | Admin → Stripe | no |
| `stripe_portal_url` | Admin → Stripe | no |
| `stripe_allow_promotion_codes` | Admin → Stripe (auto-saves) | no |
| `stripe_gate_products` | Admin → Stripe → Products | no |
| `stripe_billing_page_products` | Admin → Stripe → Products | no |
| `stripe_status_tenant_row_products` | Admin → Stripe → Products | no |
| `billing.override.<tenantId>` | `POST /api/stripe/override/:tenantId` | no |

Settings are cached in-process and the cache is invalidated on write, so changes
take effect immediately — no restart.
