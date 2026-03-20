# XRay BI

## Frontend Architecture

The frontend is split into separate files for maintainability:

- `frontend/index.html` — Slim HTML shell (landing page markup, auth forms, app shell). Loads external CSS/JS.
- `frontend/app.css` — Base styles, variables, buttons, cards, tables, modals, auth forms, app layout, toasts.
- `frontend/app.js` — Core app logic: API helper, auth flows, sidebar, view routing, bundle loader.
- `frontend/landing.css` — Landing page styles and animations only.
- `frontend/landing.js` — Landing page initialization (particles, button handlers).
- `frontend/bundles/` — JSON view bundles loaded at runtime.

### Editing Guidelines

- **To update landing page design/copy/animations**: Edit `landing.css` and/or `landing.js` and the `#landing-screen` section in `index.html`. Do NOT rewrite the entire `index.html`.
- **To update auth forms**: Edit the auth form HTML in `index.html` and auth styles in `app.css`.
- **To update app logic**: Edit `app.js`.
- **To update app styling**: Edit `app.css`.
- **Never inline all CSS/JS back into index.html** — the file split exists to prevent Claude Code timeouts on large rewrites.

## Server

- Express API server in `server/src/`
- PostgreSQL database, schema in `init.sql`
- Auth: magic link + passkey (WebAuthn)
- Multi-tenant with RLS
