# XRay BI Platform

Multi-tenant business intelligence platform with real-time dashboards, embeddable views, API-driven data pipelines, and built-in video conferencing.

## Features

- **Multi-tenant architecture** — Row-Level Security (RLS) isolates every tenant at the database level
- **Dashboard builder** — Upload HTML/CSS/JS views, configure data sources with refresh cadences
- **Embeddable dashboards** — Token-secured iframes for embedding in external sites
- **API key & webhook system** — Connect n8n, Zapier, or any external pipeline via bearer tokens and per-connection webhooks
- **MEET video conferencing** — Floating in-app video calls with fullscreen, picture-in-picture, and minimized modes
- **WebAuthn/Passkey authentication** — Passwordless login with magic links and passkey support
- **RBAC permission system** — Granular roles and permissions with platform admin bypass
- **Stripe billing** — Plan tiers, dashboard limits, and customer portal integration
- **Audit logging** — Every sensitive action recorded with user, action, and resource context
- **One-command deployment** — Install script handles Docker, Nginx, TLS, secrets, and health checks

## Architecture

```
┌──────────────┐     ┌──────────────┐     ┌──────────────────┐
│   Browser    │────>│    Nginx     │────>│   Node/Express   │
│  (SPA + JS   │     │  (TLS, rate  │     │   (TypeScript)   │
│   bundles)   │     │   limiting)  │     │                  │
└──────────────┘     └──────────────┘     └────────┬─────────┘
                                                   │
                                          ┌────────v─────────┐
                                          │  PostgreSQL 16   │
                                          │  (RLS, platform  │
                                          │   schema)        │
                                          └──────────────────┘
```

- **Frontend**: JSON bundles (HTML/CSS/JS per view) served as static files, rendered by a lightweight SPA shell
- **Backend**: Express/TypeScript API with JWT + API key auth, Zod validation, and service-layer architecture
- **Database**: PostgreSQL 16 with `platform` schema, Row-Level Security, and per-tenant warehouse schemas (`tn_<uuid>`)
- **Reverse proxy**: Nginx with rate limiting, gzip, WebSocket support, and TLS via Let's Encrypt

## Quick Start (Development)

```bash
# 1. Clone and install dependencies
git clone <repo-url> && cd XRAY/server
npm install

# 2. Start PostgreSQL (Docker)
docker run -d --name xray-pg \
  -e POSTGRES_DB=xray \
  -e POSTGRES_USER=xray \
  -e POSTGRES_PASSWORD=devpassword \
  -p 5432:5432 \
  -v $(pwd)/../init.sql:/docker-entrypoint-initdb.d/init.sql \
  postgres:16-alpine

# 3. Configure environment
cp ../.env.example ../.env
# Edit .env with your DATABASE_URL, JWT_SECRET (64 chars), ENCRYPTION_KEY (64 hex chars)

# 4. Run migrations and seed
npm run migrate
npm run seed

# 5. Start dev server
npm run dev
```

The API will be available at `http://localhost:3000`.

## Production Deployment

### One-Command Install

```bash
sudo bash install.sh
```

The install script handles everything:

| Step | Action |
|------|--------|
| 1 | Install Docker CE + Compose plugin |
| 2 | Install Nginx |
| 3 | Interactive config (domain, email, port, embed subdomain) |
| 4 | Generate secrets (JWT 64-char, encryption 256-bit hex, DB password 32-char) |
| 5 | Write `.env` file (chmod 600) |
| 6 | Configure Nginx from template (rate limiting, security headers, proxy) |
| 7 | Optional TLS via Let's Encrypt (certbot) |
| 8 | `docker compose up -d --build` |
| 9 | Health check polling (`/api/health` every 2s, 60s timeout) |
| 10 | Summary with URLs and next steps |

### Uninstall

```bash
sudo bash uninstall.sh
```

6-step teardown with confirmation prompts: containers (optional volume deletion), images, Nginx config, TLS certs, `.env` (securely overwritten before deletion), and project directory.

### Manual Docker Deployment

```bash
# Copy and edit environment
cp .env.example .env
# Edit .env with your values

# Build and start
docker compose up -d --build

# Check health
curl http://localhost:3200/api/health
```

## Project Structure

```
XRAY/
├── install.sh                 # One-command production installer
├── uninstall.sh               # Clean teardown script
├── docker-compose.yml         # Docker services (server + postgres)
├── init.sql                   # Database schema, RLS policies, indexes
├── .env.example               # Environment template
├── nginx/
│   ├── xray.conf.template     # Nginx config with placeholders
│   └── ssl-params.conf        # TLS hardening (1.2+1.3, HSTS, OCSP)
├── frontend/
│   └── bundles/
│       └── general.json       # All UI views (HTML/CSS/JS per view)
└── server/
    ├── Dockerfile             # Two-stage build (builder + production)
    ├── package.json
    ├── tsconfig.json
    └── src/
        ├── index.ts           # Express app, middleware, route mounting
        ├── config.ts          # Environment config with validation
        ├── db/
        │   ├── connection.ts  # Pool, withClient, withTransaction
        │   ├── migrate.ts     # Migration runner
        │   └── seed.ts        # Permissions, settings, email templates
        ├── lib/
        │   ├── crypto.ts      # AES-256-GCM encryption, token hashing
        │   ├── validation.ts  # Zod schemas for all endpoints
        │   └── webauthn.ts    # SimpleWebAuthn v10 wrapper
        ├── middleware/
        │   ├── auth.ts        # JWT + API key authentication
        │   ├── rbac.ts        # Permission-based route protection
        │   ├── rate-limit.ts  # Rate limiters (auth, API, magic link)
        │   └── error-handler.ts  # Centralized error handling
        ├── routes/            # 15 route files (auth, admin, apikey,
        │   └── ...            #   webhook, meet, dashboard, data, etc.)
        └── services/          # 18 service files matching each route
            └── ...
```

## API Reference

All responses follow the format:
```json
{
  "ok": true,
  "data": { },
  "meta": { "request_id": "...", "timestamp": "..." }
}
```

### Authentication

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/api/auth/signup` | None | Create account + tenant |
| POST | `/api/auth/verify` | None | Verify email code |
| POST | `/api/auth/verify-token` | None | Verify magic link token |
| POST | `/api/auth/login/begin` | None | Start passkey login |
| POST | `/api/auth/login/complete` | None | Complete passkey login |
| POST | `/api/auth/magic-link` | None | Send magic link email |
| POST | `/api/auth/recover` | None | Account recovery |
| POST | `/api/auth/refresh` | Cookie | Refresh JWT via cookie |
| POST | `/api/auth/logout` | JWT | End session |

### Dashboards

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/api/dashboards` | JWT | List accessible dashboards |
| GET | `/api/dashboards/:id` | JWT | Get dashboard details |
| POST | `/api/dashboards/:id/access` | JWT | Grant user access |
| DELETE | `/api/dashboards/:id/access/:uid` | JWT | Revoke user access |
| POST | `/api/dashboards/:id/public` | JWT | Toggle public access |
| POST | `/api/dashboards/:id/embed` | JWT | Create embed token |
| DELETE | `/api/dashboards/:id/embed/:eid` | JWT | Revoke embed |

### Data

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/api/data/:dashboardId/:sourceKey` | JWT | Query dashboard data source |

### API Keys

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/api/api-keys` | JWT (admin) | Create API key (returns full key once) |
| GET | `/api/api-keys` | JWT (admin) | List all API keys |
| GET | `/api/api-keys/:id` | JWT (admin) | Get API key details |
| DELETE | `/api/api-keys/:id` | JWT (admin) | Revoke API key |

### Webhooks

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/api/webhooks` | JWT | Create webhook for a connection |
| GET | `/api/webhooks` | JWT | List all webhooks |
| GET | `/api/webhooks/connection/:id` | JWT | List webhooks for connection |
| GET | `/api/webhooks/:id` | JWT | Get webhook details |
| PATCH | `/api/webhooks/:id` | JWT | Update webhook |
| DELETE | `/api/webhooks/:id` | JWT | Delete webhook |
| POST | `/api/webhooks/:id/regenerate-secret` | JWT | Rotate signing secret |
| POST | `/api/webhooks/ingest/:urlToken` | API Key | Push data via webhook |

### MEET Video Conferencing

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/api/meet/config` | JWT | Get MEET server URL |
| POST | `/api/meet/rooms` | JWT | Create meeting room |

### Admin (Platform Admin Only)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/admin/tenants` | List all tenants |
| POST | `/api/admin/tenants` | Create tenant |
| GET | `/api/admin/tenants/:id` | Tenant details with counts |
| POST | `/api/admin/dashboards` | Create dashboard |
| PATCH | `/api/admin/dashboards/:id` | Update dashboard |
| POST | `/api/admin/connections` | Create connection |
| PATCH | `/api/admin/connections/:id` | Update connection |
| POST | `/api/admin/connections/:id/tables` | Register table |
| GET | `/api/admin/settings` | Get platform settings |
| PATCH | `/api/admin/settings` | Update settings |
| GET | `/api/admin/email-templates` | List email templates |
| PATCH | `/api/admin/email-templates/:key` | Update template |
| POST | `/api/admin/email-templates/:key/test` | Send test email |

### Other Endpoints

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/api/health` | None | Health check |
| GET | `/api/bundles` | JWT | Get frontend view bundles |
| GET | `/api/embed/:token` | None | Public embed endpoint |
| GET | `/api/connections` | JWT | List connections |
| GET | `/api/connections/:id` | JWT | Connection details |
| GET/PATCH | `/api/tenants` | JWT | Tenant settings |
| GET/POST/DELETE | `/api/users/*` | JWT | User management |
| GET/POST/DELETE | `/api/roles/*` | JWT | Role management |
| GET/POST/DELETE | `/api/invitations/*` | JWT | Team invitations |
| GET | `/api/audit` | JWT | Query audit log |
| POST | `/api/stripe/webhook` | Signature | Stripe webhook handler |
| GET | `/api/stripe/portal` | JWT | Stripe customer portal |
| GET | `/api/stripe/config` | JWT | Stripe publishable config |

## External Integrations

### API Key Authentication

Generate API keys from the admin panel. Use as Bearer tokens:

```bash
curl -H "Authorization: Bearer xray_abc123..." \
  https://your-domain.com/api/webhooks/ingest/<url-token> \
  -H "Content-Type: application/json" \
  -d '{"event": "data.push", "payload": [...]}'
```

### n8n / Zapier Webhooks

1. Create a connection in the admin panel
2. Create a webhook for that connection (generates unique ingest URL + signing secret)
3. Generate an API key with `webhook.ingest` scope
4. Configure n8n/Zapier to POST to the ingest URL with the API key as Bearer token

### MEET Video Conferencing

1. Configure MEET server URL and API key in admin panel (Settings > MEET)
2. A floating video call button appears for all users
3. Users can start meetings or join by room code
4. Display modes: fullscreen, picture-in-picture (draggable), minimized

## Database Schema

Key tables in the `platform` schema:

| Table | Description |
|-------|-------------|
| `tenants` | Organizations / workspaces |
| `users` | User accounts (per-tenant) |
| `roles` / `permissions` | RBAC system |
| `dashboards` | Dashboard definitions (HTML/CSS/JS views) |
| `dashboard_sources` | Data source configs per dashboard |
| `dashboard_access` | User-level access grants |
| `dashboard_embeds` | Embed tokens with domain restrictions |
| `connections` | Data pipeline connections |
| `connection_tables` | Registered tables per connection |
| `api_keys` | External API keys (SHA256 hashed) |
| `webhooks` | Per-connection ingest webhooks |
| `platform_settings` | Key-value config (secrets encrypted) |
| `audit_log` | Action audit trail |
| `billing_state` | Stripe billing per tenant |

All tenant-scoped tables enforce Row-Level Security via `current_setting('app.current_tenant')` with platform admin bypass.

## Security

- **Authentication**: JWT (15min expiry) + refresh tokens, WebAuthn/Passkey support, API key bearer tokens (`xray_` prefix, SHA256 hashed)
- **Authorization**: RBAC with granular permissions, platform admin bypass
- **Data isolation**: PostgreSQL Row-Level Security on all tenant-scoped tables
- **Encryption**: AES-256-GCM for secrets (SMTP passwords, API keys), 256-bit hex encryption key validated at startup
- **Transport**: TLS 1.2+1.3, HSTS with preload, OCSP stapling
- **Headers**: CSP, X-Frame-Options, X-Content-Type-Options, Referrer-Policy, Permissions-Policy
- **Rate limiting**: Nginx zone-based + Express middleware (auth: 20/15min, API: 200/15min, magic link: 3/hour)
- **Input validation**: Zod schemas on all endpoints, parameterized SQL queries throughout
- **Docker**: Production images run as non-root `node` user, app port bound to 127.0.0.1

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `APP_PORT` | No | Server port (default: 3200) |
| `JWT_SECRET` | Yes | JWT signing secret (64+ chars) |
| `ENCRYPTION_KEY` | Yes | 256-bit hex string (64 hex chars) for AES-256-GCM |
| `DB_HOST` | No | PostgreSQL host (default: postgres) |
| `DB_NAME` | No | Database name (default: xray) |
| `DB_USER` | No | Database user (default: xray) |
| `DB_PASSWORD` | Yes | Database password |
| `RP_NAME` | No | WebAuthn relying party name (default: XRay BI) |
| `RP_ID` | No | WebAuthn RP ID / domain (default: localhost) |
| `ORIGIN` | No | App origin URL (default: http://localhost:3000) |
| `STRIPE_WEBHOOK_SECRET` | No | Stripe webhook signing secret |
| `SMTP_HOST` | No | SMTP server hostname |
| `SMTP_PORT` | No | SMTP port (default: 587) |
| `SMTP_USER` | No | SMTP username |
| `SMTP_PASS` | No | SMTP password |
| `SMTP_FROM` | No | Sender email address |

## License

Proprietary. All rights reserved.
