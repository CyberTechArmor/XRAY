# XRay VPS Bridge — Step 4c kickoff

Paste this as the next session's opening prompt.

---

## Role

You are implementing a small followup to step 4b (Global dashboards
+ fan-out + per-tenant share for Globals). Step 4b shipped its core
scope, but user testing on the VPS surfaced four post-deploy bugs.
Step 4c cleans them up before step 5 (onboarding / Stripe polish)
gets a fresh context.

None of these are schema-blocking; the shape of the system is right.
They're loose ends in the UI wiring + one missing real-time path.

## Current step

**Step 4c — Post-step-4b cleanup.** Four concerns, in order of
likely effort:

1. **Edit-dashboard loses the Integration selection.** Opening an
   existing dashboard with `integration='housecall_pro'` leaves the
   Integration dropdown on "Custom (no auth)".
2. **Dashboard list doesn't refresh in real-time when a tenant
   connects/disconnects an integration.** The render-path
   connection-gate works (step 4b issue 2 fix), but the UI doesn't
   reflect the new state until the user manually navigates. All
   users of the tenant need to see the change live.
3. **Sharing a Global dashboard still throws "Dashboard not found."**
   Migration 028 + per-tenant `dashboard_shares` shipped in 4b
   commit `efa639e`; something in the request flow is still hitting
   a 404. Diagnose, fix, verify.
4. **Replace every browser `alert()` / `confirm()` with the in-app
   modal component.** User-visible consistency; the current system
   already has `.modal-overlay` / `.modal` styles (see
   `#loginModal` in `frontend/index.html`) — extract a small
   wrapper and swap call sites.

## Critical context to read before planning

- `CONTEXT.md` at the repo root — complete step-1 → step-4b handoff.
  The step-4b section explains the Global-dashboard model
  (integration-gated visibility + per-tenant render tokens +
  per-tenant share tokens via `platform.dashboard_shares`).
- `.claude/step-4b-kickoff.md` — original 4b scope + open-question
  decisions. Still useful for understanding why per-tenant share
  has the shape it does.
- `.claude/pipeline-hardening-notes.md` — invariants. Step 4c does
  NOT touch pipeline hardening.

## Known facts per bug

### (1) Edit loses the Integration selection

The `admin_builder` view's edit loader (in `frontend/bundles/general.json`)
does:

```js
var intEl = container.querySelector('#build-integration');
if (intEl) intEl.value = d.integration || '';
// ... then Scope radio restore + updateBuilderIntegrationStatus()
```

Race condition: `loadBuilderIntegrations()` populates `<option>`
elements asynchronously via `/api/connections/my-integrations`. If
the edit loader runs BEFORE the populate resolves, `intEl.value =
'housecall_pro'` silently no-ops (you can't set a `<select>`'s
value to an option string that doesn't exist yet). Then when
`loadBuilderIntegrations` finishes and grabs `current = sel.value`,
`current` is empty and no restoration happens.

Fix shape (verify before implementing): make the edit loader wait
for `loadBuilderIntegrations()`'s promise to resolve before setting
`intEl.value`. One clean path is to have `loadBuilderIntegrations`
accept an optional `preferredValue` argument that lands as the final
`sel.value` after the rebuild.

### (2) Real-time integration connect/disconnect via WebSocket

The WS infrastructure is already in place (`server/src/ws.ts`,
`broadcastToTenant` is used by e.g. `PATCH /dashboards/:id/share`
which already fires `dashboard:share-changed`). Need two pieces:

**Server**: broadcast after every integration state change:

- `GET /api/oauth/callback` (new OAuth connect / reconnect):
  `broadcastToTenant(claims.t, 'integration:connected', { slug })`.
- `POST /api/connections/api-key/:slug` (API-key connect):
  `broadcastToTenant(tenantId, 'integration:connected', { slug })`.
- `POST /api/connections/disconnect/:slug`:
  `broadcastToTenant(tenantId, 'integration:disconnected', { slug })`.
- Any route that flips `connections.status = 'error'` via the
  scheduler should also broadcast `integration:needs_reconnect`
  (less urgent; can skip for 4c if it complicates scope).

**Frontend**: the `dashboard_list` view JS subscribes to those
events and calls its existing `load()` function to re-fetch the
list + the integrations strip. `frontend/app.js` already has a
`subscribeToTenant(event, handler)` pattern — grep for
`dashboard:share-changed` to find the wiring precedent.

Acceptance: user on tenant A window 1 clicks Connect on HCP →
window 2 (same tenant, different user) sees the HCP Globals appear
WITHOUT reloading. Clicks Disconnect → they disappear live.

### (3) Global-share still 404s

Migration 028 shipped in 4b. Diagnose first — don't guess. Check
in order:

1. `docker compose exec postgres psql -U xray -d xray -c '\dt
   platform.dashboard_shares'` — confirm the table exists on the
   VPS. Migration 028 could have silently failed like 024 did on
   the first deploy.
2. `docker compose logs server --tail 200` after reproducing the
   error — find the actual stack trace. "Dashboard not found" is
   the message on several code paths in `dashboard.service.ts`;
   the exact call site tells you everything.
3. Open browser Network tab, click Share on a Global, inspect the
   failing request (likely `POST /api/dashboards/:id/share` or
   `PATCH /api/dashboards/:id/share`). The status code + response
   body narrow it down instantly.

Likely suspects (in order of probability):

- Frontend's share button is firing PATCH (toggle is_public) before
  POST (create share link). For a Global with no pre-existing share
  row, the PATCH's UPDATE hits zero rows, then something downstream
  assumes the row exists and throws `DASHBOARD_NOT_FOUND`. Check
  the order of fetches in the frontend share handler
  (`frontend/bundles/general.json`, grep for `/share` in the
  dashboard_list or dashboard builder views).
- `resolveDashboardTenant` returns a nullish value for a platform
  admin viewing a Global when `user.tid` is empty. Happens if the
  admin doesn't belong to any tenant. Edge case but easy to
  reproduce.
- The share page's `/share/:token` route has its own dashboard
  lookup (in `server/src/routes/share.routes.ts`) that may not yet
  check `dashboard_shares` fallback. Step 4b updated
  `getPublicDashboard` in dashboard.service.ts, but if the share
  ROUTE does its own SELECT (bypassing the service), the fallback
  was never applied there.

### (4) Modal wrapper replacing alert/confirm

`frontend/app.js` and `frontend/bundles/general.json` call `alert()`
/ `confirm()` in a handful of places. Grep:

```bash
grep -n 'alert(\|confirm(' frontend/app.js frontend/bundles/general.json
```

Build a small modal API in `frontend/app.js` next to the existing
`toast()` helper:

```js
window.__xrayAlert(message, { title, okLabel }) → Promise<void>
window.__xrayConfirm(message, { title, okLabel, cancelLabel, danger }) → Promise<boolean>
```

Both return promises so existing `if (confirm(...))` call sites
convert cleanly with `await`. Implementation: render a
`.modal-overlay .modal` with the message + OK (+ Cancel) buttons;
resolve/reject the promise on click. Match the existing
`#loginModal` styling so the dark-theme visuals stay consistent.

Swap every call site. Keep messages verbatim unless the new surface
benefits from a title line.

## Working agreement

1. Read `CONTEXT.md`, this kickoff, and `.claude/pipeline-hardening-notes.md`.
2. Plan → wait for approval → implement in small commits. Suggested
   slicing:
   - (i) Fix (1) edit-integration restore.
   - (ii) Fix (3) Global share — diagnose FIRST with the three
     steps above, then fix surgically.
   - (iii) Fix (2) WS connect/disconnect broadcast + frontend
     subscription.
   - (iv) Fix (4) modal wrapper + call-site swaps.

   Order (i)–(iii) gives the user immediate testing value; (iv) is
   polish that can land last.
3. Acceptance checks:
   - `npm test` green — expect no new specs needed for (i) or (3)
     (the edit loader is pure DOM glue; the share flow's contract
     is already locked by 4b). (2) could grow a spec for the
     broadcast hook (DB-backed integration tests are out of scope;
     assert the broadcastToTenant call fires with the right event
     name via a stubbed ws module).
   - `npx tsc --noEmit` clean.
   - E2E on the VPS after `update.sh`:
     - Edit any dashboard with an integration → dropdown shows the
       right integration selected.
     - Two browser windows on same tenant. Window 1 connects HCP →
       window 2's dashboard list live-updates with HCP Globals
       appearing and the "My Integrations" strip flipping to
       "Connected". Disconnect on window 2 → window 1 immediately
       loses the HCP Globals and the strip shows "Connect".
     - Tenant user shares a Global → gets a share URL → opens in
       incognito → dashboard renders under their tenant's creds.
     - No `alert()` / `confirm()` dialogs surface during any flow;
       all prompts are in-app modals matching the rest of the UI.
4. Update `CONTEXT.md` with a short step-4c section at the end
   documenting the four fixes and anything that rolled forward.
   Don't rewrite the step-4b section; append.
5. Step 5 kickoff (`.claude/step-5-kickoff.md`) already exists — if
   any scope from 4c rolls forward (unlikely), add it to step 5's
   "deferred" list.

## Branch

Develop on `claude/xray-step-4c-polish-<suffix>` off `main` once
step 4b's PR merges. If 4b's PR is still open, continue on the same
branch (`claude/xray-tenant-capture-nfgjO`) — the operator will
confirm.

## What step 4c must NOT do

- Introduce any new SQL migration unless one of the four bugs
  genuinely can't be fixed without one. Expected: zero migrations.
- Touch bridge / pipeline / fan-out JWT claim shapes or audiences.
- Touch `oauth-scheduler.ts`.
- Collapse the four `via` values.
- Land any step-5 onboarding polish (signup flow, Stripe UX,
  install-script last-mile, email templates). That's step 5's
  kickoff, not this one.
- Fix platform DB RLS / migrate `withClient` →
  `withTenantContext` / retire the plaintext-read fallback.
  Still step 6.
- Expand the modal wrapper into a general-purpose toast-replacement
  system. Toasts are already fine — only `alert()` / `confirm()`
  get replaced.

## What step 4c inherits

- Per-tenant `dashboard_shares` table lives (migration 028).
- `makePublic` / `makePrivate` branch on scope and handle both
  tenant and global rows.
- `getPublicDashboard` tries `dashboards.public_token` first, falls
  back to `dashboard_shares.public_token`.
- `renderPublicDashboard` uses `sharing_tenant_id` (when present) to
  resolve the sharing tenant's credentials via
  `resolveAccessTokenForRender`.
- URL-required save guard on the builder.
- Connection-gated Global visibility in `listDashboards`.
- WebSocket broadcast infrastructure (`broadcastToTenant`,
  subscription pattern in `frontend/app.js`) already exists and is
  used for `dashboard:share-changed`. Reuse that pattern.

## Head commit on the branch at step-4c start

`efa639e` — "Three step-4b post-deploy fixes: URL-required,
connection-gated Globals, per-tenant share". Ten commits ahead of
main. `npm test` 113/113, `tsc --noEmit` clean.
