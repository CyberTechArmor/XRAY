# Porting the XRay landing-page login flow to another service

This document has two parts:

1. **How the XRay flow actually works** — the reference implementation, as built.
2. **The prompt** — a self-contained brief to hand to Claude (or an engineer)
   working in the *target* service's repo. Fill in the bracketed blanks at the
   top of Part 2 and paste the rest verbatim.

---

# Part 1 — How the XRay flow works today

## 1.1 Shape: one document, no login page

There is no `/login` route. `frontend/index.html` ships a single document
containing two sibling top-level regions plus one overlay:

| Element | Role |
| --- | --- |
| `#landing-screen` | Marketing page — nav, hero, pricing, calculator, footer |
| `#app-shell` | The authenticated SPA (hidden until a session exists) |
| `#loginModal` | Auth overlay, rendered on top of the landing page |

Signing in never navigates. `enterApp()` hides `#landing-screen`, closes the
modal, and reveals `#app-shell`. `logout()` reverses it. The browser stays on
the same URL the whole time.

## 1.2 File split and the division of labor

Per `CLAUDE.md`, the frontend is deliberately split so no single file needs a
full rewrite:

- `index.html` — landing markup + the six auth form blocks inside `#loginModal`
- `landing.css` — modal chrome (`.land-modal-overlay`, `.land-modal`, `.fg`,
  `.btn-p`, `.auth-err`)
- `landing.js` — **presentation only**: `openModal(form)`, `closeModal()`,
  `showLandingForm(name)`. No network calls, no token handling.
- `app.js` — **all** auth logic: the API wrapper, every handler, token state,
  `enterApp()`, `logout()`, boot sequence.

`landing.js:170-188` is the entire modal controller:

```js
window.openModal = function(form) {
  document.getElementById('loginModal').classList.add('active');
  showLandingForm(form || 'login');
  setTimeout(function(){ /* focus land-login-email */ }, 300);
};
window.closeModal = function() {
  document.getElementById('loginModal').classList.remove('active');
};
window.showLandingForm = function(name) {
  var forms = ['land-login','land-signup','land-setup','land-verify',
               'land-tenant-picker','land-totp'];
  forms.forEach(function(f) {
    var el = document.getElementById(f);
    if (el) el.style.display = (f === 'land-' + name) ? '' : 'none';
  });
};
```

Visibility is a CSS class on the overlay (`.active` toggles opacity +
`pointer-events`), and step selection is `display:none` on five of six sibling
divs. That's the whole state machine on the presentation side.

## 1.3 The six steps

All six live inside `#loginModal` (`index.html:113-180`):

| Div | Purpose | Entered from |
| --- | --- | --- |
| `land-login` | Email → "Send me a code", plus passkey button | `openModal('login')` |
| `land-signup` | Name + email + org → creates tenant | Link from login |
| `land-setup` | First-boot admin, no email verification | Auto on first boot |
| `land-verify` | 6-digit code entry | After login/signup |
| `land-tenant-picker` | Multi-tenant org selection | When `tenants.length > 1` |
| `land-totp` | MFA verify **or** enroll (same div, two modes) | When `mfa_required` |

## 1.4 The three-shape response contract (the core idea)

This is the part worth copying. Every *terminal* auth endpoint —
`/verify`, `/verify-token`, `/select-tenant`, `/login/complete`,
`/passkey/complete` — returns exactly one of three `data` shapes:

```js
{ mfa_required: 'verify'|'enroll', mfa_token: '...' }   // second factor needed
{ tenants: [{id,name,role}, ...], email: '...' }        // ambiguous org
{ accessToken: '...', sessionId: '...' }                // done
```

And every client call site branches in the **same fixed order**:

```js
if (d.data.mfa_required) { showMfaStep(d.data.mfa_required, d.data.mfa_token); return; }
if (d.data.tenants && d.data.tenants.length > 1) { showTenantPicker(d.data.tenants, d.data.email); return; }
accessToken = d.data.accessToken;
enterApp();
```

Because the shapes are uniform, adding a step (MFA was added at step 9, tenant
picking earlier) required **no change to existing call sites** — only a new
branch and a new form div. On the server, `isMfaPending()` and
`sendMfaPending()` (`auth.routes.ts:44-58`) are shared by all five routes.

## 1.5 Token model

| Token | Where it lives | Lifetime |
| --- | --- | --- |
| Access token | **In-memory JS variable only** (`var accessToken`) — never `localStorage`/`sessionStorage` | 15 min |
| Refresh token | `httpOnly` cookie, `SameSite=Lax`, `path=/api/auth`, `Secure` in prod | 7 days |
| CSRF token | `xsrf_token` cookie, path `/`, **not** httpOnly, HMAC-signed | Reissued with every refresh |

`sendTokenPair()` (`auth.routes.ts:19-40`) is the single issuance point: it sets
the refresh cookie, issues the CSRF cookie, and returns the access token in the
JSON body. Every successful auth path funnels through it.

Because the access token is memory-only, a page reload always starts logged out
and is recovered by the cookie-based refresh in `init()` — an XSS payload can't
read a token out of storage.

## 1.6 The API wrapper (`app.js:1159-1226`)

```
_fetch(method, url, body):
  credentials: 'include'
  Authorization: Bearer <accessToken>   (if present)
  X-CSRF-Token: <value of xsrf_token cookie>   (set unconditionally; server
                                                ignores it on GET/HEAD)
  on 401 (and we had sent a token):
    if accessToken changed while in flight  → retry with the new one
    else api.refresh():
      success → retry once
      fail    → logout()
```

`refresh()` has two guards that matter: a **mutex** (`_refreshPromise`) so N
concurrent 401s trigger one refresh, and a **5-second debounce** so a
just-completed refresh isn't repeated. A proactive timer also refreshes every
12 minutes and only calls `logout()` after **3 consecutive** failures, so a
transient network blip doesn't eject the user.

## 1.7 Boot sequence (`app.js:2927-2942`)

```js
function init() {
  checkOauthReturnParams();            // ?connected= / ?oauth_error= → toast + strip
  if (checkUrlToken()) return;         // ?token= → POST /verify-token, strip query
  api.refresh().then(function(ok) {    // silent cookie-based session restore
    if (ok) { enterApp(); return; }
    fetch('/api/auth/setup')           // no session → is this a fresh install?
      .then(r => r.json())
      .then(d => { if (d.data.setupRequired) openModal('setup'); });
  });
}
```

Three outcomes: resume the session silently, open the first-boot setup form, or
leave the visitor on the marketing page with the modal closed. The landing page
is the logged-out state — there is nothing to redirect to.

`checkUrlToken()` handles emailed magic-link clicks: it hides the landing page
first (so the user doesn't see a flash of marketing), POSTs the token, and
branches through the same three shapes. On failure it *re-shows* the landing
page, opens the login form, and renders a "Send a new link" button — never a
blank page.

## 1.8 Error UX — recoverable by design

`showVerifyError()` (`app.js:1826-1866`) and `showMagicLinkExpiredOnLogin()`
(`app.js:2089-2135`) inject an inline **button**, not just red text, when the
error code is `MAGIC_LINK_EXPIRED`, `MAGIC_LINK_USED`, `INVALID_TOKEN`, or
`MAX_ATTEMPTS`. Clicking it re-posts to whichever endpoint started the flow —
`pendingFlow === 'signup' ? '/api/auth/signup' : '/api/auth/magic-link'` — so
the user retypes nothing. That's what `pendingEmail` / `pendingFlow` exist for.

Two independent attempt counters are surfaced:

- **Per-link**: `max_attempts` column (migration 033). `attempts_remaining`
  rides in `error.details` and is appended as "(N attempts left)".
- **Per-email / 24h**: DB-backed ledger in `platform.auth_attempts`
  (migration 035). Hard 429 at 20 failures; a warning bar renders at ≤10
  remaining. It's in Postgres, not memory, specifically so a container restart
  doesn't reset an attacker's bucket.

## 1.9 Anti-enumeration and the bootstrap escape hatch

`initiateLogin()` returns the identical `"If an account exists, a login link has
been sent."` whether or not the email resolves to a user.

The one deliberate exception: when SMTP is unconfigured **and** the email
matches `ADMIN_EMAIL`, the response includes `bootstrap_code`. The client
auto-fills the code field and replaces the "check your email" copy with a
"SMTP not configured" notice. This is what makes a fresh install completable
before mail works — and it's audit-logged (`auth.bootstrap_code_emitted`).

## 1.10 Server envelope

Success: `{ ok: true, data: {...}, meta: { request_id, timestamp } }`
Failure: `{ ok: false, error: { code, message, details? } }`

The client keys behavior off `error.code` (a stable machine string), never off
`error.message`.

---

# Part 2 — The prompt

> Fill in the blanks, then paste everything below the line into the target
> service's repo session.

**Blanks to fill:**
- `<SERVICE>` — the target service's name
- `<REPO_PATH>` — where its frontend lives
- `<BRAND>` — product name shown in the modal
- `<TENANCY>` — `multi-tenant` or `single-tenant` (drop the tenant picker if single)
- `<MFA>` — `required`, `optional`, or `none` (drop the TOTP step if none)

---

## PROMPT

I want `<SERVICE>` to use the same authentication flow that XRay BI uses on its
landing page. Below is the full specification of that flow. Implement it in
`<REPO_PATH>` (and the corresponding API), adapted to this codebase's existing
conventions — do **not** copy XRay's file names or CSS wholesale if this repo
already has its own patterns. Match the *behavior and contracts*, not the
styling.

### Goal

A visitor lands on the marketing page. Signing in happens in a **modal overlay
on that same page** — no `/login` route, no navigation. When auth succeeds the
landing page hides and the app shell appears in place. Logging out reverses it.
A returning visitor with a valid session cookie is silently restored into the
app on page load without ever seeing the modal.

### 1. Structure

Single HTML document with three regions:

- `#landing-screen` — the existing marketing page
- `#app-shell` — the authenticated application, `display:none` initially
- `#loginModal` — a fixed-position overlay containing all auth steps

Split the code so no file needs a wholesale rewrite to change one concern:

- **Presentation module** (landing JS): owns `openModal(form)`, `closeModal()`,
  `showLandingForm(name)` and nothing else. No `fetch`, no token variables.
- **App module**: owns the API wrapper, every auth handler, token state,
  `enterApp()`, `logout()`, and the boot sequence.

The modal overlay toggles a single `.active` class (opacity + `pointer-events`).
Step selection sets `display` on sibling divs — exactly one visible at a time.
Also wire: Escape closes the modal, clicking the backdrop (but not the panel)
closes it, and `popstate` closes it rather than navigating away.

### 2. Steps

Create one div per step inside the modal:

| Step | Fields | Notes |
| --- | --- | --- |
| `login` | email | primary button + passkey button + link to signup |
| `signup` | name, email, org | link back to login |
| `setup` | name, email, org | first-boot admin; no email verification |
| `verify` | 6-digit code | centered, `letter-spacing`, `inputmode="numeric"`, `autocomplete="one-time-code"` |
| `tenant-picker` | list of orgs | omit if `<TENANCY>` is single-tenant |
| `totp` | code, or QR + code | omit if `<MFA>` is none; one div serves both verify and enroll modes |

Every step needs its own error element. Every text input binds Enter to its
step's primary button. Buttons disable while a request is in flight and
re-enable in a `finally`.

### 3. The response contract — implement this exactly

Every endpoint that can *terminate* authentication must return one of exactly
three `data` shapes:

```js
{ mfa_required: 'verify'|'enroll', mfa_token: '...' }   // second factor needed
{ tenants: [{id, name, role}, ...], email: '...' }      // org selection needed
{ accessToken: '...', sessionId: '...' }                // session issued
```

Every client call site branches in this **fixed order**:

```js
if (d.data.mfa_required) { showMfaStep(d.data.mfa_required, d.data.mfa_token); return; }
if (d.data.tenants && d.data.tenants.length > 1) { showTenantPicker(d.data.tenants, d.data.email); return; }
accessToken = d.data.accessToken;
enterApp();
```

This uniformity is the point: a future step is added by introducing one new
shape and one new branch, without touching existing call sites. On the server,
write **one** `sendTokenPair()` helper and **one** `sendMfaPending()` helper and
route every path through them — never hand-roll a session response.

### 4. Endpoints

```
GET  /api/auth/setup             → { setupRequired: boolean }
POST /api/auth/setup             → session          (first boot, no email step)
POST /api/auth/signup            → { message }      (sends code)
POST /api/auth/magic-link        → { message, bootstrap_code? }
POST /api/auth/verify            → one of the three shapes   { email, code }
POST /api/auth/verify-token      → one of the three shapes   { token }
POST /api/auth/select-tenant     → session | mfa_pending     { email, tenantId }
POST /api/auth/passkey/begin     → WebAuthn request options
POST /api/auth/passkey/complete  → session | mfa_pending
POST /api/auth/totp/enroll       → { qr_data_url, secret, otpauth_url }
POST /api/auth/totp/confirm      → { confirmed, backup_codes, accessToken }
POST /api/auth/totp/verify       → session
POST /api/auth/refresh           → session          (refresh cookie only)
POST /api/auth/logout            → clears cookies
```

Response envelope everywhere:

```js
{ ok: true,  data: {...}, meta: { request_id, timestamp } }
{ ok: false, error: { code, message, details? } }
```

The client must branch on `error.code` — a stable machine string — never on
`error.message`.

### 5. Token model — non-negotiable

- **Access token: in-memory JavaScript variable only.** Never `localStorage`,
  never `sessionStorage`, never a readable cookie. ~15 minute lifetime.
- **Refresh token: `httpOnly` cookie**, `SameSite=Lax`, `Secure` in production,
  scoped by `path` to the auth route prefix, ~7 day lifetime.
- **CSRF token: a separate readable cookie**, path `/`, HMAC-signed
  server-side, reissued alongside every refresh cookie.

Consequence: a page reload always begins unauthenticated and is recovered via
the refresh cookie. This is deliberate — an XSS payload has no token to steal.

### 6. API wrapper

Write one `fetch` wrapper used by every call in the app:

- `credentials: 'include'` on every request
- `Authorization: Bearer <accessToken>` when a token exists
- `X-CSRF-Token` mirrored from the readable CSRF cookie on every request
  (harmless on GET; the server skips the check for safe methods)
- On `401` where a token *was* sent:
  - if `accessToken` changed while the request was in flight (a concurrent call
    already refreshed) → retry with the new token
  - otherwise call `refresh()`; on success retry once, on failure `logout()`
- `refresh()` needs a **mutex** so N concurrent 401s cause one refresh, and a
  **~5s debounce** so a just-completed refresh isn't repeated
- A proactive timer refreshes on an interval comfortably shorter than the access
  token lifetime (12 min for a 15 min token), and only logs out after **3
  consecutive** failures — a single network blip must not eject the user

### 7. Boot sequence

```
init():
  handle any OAuth return params (toast the outcome, strip the query string)
  if URL has ?token=  → hide landing, POST /verify-token, strip query,
                        branch through the three shapes; on failure re-show
                        landing + open login with a "Send a new link" button
  else → POST /refresh
           success → enterApp()
           failure → GET /setup; if setupRequired, openModal('setup')
                     otherwise leave the visitor on the marketing page
```

`enterApp()`: hide landing, close modal, show app shell, `GET /users/me`, build
the navigation, start the refresh timer.

`logout()`: stop timers, close sockets, POST `/logout`, null out `accessToken`
and user state, show landing, hide app shell. **No page reload.**

### 8. Error UX — every failure must be recoverable in place

When verification fails with a retryable code (`MAGIC_LINK_EXPIRED`,
`MAGIC_LINK_USED`, `INVALID_TOKEN`, `MAX_ATTEMPTS`), render an inline
**button**, not just red text. Clicking it re-sends the code to the address
already captured — the user retypes nothing.

To make that work, track two variables from the moment a code is requested:
`pendingEmail` and `pendingFlow` (`'login'` vs `'signup'`). The resend button
posts to whichever endpoint originated the flow.

Surface two independent attempt counters:

- **Per-link**: an `attempts_remaining` field in `error.details`, appended to
  the message as "(N attempts left)".
- **Per-identifier, rolling 24h**: a **database-backed** failure ledger. Hard-
  reject with `429` at the limit; render a warning bar at a lower threshold.
  Store it in the DB, not in memory — an in-memory counter resets on every
  deploy, which hands an attacker a trivial bypass.

### 9. Security requirements

- **No user enumeration.** The magic-link endpoint returns the identical
  message whether or not the address resolves to an account.
- **Codes are single-use and short-lived** (~10 min), with a per-link attempt
  cap enforced server-side.
- **CSRF**: double-submit cookie on all state-changing methods. Skip the check
  for GET/HEAD, for `Authorization: Bearer` requests (a cross-origin page can't
  set that header without a CORS preflight), and for the unauthenticated
  bootstrap endpoints (signup / verify / magic-link / passkey begin+complete /
  setup) — those run *before* any CSRF cookie can exist and hold no session to
  leverage. Document each exemption inline with its reasoning.
- **First-boot bootstrap escape hatch**: when mail delivery is unconfigured and
  the address matches the configured admin address, return the verification code
  inline in the response so a fresh install can be completed. Auto-fill it into
  the code field, replace the "check your email" copy with an explicit "mail is
  not configured" notice, and **audit-log every emission**.

### 10. Acceptance criteria

- [ ] Signing in never changes the URL or reloads the page
- [ ] A returning visitor with a valid refresh cookie lands in the app without
      seeing the modal
- [ ] Hard-reloading while signed in restores the session silently
- [ ] The access token appears nowhere in `localStorage`, `sessionStorage`, or
      any readable cookie
- [ ] An expired code shows an inline resend button that works without retyping
      the email
- [ ] Ten concurrent API calls hitting `401` trigger exactly **one** refresh
- [ ] A single failed background refresh does not log the user out; three
      consecutive failures do
- [ ] Clicking an emailed link goes straight into the app, with the token
      stripped from the URL
- [ ] A failed emailed link shows the login form with a "send a new link"
      button — never a blank page
- [ ] The magic-link response is byte-identical for known and unknown addresses
- [ ] With mail unconfigured, a first-boot admin can complete sign-in end to end
- [ ] Escape, backdrop click, and browser Back all close the modal without
      navigating
- [ ] Every step's primary button is reachable by pressing Enter in its inputs

### 11. Deliberately out of scope

Do **not** port XRay's specifics unless `<SERVICE>` genuinely needs them: the
session-replay recording, the impersonation banner and `imp` JWT claim, the
policy re-acceptance gate, WebSocket reconnection on token swap, or push-
notification unsubscribe on logout. Port the **auth flow** — the modal state
machine, the three-shape response contract, the token model, the API wrapper's
refresh semantics, and the recoverable error UX.

## END PROMPT
