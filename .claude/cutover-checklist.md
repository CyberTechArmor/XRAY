# Cutover checklist — fresh install path

Current plan: the platform stays in the cloud on a new VPS, the
existing VPS gets blown out, and the handful of existing tenants
re-sign up on the new host. No Stripe customers have been created
yet, no paid subscriptions to migrate, and the hard-coded dashboards
will be moved onto Global templates as part of the re-signup.

This document covers that path. A data-preserving `pg_dump`/restore
cutover is documented at the bottom (appendix) for future use
when there are paying customers.

## Fresh-install cutover — sequence

### Pre-flight

1. **Stand up `vps-new`** with docker, docker compose, TLS, a
   domain pointed at it (either the existing domain or a new one
   depending on how you want to handle DNS).
2. **Clone the repo** onto `vps-new`, check out the main branch on
   the step-6-hardened commit.
3. **Prepare `.env`** on `vps-new`. At minimum:
   - `DATABASE_URL`
   - `JWT_SECRET` (generate a fresh one)
   - `ENCRYPTION_KEY` (generate a fresh one — 64 hex chars)
   - `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` (from Stripe)
   - `WEBAUTHN_ORIGIN` = the new host's HTTPS origin
4. **Install + first-boot**: `./install.sh` brings up Postgres +
   server + nginx. First HTTP request to `/` renders the landing
   page.

### Fresh-install deploy

5. **First signup is platform admin.** Open the landing page → sign
   up → magic-link → complete setup. This user becomes the platform
   admin automatically (the code-path detects zero existing users
   and promotes). Save the password-manager entry for the recovery
   email.

6. **Run the RLS probe** to confirm step 6 is working:
   ```
   docker exec -i xray-postgres psql -U xray -d xray \
     < migrations/probes/probe-rls-cross-tenant.sql
   ```
   Expect `PROBE PASS`. Any other output blocks go-live.

7. **Seed admin settings** through the admin UI:
   - Paste Stripe API key + webhook secret (Admin → Stripe).
   - Register integrations (Admin → Integrations):
     HousecallPro, QuickBooks, any other active provider.
     Enter client_id + client_secret for each.
   - Enable product toggles (Gate / Billing page / Tenant row) for
     each Stripe product that's subscribable.
   - Generate a new fan-out shared secret (Admin → Integrations
     → each integration's fan-out config). Save it for the n8n step.

8. **Register Stripe webhook**. In Stripe dashboard → Developers →
   Webhooks → add endpoint pointing at
   `https://<new-host>/api/stripe/webhook`. Subscribe to:
   `checkout.session.completed`, `invoice.payment_succeeded`,
   `invoice.payment_failed`, `customer.subscription.updated`,
   `customer.subscription.deleted`, `payment_intent.succeeded`.
   Copy the signing secret → paste into `STRIPE_WEBHOOK_SECRET`
   in `.env` → restart server container.

9. **Update OAuth redirect URIs** in each provider's admin console
   (HCP, QBO, etc.) to include
   `https://<new-host>/api/oauth/callback`. If you're reusing the
   same domain (DNS flip from old to new), these stay valid — no
   action needed.

10. **n8n side**:
    - Copy the new RS256 pipeline public key → paste into n8n's
      JWT Auth node.
    - Copy the new fan-out shared secret → paste into each fan-out
      workflow's credential.
    - Point n8n's pipeline-DB connection at the new pipeline DB
      (or keep existing if pipeline DB lives elsewhere).

### Tenant handoff

11. **Email existing tenants** (handful — no Stripe billing yet, so
    no payment coordination):
    - "We're migrating to a new host on {date}. You'll need to
      re-sign up at <new-url>."
    - "Your dashboards will be re-created automatically using our
      new Global-template system" (or however you want to phrase
      the hard-coded → Global transition).
    - "Reconnect your integrations (HCP, QBO, etc.) through the
      new Integrations tab."

12. **Blow out `vps-old`** after the new host is confirmed healthy:
    - Disable the Stripe webhook endpoint pointing at old host
      (don't delete — keeps Stripe's audit trail of historical
      events).
    - Remove old OAuth redirect URIs from provider apps (after
      confirming no tenant is still on the old host).
    - Destroy the old VPS instance.

## What about Stripe customer records?

No paid subscriptions have been created, so there's nothing to
migrate. When tenants re-sign up on the new host and subscribe,
fresh Stripe customer records get created as first-time checkouts.
Nothing to cancel, no duplicate customers, no double-billing risk.

If any Stripe test/sandbox customers exist on the old host's
Stripe test-mode, archive them in the Stripe dashboard once the
new host is live.

## What about existing dashboards / connections / users?

Out of scope per the fresh-install plan:
- Tenant data is not migrated.
- Users re-sign up, re-invite teammates.
- Dashboards re-created (the hard-coded → Global template transition
  happens here).
- OAuth connections re-authorized through the new host.
- File uploads re-attached by tenants.

A portability export/import exists but has gaps (doesn't round-trip
`stripe_customer_id`, `stripe_subscription_id`, `platform_settings`,
integrations catalog, post-4b tables). Closing those gaps is a
post-step-6 follow-up — not needed for this cutover.

## Post-cutover

- Monitor `audit_log.action = 'dashboard.render_failed'` on the
  new host. A spike during re-signup + re-connect is expected;
  should tail off within 48h.
- Re-run the RLS probe once a week for the first month —
  `PROBE PASS` becomes the standing acceptance gate.
- Archive `.env` from the new host to your secrets manager.
  `ENCRYPTION_KEY` + `JWT_SECRET` + Stripe/webauthn secrets all
  need to round-trip on any future DR restore.

## Appendix — data-preserving cutover (future)

Not needed for this cutover. Kept as a reference for the next time
the platform moves hosts with paying customers on it. The steps
below assume `ENCRYPTION_KEY` is copied to the new host and Stripe
subscriptions stay active through the flip.

### Data-preserving steps

1. Announce maintenance window. Set `cancel_at_period_end = true`
   if you want to let subs drain, OR keep them running and let the
   new host pick them up.
2. `pg_dump` platform schema from old host:
   ```bash
   docker exec xray-postgres pg_dump -U xray -d xray \
     --schema=platform --no-owner --no-privileges \
     -Fc -f /tmp/platform-snapshot.dump
   docker cp xray-postgres:/tmp/platform-snapshot.dump .
   ```
3. Ship dump to new host; `pg_restore` into fresh Postgres:
   ```bash
   docker exec xray-postgres pg_restore -U xray -d xray \
     --clean --if-exists /tmp/platform-snapshot.dump
   ```
4. Run `migrations/probes/probe-rls-cross-tenant.sql` — expect
   `PROBE PASS`. Any leak blocks the flip.
5. `rsync -a vps-old:/var/lib/xray/uploads/ vps-new:/var/lib/xray/uploads/`
6. Rotate fan-out secret; update n8n.
7. Re-register Stripe webhook; update signing secret in `.env`.
8. Update OAuth redirect URIs per provider.
9. DNS flip.
10. Smoke: health check, billing page for one tenant, dashboard
    render for another.
11. Leave `vps-old` in read-only mode for 7 days. Decommission.

### Critical invariants for the data-preserving path

- `ENCRYPTION_KEY` MUST match between hosts — decrypt throws on
  mismatch (step 6 v strict mode).
- `tenants.id`, `tenants.stripe_customer_id`, and
  `billing_state.stripe_subscription_id` round-trip through
  `pg_dump`. Without these, Stripe customer ↔ XRay tenant linkage
  breaks and tenants get double-billed on re-subscribe.
- Bridge secrets (`dashboards.bridge_secret`) round-trip encrypted.
  n8n's JWT Auth nodes continue to verify against the same secrets
  because the envelope decrypts identically on both hosts.

### Failure mode — mass "Needs reconnect"

If every tenant's dashboards immediately show the needs-reconnect
pill after the flip, the most likely cause is an `ENCRYPTION_KEY`
mismatch between hosts. `decryptSecret` now throws rather than
silently passing plaintext through (step 6 v), and the OAuth
scheduler interprets the throw as exhausted retries → flips every
connection to `status='error'` → broadcasts
`integration:needs_reconnect`. Fix: verify env var on the new
host, redeploy, watch for refreshes on the next scheduler tick.
