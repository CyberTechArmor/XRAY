# Porting the XRay Stripe integration to another service

Companion to `auth-flow-port-prompt.md`. Same two-part structure:

1. **How the XRay Stripe integration works** — the reference implementation.
2. **The prompt** — a self-contained brief for the target service's repo.

---

# Part 1 — How the XRay Stripe integration works

## 1.1 Shape: Stripe is the source of truth, the DB is a mirror

Nothing about entitlement lives only in Stripe, and nothing lives only locally:

- **Stripe** owns subscriptions, invoices, prices, and the payment relationship.
- **`platform.billing_state`** (one row per tenant) mirrors the derived state:
  `plan_tier`, `payment_status`, `current_period_end`, `dashboard_limit`,
  `stripe_subscription_id`.
- **`platform.tenants.stripe_customer_id`** is the join key in both directions.

Webhooks write the mirror; the app reads it. That means a Stripe API outage
degrades gracefully instead of locking every paying customer out.

## 1.2 Runtime configuration, not deploy-time

`getStripeClient()` and `getWebhookSecret()` (`stripe.service.ts:8-23`) read
from platform settings **first** and fall back to env vars:

```ts
const secretKey = await getSetting('stripe_secret_key') || process.env.STRIPE_SECRET_KEY;
if (!secretKey) throw new AppError(500, 'STRIPE_NOT_CONFIGURED', '... Set it in Admin → Stripe or via STRIPE_SECRET_KEY ...');
```

An operator can configure Stripe from the admin UI on a running install — no
redeploy, no container restart. The error message names both paths.

The Stripe client is constructed per call rather than held as a module
singleton, which is what makes runtime reconfiguration take effect immediately.

## 1.3 The webhook: raw body, and the mounting order that makes it work

`index.ts:109-111` — the ordering here is the whole trick:

```ts
app.use('/api/stripe/webhook', express.raw({ type: 'application/json' }));
app.use('/api/admin/import',   express.raw({ type: [...], limit: '100mb' }));
app.use(express.json({ limit: '10mb' }));   // ← everything else, AFTER
```

Signature verification hashes the **exact bytes Stripe sent**. If
`express.json()` parses the body first, `req.body` is an object, re-serializing
it produces different bytes, and every signature check fails. The raw mount must
come first.

The route then verifies before doing anything else (`stripe.service.ts:31`):

```ts
const event = stripe.webhooks.constructEvent(payload, signature, webhookSecret);
```

That signature **is** the authentication for this endpoint. It's why
`/api/stripe/webhook` sits on the CSRF skip list (`csrf.ts`) alongside
`/api/webhooks/*` — both are sender-signed, so a CSRF token would be redundant
and would only break the sender.

Unhandled event types fall through to a `console.log` default rather than
throwing — Stripe sends far more event types than any app subscribes to, and a
throw would make Stripe mark the endpoint unhealthy.

## 1.4 Tenant resolution — both directions

**Outbound**, `createCheckoutSession()` stamps the tenant into two places:

```ts
metadata: { tenant_id: tenantId },
subscription_data: { metadata: { tenant_id: tenantId } },
```

Both, deliberately: session metadata is available on
`checkout.session.completed`, but it does **not** propagate to the subscription
object, so later `customer.subscription.*` events would have no tenant without
the second copy.

**Inbound**, three strategies in fallback order:

1. `session.client_reference_id` — how Stripe's hosted Pricing Table passes it
2. `session.metadata.tenant_id` — how custom checkout passes it
3. Reverse-lookup `SELECT id FROM platform.tenants WHERE stripe_customer_id = $1`

Strategy 3 is the reason webhooks run under `withAdminClient` — the handler has
no tenant context yet, so it must legitimately cross tenants to find out which
one this customer is. This is the canonical justified use of the bypass helper
(see `CLAUDE.md`).

## 1.5 The entitlement gate

Two endpoints, deliberately different weights:

- **`GET /api/stripe/status`** — full picture for the billing page. Hits Stripe
  live for subscriptions, product names, and the last 10 invoices. Requires
  `billing.view`.
- **`GET /api/stripe/plan`** — the paywall check. Returns `{ hasVision }`.
  Called on dashboard access.

The gate is **product-ID based**, not tier-string based. An admin stores a JSON
array of Stripe product IDs in the `stripe_gate_products` setting; holding an
active subscription to any of them grants access.

Three subtleties in `stripe.routes.ts:64-120` worth copying:

**Configured-but-empty is meaningful.**
```ts
const gateConfigured = gateProductsRaw !== null;   // NOT: gateProductIds.length > 0
```
`[]` means "the admin set up the gate and nothing currently grants access."
`null` means "never configured" and falls back to `plan_tier !== 'free'`. Testing
truthiness instead of `!== null` would silently hand every tenant a free pass the
moment an admin cleared the list.

**It fails closed.** When the Stripe API call throws, the catch block re-reads
the setting. If the gate is configured, `hasVision` stays `false`. Only a
never-configured install falls back to the local `plan_tier`.

**Cancelled-but-paid still counts.**
```ts
const isActive = s.status === 'active' || s.status === 'trialing' ||
  (s.cancelAtPeriodEnd && s.currentPeriodEnd && new Date(s.currentPeriodEnd) > now);
```
A customer who cancels keeps access through the period they paid for.

**Override**: a platform admin can set `billing.override.<tenantId>` to `'true'`,
checked before anything else — the escape hatch for comped accounts, trials, and
support situations.

## 1.6 Ownership guard on every mutation

`cancelSubscriptionAtPeriodEnd()` / `resumeSubscription()` both re-fetch the
subscription from Stripe and compare its customer against the caller's tenant
before mutating:

```ts
if (!tenant?.stripe_customer_id || tenant.stripe_customer_id !== customerId) {
  throw new AppError(403, 'SUBSCRIPTION_NOT_OWNED', 'This subscription does not belong to your tenant.');
}
```

Without this, `POST /subscription/sub_XXX/cancel` would let any authenticated
tenant cancel any other tenant's subscription by guessing an ID. The permission
check (`billing.manage`) proves you can manage *your* billing — it says nothing
about *which* subscription you named.

## 1.7 Real-time gate propagation

Webhook handlers broadcast to the affected tenant only:

```ts
const { broadcastToTenant } = await import('../ws');
broadcastToTenant(tenantId, 'billing:updated', { hasVision: true, status: 'active' });
```

Wrapped in try/catch — a WebSocket failure must never roll back a billing write.

On the client, `app.js:1238-1252` fans out rather than using a single handler:

```js
window.__xrayOnBilling = function(fn) {
  window.__xrayBillingSubscribers.push(fn);
  return function unsubscribe() { /* splice */ };
};
```

The comment explains why: the paywall, the billing page, and the admin tenants
view can all be mounted at once, and a single `window.__xrayBillingChanged = fn`
would let whichever mounted last clobber the rest. Views subscribe on mount and
unsubscribe on unmount.

The client's reaction is to **re-ask the server**, not to trust the payload —
the broadcast is a cache-invalidation signal, not the new state.

## 1.8 Audit logging

Every state transition logs: `billing.checkout_completed`, `billing.invoice_paid`,
`billing.subscription_updated`, `billing.subscription_deleted`,
`billing.payment_succeeded`, `billing.subscription_cancel_scheduled`,
`billing.subscription_resumed`. Billing disputes are answered from this log.

## 1.9 Known rough edges — fix these when porting

I'm flagging these because copying the structure without copying the bugs is the
point of the exercise.

**No webhook idempotency.** Stripe retries deliveries, and can deliver the same
event more than once. Most handlers are idempotent `UPSERT`s, so a replay is
harmless — but `handlePaymentSucceeded()` (`stripe.service.ts:256-292`) does raw
`INSERT`s into `connections` / `dashboards`. A duplicate delivery creates
duplicate rows. There is no `processed_stripe_events` table keyed on `event.id`.

**No event-ordering guard.** `handleSubscriptionUpdated()` writes whatever
arrives. Stripe does not guarantee delivery order, so a delayed `updated` event
can overwrite newer state. The usual fix is to store the event's `created`
timestamp and skip anything older, or re-fetch the subscription from the API
instead of trusting the payload.

**Silent failure on missing tenant.** `handleCheckoutCompleted()` logs to
`console.error` and returns when it can't resolve a tenant. The customer has paid
and nothing is provisioned, with no alert and no retry — this should be a loud
failure (throw so Stripe retries, plus an operator alert).

**The paywall hits the Stripe API.** `GET /plan` calls `getBillingStatus()`,
which lists subscriptions and then does an N+1 `products.retrieve()` per product.
That's several Stripe round-trips on every dashboard load, and it's why the
fail-closed path matters so much. The mirror in `billing_state` exists precisely
so the hot gate check can be a local read; it isn't used that way yet.

**Tier derivation is fragile.**
`subscription.metadata?.plan_tier || 'starter'` with a hardcoded
`professional: 50 / starter: 10` limits map means any subscription lacking that
metadata silently becomes a starter plan with 10 dashboards. Derive the tier
from the product/price ID instead.

---

# Part 2 — The prompt

> Fill in the blanks, then paste everything below the line.

**Blanks:**
- `<SERVICE>` — target service name
- `<REPO_PATH>` — where its API lives
- `<ENTITLEMENT>` — what a subscription unlocks (e.g. "dashboard access")
- `<TENANCY>` — `per-tenant` or `per-user` billing subject

---

## PROMPT

I want `<SERVICE>` to integrate Stripe the way XRay BI does. Below is the
specification. Implement it in `<REPO_PATH>`, adapted to this codebase's
existing conventions. Match the **architecture and invariants**, not the file
names.

Where the spec says "XRay does X but you should do Y" — do Y. Those are known
defects in the reference implementation, called out deliberately.

### 1. Core principle

Stripe is the source of truth for the payment relationship. Your database keeps
a **mirror** of the derived entitlement state, one row per `<TENANCY>` subject.
Webhooks write the mirror; the application reads it. A Stripe API outage must
degrade gracefully, never lock out paying customers.

Mirror table, one row per billing subject:

```
plan_tier, payment_status, current_period_end,
stripe_subscription_id, updated_at
```

Plus `stripe_customer_id` on the subject table — the join key in both directions.

### 2. Runtime configuration

Read the secret key and webhook secret from **runtime settings first, env vars
as fallback**:

```ts
const key = await getSetting('stripe_secret_key') || process.env.STRIPE_SECRET_KEY;
if (!key) throw new AppError(500, 'STRIPE_NOT_CONFIGURED',
  'Stripe is not configured. Set it in Admin → Stripe or via STRIPE_SECRET_KEY.');
```

Construct the Stripe client **per call**, not as a module-level singleton, so an
operator reconfiguring from the admin UI takes effect without a restart. Error
messages must name both configuration paths.

### 3. Webhook endpoint — get these four things right

**a) Raw body, mounted before the JSON parser.**

```ts
app.use('/api/stripe/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());   // ← must come AFTER
```

Signature verification hashes the exact bytes Stripe sent. If a JSON parser
touches the body first, every signature check fails. This ordering bug is the
single most common Stripe integration failure — verify it explicitly.

**b) Verify the signature before any other work.** That signature is this
endpoint's authentication. Reject a missing/malformed `stripe-signature` header
with a 400 before calling into any service.

**c) Exempt it from CSRF.** It's sender-signed; a CSRF token is meaningless here
and would break Stripe. Document the exemption inline with that reasoning.

**d) Don't throw on unknown event types.** Log and return 200. Stripe sends more
event types than you subscribe to, and throwing makes Stripe mark your endpoint
unhealthy and back off retries.

Handle at minimum: `checkout.session.completed`, `invoice.paid`,
`invoice.payment_failed`, `customer.subscription.updated`,
`customer.subscription.deleted`.

### 4. Idempotency and ordering — XRay does NOT do this; you must

**Idempotency.** Stripe retries and can deliver the same event twice. Create a
`processed_stripe_events` table keyed on Stripe's `event.id`, insert-on-receipt,
and skip any event already present. Prefer idempotent `UPSERT`s in every handler
regardless — but the dedupe table is what makes non-idempotent side effects
(provisioning a resource, sending an email, charging something) safe.

**Ordering.** Stripe does not guarantee delivery order. Store each event's
`created` timestamp on the mirror row and ignore any event older than what
you've already applied — or re-fetch the subscription from the API rather than
trusting the payload. Without this, a delayed event silently reverts newer state.

**Loud failure.** If a webhook arrives that you cannot attribute to a billing
subject, that means someone paid and got nothing. Throw (so Stripe retries) and
alert an operator. Do **not** log-and-return — XRay does, and it's wrong.

### 5. Subject resolution — both directions

**Outbound**, stamp the subject ID into **both** places on checkout creation:

```ts
metadata: { subject_id: id },
subscription_data: { metadata: { subject_id: id } },
```

Both are required: session metadata does not propagate to the subscription
object, so later `customer.subscription.*` events would be unattributable with
only the first.

**Inbound**, resolve in this order:
1. `session.client_reference_id` (Stripe's hosted Pricing Table uses this)
2. `session.metadata.subject_id` (custom checkout)
3. Reverse-lookup by `stripe_customer_id`

Strategy 3 runs before any tenant/user scope is known, so it needs whatever
cross-scope database access your codebase uses — and that use should be
explicitly justified in a comment, not incidental.

### 6. The entitlement gate

Two endpoints with deliberately different weights:

- **Full status** — for the billing page. Live Stripe data: subscriptions,
  invoices, product names. Read-permission gated.
- **Lightweight gate check** — returns `{ hasAccess: boolean }`. Called on every
  `<ENTITLEMENT>` access.

**Serve the gate check from your local mirror, not the Stripe API.** XRay's gate
calls into the live-Stripe status function and pays several round-trips per
page load; that's the mirror table's whole reason for existing. Only the billing
page should hit Stripe live.

Gate on **product IDs**, not tier strings — store a JSON array of the Stripe
product IDs that grant access in a runtime setting. Then:

**Distinguish "configured but empty" from "never configured":**
```ts
const configured = raw !== null;      // NOT: ids.length > 0
```
`[]` means the admin configured the gate and nothing currently grants access.
`null` means never configured, and may fall back to a default. Testing
truthiness hands everyone a free pass the moment an admin clears the list.

**Fail closed.** If the gate is configured and the entitlement check errors,
deny. Only a never-configured install may fall back to a permissive default.

**Honor the paid-through period:**
```ts
const isActive = status === 'active' || status === 'trialing' ||
  (cancelAtPeriodEnd && currentPeriodEnd > now);
```
Someone who cancels keeps access until the period they paid for ends.

**Provide an operator override** — a per-subject setting checked before
everything else, for comps, trials, and support situations. Audit-log every
toggle.

### 7. Ownership guard on every mutation

Any endpoint taking a Stripe object ID from the request (cancel, resume, update)
must re-fetch that object from Stripe and verify it belongs to the caller's
customer before mutating:

```ts
if (tenant.stripe_customer_id !== customerId) {
  throw new AppError(403, 'SUBSCRIPTION_NOT_OWNED', '...');
}
```

A `billing.manage` permission proves the caller can manage *their own* billing.
It says nothing about which subscription ID they typed. Without this guard,
anyone can cancel anyone's subscription.

### 8. Real-time propagation

When billing state changes, push to the affected subject's connected clients
only — never a global broadcast. Wrap the push in try/catch so a socket failure
can't roll back a billing write.

On the client, use a **subscriber list**, not a single global handler:

```js
window.onBilling = function(fn) {
  subscribers.push(fn);
  return function unsubscribe() { /* splice */ };
};
```

Multiple views (paywall, billing page, admin) can be mounted simultaneously; a
single-handler global lets whichever mounted last silently clobber the rest.

Treat the pushed payload as a **cache-invalidation signal**: on receipt, re-ask
the server for the current state rather than trusting the message body.

### 9. Permissions and audit

- Split read from write: `billing.view` vs `billing.manage`.
- Restrict the operator override to platform admins.
- **Audit-log every billing state change** with the Stripe object IDs in the
  metadata. Billing disputes get answered from this log.

### 10. Derive tier from products, not metadata

XRay reads `subscription.metadata.plan_tier || 'starter'` against a hardcoded
limits map, so a subscription missing that metadata silently becomes a paid tier.
Derive entitlements from the **product or price ID** on the subscription item,
mapped through your gate configuration. Metadata is operator-editable in the
Stripe dashboard and should never be load-bearing for entitlement.

### 11. Acceptance criteria

- [ ] A webhook with a valid signature is accepted; a tampered body is rejected
- [ ] Verified explicitly: the raw-body mount precedes the JSON parser
- [ ] Replaying the same Stripe event twice produces no duplicate side effects
- [ ] An out-of-order event does not revert newer subscription state
- [ ] An unknown event type returns 200, not 500
- [ ] A webhook that can't be attributed to a subject alerts and retries — it
      does not silently succeed
- [ ] The gate check performs **zero** Stripe API calls in the common path
- [ ] Stripe API down + gate configured → access denied, not granted
- [ ] Stripe API down → the billing page degrades to mirrored data instead of
      erroring
- [ ] Clearing the gate product list revokes access; it does not grant it
- [ ] Cancel-at-period-end keeps access until `current_period_end` passes
- [ ] Tenant A cannot cancel tenant B's subscription by passing its ID → 403
- [ ] Completing checkout lifts the paywall in an already-open tab without a
      reload
- [ ] Two views subscribed to billing events both receive them
- [ ] Every state transition appears in the audit log with Stripe object IDs
- [ ] Stripe can be configured from the admin UI on a running install

### 12. Test with the CLI

`stripe listen --forward-to localhost:PORT/api/stripe/webhook` for local
signature-verified delivery, and `stripe trigger <event>` for each handled type.
Test the replay and out-of-order paths by re-sending captured events from the
Stripe dashboard — those are the paths that silently rot in production.

## END PROMPT
