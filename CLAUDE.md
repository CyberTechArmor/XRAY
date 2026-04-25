# XRay BI

## Frontend Architecture

The frontend is split into separate files to prevent Claude Code timeouts on large rewrites:

- `frontend/index.html` — HTML shell: landing page markup (nav, hero, pricing, calculator, footer), auth modal, app shell. Loads external CSS/JS + Three.js CDN.
- `frontend/app.css` — Base styles, variables, buttons, cards, tables, modals, app layout, toasts, sidebar.
- `frontend/app.js` — Core app logic: API helper, auth flows (login/signup/setup/verify/passkey), sidebar, view routing, bundle loader.
- `frontend/landing.css` — Landing page styles: nav, hero, pricing steps, calculator, footer, auth modal overlay.
- `frontend/landing.js` — Landing page JS: modal open/close, calculator logic, Three.js hero scene (spreadsheet/dashboard scanner animation).
- `frontend/bundles/` — JSON view bundles loaded at runtime.

### Editing Guidelines

- **To update landing page design/copy/animations**: Edit `landing.css` and/or `landing.js` and the `#landing-screen` section in `index.html`. Do NOT rewrite the entire `index.html`.
- **To update auth forms**: Edit the auth modal HTML in `index.html` (inside `#loginModal`) and auth styles in `landing.css` (`.land-modal` rules).
- **To update app logic**: Edit `app.js`.
- **To update app styling**: Edit `app.css`.
- **Never inline all CSS/JS back into index.html** — the file split exists to prevent Claude Code timeouts on large rewrites.

### Auth Flow

- Auth uses a modal overlay (`#loginModal`) on the landing page, not a separate page.
- Forms: `land-login`, `land-signup`, `land-setup`, `land-verify` (IDs within the modal).
- Login email input ID: `land-login-email`.
- `showLandingForm(name)` switches between forms. `openModal(form)` / `closeModal()` control visibility.
- First-boot setup auto-opens the modal with the setup form.

## Server

- Express API server in `server/src/`
- PostgreSQL database, schema in `init.sql`
- Auth: magic link + passkey (WebAuthn)
- Multi-tenant with RLS

### Database context helpers (step 6)

Three helpers live in `server/src/db/connection.ts`. Pick the right
one for every new code path that touches the platform DB:

- **`withTenantContext(tenantId, fn)`** — the default. Sets
  `app.current_tenant = tenantId` AND `app.is_platform_admin = 'false'`
  so the `tenant_isolation` RLS policy on every `platform.*` table
  gates the query. Use whenever `tenantId` is available (tenant-scoped
  routes, services called with a known tenant).
- **`withAdminClient(fn)`** — opt-in platform-admin bypass. Sets
  `app.is_platform_admin = 'true'` so the `platform_admin_bypass`
  policy lets queries see every tenant's rows. Use for genuinely
  cross-tenant paths: admin UI, Stripe webhook reverse-lookups, fan-out
  dispatch iterating connected tenants, admin-only audit reads.
- **`withClient(fn)`** — plain pool checkout, no context set. Use for
  unauthenticated / bootstrap paths only: magic-link token lookup,
  first-boot setup, `platform_settings` reads (global, no RLS).

`withTenantTransaction` / `withAdminTransaction` are BEGIN/COMMIT
analogues of the first two.

Guardrails:

- **New code defaults to `withTenantContext`.** If you're tempted to
  use `withAdminClient` on a path that takes a `tenantId`, stop and
  use `withTenantContext` instead — bypass is opt-in by design.
- **Never write `withClient(...) + set_config('app.is_platform_admin', 'true')`**
  inline. That was the pre-step-6 pattern; it's superseded by
  `withAdminClient`. A local `bypassRLS` helper in a service file
  is the same anti-pattern.
- **Retiring `withClient`** is ongoing. See
  `.claude/withclient-audit.md` for the current roster.
  Post-step-7 the allow-list is stable and enforced by
  `scripts/check-withclient-allowlist.sh` (run via the pre-commit hook
  at `.githooks/pre-commit`; enable once per clone with
  `git config core.hooksPath .githooks` — same enable command also
  arms the step-8 gitleaks staged-index scan). Only these files may call
  `withClient()` directly:
  `db/connection.ts`, `services/auth.service.ts`,
  `services/settings.service.ts`, `services/email.service.ts`,
  `services/email-templates.ts`, `services/meet.service.ts`,
  `services/rbac.service.ts`, `services/role.service.ts`,
  `services/tenant.service.ts`, `services/policy.service.ts`. All
  touch carve-out / unauth paths. (Step 11 added `policy.service.ts`
  for the `policy_documents` public-read carve-out backing
  `/api/legal/<slug>`.)
- **RLS policies live in `init.sql` + `migrations/*.sql`.** Any new
  tenant-scoped table needs a `tenant_isolation` policy and a
  `platform_admin_bypass` policy before the application layer starts
  reading or writing under `withTenantContext`. See migration 029
  for the canonical shape.

### Encrypted columns (step 6 v)

Secret columns (`connections.api_key`, `connections.oauth_*_token`,
`dashboards.bridge_secret`, `integrations.client_secret`,
`webhooks.secret`) are stored under the `enc:v1:` envelope, enforced
by DB triggers (migration 017+). The `decryptSecret` /
`decryptJsonField` helpers in `server/src/lib/encrypted-column.ts`
**throw** on plaintext input — they no longer silently pass it
through. A plaintext row reaching decrypt is a bug signal (missed
backfill, direct DB write, disabled trigger), not a case to recover
from in application code.
