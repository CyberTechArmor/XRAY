# XRay Tenant Owner Guide

You're the Owner of an XRay tenant — typically because you just
signed up, or because your operator invited you. This doc covers
the things an Owner (and teammates with the right permissions) do
day-to-day: inviting teammates, managing billing, connecting data
sources, and grants.

## First time signing in

1. Open the link from your invitation / signup email. Click
   through — XRay verifies the magic link and creates your tenant
   automatically.
2. On the empty dashboard list you'll see an **onboarding
   checklist** with three steps:
   - Connect your first integration
   - Configure billing
   - Invite a teammate

   You can click any of them to jump to the right place. The
   checklist disappears once you dismiss it or render your first
   dashboard.

If a teammate invited you to an existing tenant, you won't see the
checklist — you land straight on the dashboard list.

## Inviting teammates

From the sidebar: **Team → Invite member**.

- Email, name, and role. Roles: **Owner**, **Admin**, **Member**.
- The invitation email expires in 7 days; you can revoke anytime
  from the Team view.
- Your teammate clicks the link, completes passkey / magic-link
  verification, and is added to your tenant.

### Permissions cheat sheet

- **Owner**: everything.
- **Admin** (role flag): can invite teammates, manage connections
  and dashboards. Optional per-user **Billing** flag to manage the
  Billing page.
- **Member**: can see dashboards granted to them.

## Connecting data sources

From the dashboard list view, the **My Integrations** strip
appears when your operator has enabled at least one integration
for the platform. Click the provider name, pick **OAuth** or
**API Key**, and follow the flow:

- **OAuth**: a new window opens to the provider's sign-in page
  (HouseCall Pro, QuickBooks, etc.). Approve access — XRay stores
  the refresh token (encrypted) and keeps access tokens fresh for
  you via a 5-minute scheduler.
- **API key**: paste the key the provider gave you. XRay stores
  the key encrypted.

Once connected, the pill on every relevant dashboard card flips to
**Connected**, and you can render dashboards that depend on that
integration.

### Reconnecting

If you see an amber **Needs reconnect** pill, your token expired
or was revoked. Click **Reconnect** from the My Integrations strip
and run through the OAuth flow again. Your data stays as-is; only
the credential is refreshed.

## Billing

**Billing** in the sidebar (visible to Owner + anyone with the
Billing permission).

What's shown:

- **Status**: Active / Inactive / scheduled-to-cancel.
- **Next billing date** + **days left in cycle**.
- **Your subscriptions** with Cancel / Resume actions.
- **Available plans** — Subscribe opens Stripe's hosted checkout
  in a new tab.
- **Paid invoices** — list with Download PDF links.
- **Manage payment methods** — secondary button opens Stripe's
  billing portal (card updates, receipts).

### Subscribing

Click **Subscribe** (or **Resubscribe** if you had a previous
subscription). A new tab opens Stripe checkout pre-populated with
your tenant's email. Pay → the tab auto-returns to the XRay
Billing page, and your dashboards unlock within a second or two
via WebSocket.

### Cancelling

Click **Cancel subscription** and confirm. Your access continues
until the end of the current billing cycle — we don't deactivate
immediately. During that tail window the button changes to
**Resume subscription** so you can undo the cancellation with one
click.

### Payment failed

If Stripe reports a failed payment, your status switches to
**Past due** and dashboards lock. Click **Manage payment
methods** to update the card in Stripe's portal; once a retry
succeeds, access restores automatically.

### Invoices

Only **paid** invoices appear in the list. Past-due / open
invoices live in Stripe's portal (accessible via the Manage
payment methods button).

## Dashboards and grants

Two types of dashboards appear for you:

1. **Your own** — dashboards created for your tenant. Render,
   edit, share as usual.
2. **Globals** — dashboards built by the platform operator.
   - Integration-backed Globals: you can render these whenever
     you have an active connection to the matching integration.
     No admin grant needed.
   - Custom Globals (no integration): the operator has to
     explicitly grant your tenant access. If you see a Global in
     the admin's catalog but it's not showing up for you, ask
     the operator to grant it.

### Sharing a dashboard publicly

Click the share button on a dashboard card. Three states:

- **Red** — no share link exists. Admins click to create one.
- **Amber** — internal share link (unlisted). Admins can manage.
- **Green** — publicly shared. Any teammate can copy the URL.

You can rotate the link anytime from the share modal. Rotating
immediately kicks anyone currently viewing the old URL — they'll
see a "link has been revoked" screen without a page reload.

## Troubleshooting

### I didn't get the magic link

- Check spam / junk.
- Requesting a second link invalidates the first one. If you've
  triggered it multiple times, only the newest works.
- If nothing arrives after 2–3 minutes, ask your operator to
  check SMTP config in the platform admin panel.

### "Subscription required" after I subscribed

Hard-refresh the page once. The WebSocket unlock should fire
within a second or two of Stripe webhook delivery; if it doesn't,
Stripe's webhook may not have reached XRay yet. If you still
see the paywall 30 seconds later, contact the operator — they
can manually link your Stripe customer from the admin panel.

### Integration shows "Needs reconnect" and I just authorized it

This usually means your OAuth provider revoked the token after a
password change on their end, or the token hit its absolute
expiry (some providers cap refresh tokens at 90 days). Just click
**Reconnect** again — nothing is lost.

### Invitation link expired

The invitation sender can revoke the expired invitation and send
a fresh one from their Team view. 7-day expiry isn't tunable
per-tenant today.

### I can't see the Billing nav

You need the **Billing** permission, or you need to be the Owner.
Ask your Owner to toggle the Billing flag on your user from the
Team view.

### Can't see the Team nav

You need the **Admin** permission. Same deal — ask your Owner.

## What Owners should do monthly

- Scan the **Team** view for stale members; revoke anyone who's
  left.
- Check **Billing → Paid invoices** matches what you see in your
  accounting system.
- If you've rotated a data-source credential outside of XRay
  (e.g. changed an API key in the provider's dashboard), run
  **Disconnect** then **Reconnect** so XRay picks up the new
  credential cleanly.
