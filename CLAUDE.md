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
