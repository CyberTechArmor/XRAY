#!/usr/bin/env bash
set -euo pipefail

# ============================================================
#  XRay BI Platform — Production Install Script
#  Takes a bare server to running production in one command.
#  Run as root:  sudo bash install.sh
# ============================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Colors
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'

banner() {
  echo ""
  echo -e "${CYAN}${BOLD}"
  echo "  ██╗  ██╗██████╗  █████╗ ██╗   ██╗"
  echo "  ╚██╗██╔╝██╔══██╗██╔══██╗╚██╗ ██╔╝"
  echo "   ╚███╔╝ ██████╔╝███████║ ╚████╔╝ "
  echo "   ██╔██╗ ██╔══██╗██╔══██║  ╚██╔╝  "
  echo "  ██╔╝ ██╗██║  ██║██║  ██║   ██║   "
  echo "  ╚═╝  ╚═╝╚═╝  ╚═╝╚═╝  ╚═╝   ╚═╝   "
  echo -e "${NC}"
  echo -e "${BOLD}  XRay BI Platform — Production Installer${NC}"
  echo ""
}

step() { echo -e "\n${GREEN}${BOLD}[$1/11]${NC} ${BOLD}$2${NC}\n"; }
info() { echo -e "  ${CYAN}→${NC} $1"; }
warn() { echo -e "  ${YELLOW}⚠${NC} $1"; }
ok()   { echo -e "  ${GREEN}✓${NC} $1"; }
fail() { echo -e "  ${RED}✗${NC} $1"; exit 1; }
err()  { echo -e "  ${RED}✗${NC} $1"; }

banner

# ── Helpers: secret generation + idempotent preservation ──
# load_or_generate is the load-bearing piece of T.2 in the install
# fix series: re-running install.sh on a host that already has a
# postgres data volume MUST NOT rotate the password, or the server
# can no longer authenticate. The named pg_data volume persists
# across `docker compose down`, so the password baked into it is
# the source of truth — .env has to match. We do that by reading
# whatever value is already in .env and only generating a fresh
# one if the key is missing entirely. Operators who genuinely want
# new secrets delete .env first.
gen_password() {
  openssl rand -base64 32 | tr -dc 'A-Za-z0-9' | head -c 32
}
gen_hex() {
  local bytes="${1:-32}"
  openssl rand -hex "$bytes"
}
gen_password_64() {
  openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | head -c 64
}

# Reads the named var from .env if present (and the value is non-
# empty), otherwise invokes $generator. Returns the value via the
# caller's named variable. Updates the global PRESERVED_COUNT /
# GENERATED_COUNT for the step-4 banner.
PRESERVED_COUNT=0
GENERATED_COUNT=0
load_or_generate() {
  local var="$1"
  local generator="$2"
  local existing=""
  if [ -f "$SCRIPT_DIR/.env" ]; then
    existing=$(grep -oP "^${var}=\K.*" "$SCRIPT_DIR/.env" 2>/dev/null || echo "")
  fi
  if [ -n "$existing" ]; then
    printf -v "$var" '%s' "$existing"
    PRESERVED_COUNT=$((PRESERVED_COUNT + 1))
  else
    local generated
    generated=$(eval "$generator")
    printf -v "$var" '%s' "$generated"
    GENERATED_COUNT=$((GENERATED_COUNT + 1))
  fi
}

# ── Helper: find first available port starting from a given number ──
find_available_port() {
  local port="${1:-3000}"
  while [ "$port" -le 65535 ]; do
    if ! ss -tlnH "sport = :$port" 2>/dev/null | grep -q ":${port}\b" \
       && ! ss -ulnH "sport = :$port" 2>/dev/null | grep -q ":${port}\b"; then
      echo "$port"
      return 0
    fi
    port=$((port + 1))
  done
  echo "$1"  # fallback to the starting port if nothing found
  return 1
}

# ── Prerequisites ──────────────────────────────────────────
if [ "$(id -u)" -ne 0 ]; then
  fail "This script must be run as root. Use: sudo bash install.sh"
fi

# ── Detect Incus / LXC container ───────────────────────────
# In external-proxy mode (Caddy on the LXC host, etc.) we skip the
# bundled NGINX entirely: Express serves the SPA directly and a
# different reverse proxy terminates TLS. Auto-default to external
# when running inside an LXC; the operator can still override at
# the prompt below.
detect_lxc() {
  if command -v systemd-detect-virt &>/dev/null; then
    local v; v=$(systemd-detect-virt --container 2>/dev/null || true)
    [ "$v" = "lxc" ] && return 0
  fi
  [ -f /run/.containerenv ] && return 0
  if [ -r /proc/1/environ ] && grep -qa 'container=lxc' /proc/1/environ; then
    return 0
  fi
  return 1
}
if detect_lxc; then IS_LXC=true; else IS_LXC=false; fi

# ── Step 1: Docker ─────────────────────────────────────────
step 1 "Installing Docker"

if command -v docker &>/dev/null && docker compose version &>/dev/null; then
  ok "Docker and Docker Compose already installed"
else
  info "Installing Docker CE and Compose plugin..."
  apt-get update -qq
  apt-get install -y -qq ca-certificates curl gnupg lsb-release >/dev/null

  install -m 0755 -d /etc/apt/keyrings
  if [ ! -f /etc/apt/keyrings/docker.gpg ]; then
    curl -fsSL https://download.docker.com/linux/$(. /etc/os-release && echo "$ID")/gpg \
      | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
    chmod a+r /etc/apt/keyrings/docker.gpg
  fi

  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
    https://download.docker.com/linux/$(. /etc/os-release && echo "$ID") \
    $(lsb_release -cs) stable" > /etc/apt/sources.list.d/docker.list

  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-compose-plugin >/dev/null
  systemctl enable --now docker
  ok "Docker installed successfully"
fi

# ── Step 2: Reverse proxy mode ─────────────────────────────
step 2 "Reverse proxy mode"

# Two paths:
#   local    — install + configure the bundled NGINX (default on bare
#              metal / VM). Express keeps serving the SPA + API on
#              loopback; NGINX terminates TLS and fronts everything.
#   external — skip NGINX entirely. Express serves the SPA + API
#              directly on 0.0.0.0:APP_PORT; an external reverse
#              proxy (Caddy on the Incus LXC host, Traefik, etc.)
#              terminates TLS and proxies to the LXC's IP. Used when
#              ProxyPilot or similar already owns TLS at the host.
if [ "$IS_LXC" = "true" ]; then
  info "Detected LXC container — defaulting to external proxy mode"
  DEFAULT_MODE="E"
else
  DEFAULT_MODE="L"
fi
read -rp "  Reverse proxy: [L]ocal NGINX or [E]xternal proxy (Caddy/Traefik) [${DEFAULT_MODE}]: " MODE_RAW
MODE_RAW="${MODE_RAW:-$DEFAULT_MODE}"
if [[ "$MODE_RAW" =~ ^[Ee] ]]; then
  PROXY_MODE="external"
  APP_BIND="0.0.0.0"
  ok "External proxy mode selected — skipping NGINX install"
else
  PROXY_MODE="local"
  APP_BIND="127.0.0.1"
  if command -v nginx &>/dev/null; then
    ok "Nginx already installed"
  else
    info "Installing nginx..."
    apt-get install -y -qq nginx >/dev/null
    systemctl enable --now nginx
    ok "Nginx installed"
  fi
  mkdir -p /etc/nginx/sites-available /etc/nginx/sites-enabled
fi

# ── Step 3: Interactive Configuration ──────────────────────
step 3 "Configuration"

read -rp "  Domain name (e.g. xray.example.com): " DOMAIN
while [ -z "$DOMAIN" ]; do
  read -rp "  Domain name cannot be empty: " DOMAIN
done

read -rp "  Admin email: " ADMIN_EMAIL
while [ -z "$ADMIN_EMAIL" ]; do
  read -rp "  Admin email cannot be empty: " ADMIN_EMAIL
done

DEFAULT_PORT=$(find_available_port 3000)
read -rp "  Application port [${DEFAULT_PORT}]: " APP_PORT
APP_PORT="${APP_PORT:-$DEFAULT_PORT}"

ok "Domain: ${DOMAIN}"
ok "Admin email: ${ADMIN_EMAIL}"
ok "App port: ${APP_PORT}"

# ── Step 4: Secret Generation ──────────────────────────────
step 4 "Generating / preserving secrets"

# Re-runs MUST NOT rotate passwords. The pg_data volume persists
# across compose down/up cycles with whatever password the role was
# created with on first init; if .env drifts, the server crash-loops
# with 28P01. load_or_generate keeps the value already in .env when
# it's there and generates fresh only when the key is missing.
# Operators who want to rotate a secret delete it from .env (or
# delete .env entirely) before re-running.
load_or_generate JWT_SECRET           gen_password_64
load_or_generate ENCRYPTION_KEY      'gen_hex 32'
load_or_generate DB_PASSWORD          gen_password
load_or_generate DB_APP_PASSWORD      gen_password

# Pipeline JWT keypair (RS256). Platform-wide; signs the data-access
# token destined for the future pipeline DB. Stored as single-line
# base64 so .env parsing stays simple; server decodes at boot. We
# treat the keypair atomically — if either half is missing we
# regenerate both, since a mismatched pair is worse than a fresh one.
PIPELINE_JWT_PRIVATE_KEY=$(grep -oP '^XRAY_PIPELINE_JWT_PRIVATE_KEY=\K.*' "$SCRIPT_DIR/.env" 2>/dev/null || echo "")
PIPELINE_JWT_PUBLIC_KEY=$(grep -oP '^XRAY_PIPELINE_JWT_PUBLIC_KEY=\K.*' "$SCRIPT_DIR/.env" 2>/dev/null || echo "")
if [ -n "$PIPELINE_JWT_PRIVATE_KEY" ] && [ -n "$PIPELINE_JWT_PUBLIC_KEY" ]; then
  PRESERVED_COUNT=$((PRESERVED_COUNT + 1))
else
  PIPELINE_JWT_DIR=$(mktemp -d)
  openssl genrsa -out "$PIPELINE_JWT_DIR/private.pem" 2048 >/dev/null 2>&1
  openssl rsa -in "$PIPELINE_JWT_DIR/private.pem" -pubout -out "$PIPELINE_JWT_DIR/public.pem" >/dev/null 2>&1
  PIPELINE_JWT_PRIVATE_KEY=$(base64 -w0 < "$PIPELINE_JWT_DIR/private.pem")
  PIPELINE_JWT_PUBLIC_KEY=$(base64 -w0 < "$PIPELINE_JWT_DIR/public.pem")
  rm -rf "$PIPELINE_JWT_DIR"
  GENERATED_COUNT=$((GENERATED_COUNT + 1))
fi

# Preserve VAPID + Stripe secrets across the .env rewrite in step 5.
# These are appended later in step 8b (VAPID) or seeded by the admin
# via the UI (Stripe), so a re-run shouldn't drop them on the floor.
VAPID_PUBLIC_KEY=$(grep -oP '^VAPID_PUBLIC_KEY=\K.*' "$SCRIPT_DIR/.env" 2>/dev/null || echo "")
VAPID_PRIVATE_KEY=$(grep -oP '^VAPID_PRIVATE_KEY=\K.*' "$SCRIPT_DIR/.env" 2>/dev/null || echo "")
VAPID_SUBJECT=$(grep -oP '^VAPID_SUBJECT=\K.*' "$SCRIPT_DIR/.env" 2>/dev/null || echo "")
STRIPE_WEBHOOK_SECRET=$(grep -oP '^STRIPE_WEBHOOK_SECRET=\K.*' "$SCRIPT_DIR/.env" 2>/dev/null || echo "")

if [ "$PRESERVED_COUNT" -gt 0 ]; then
  ok "Reused $PRESERVED_COUNT existing secret(s) from .env (delete .env to regenerate)"
fi
if [ "$GENERATED_COUNT" -gt 0 ]; then
  ok "Generated $GENERATED_COUNT new secret(s)"
fi

# ── Step 5: .env File ──────────────────────────────────────
step 5 "Writing .env file"

cat > "$SCRIPT_DIR/.env" <<ENVEOF
# ─── XRay BI Platform Configuration ───
# Generated by install.sh on $(date -Iseconds)

NODE_ENV=production

# ─── Network ───
APP_PORT=${APP_PORT}
APP_URL=https://${DOMAIN}
# APP_BIND controls which interface docker-compose publishes APP_PORT
# on. 127.0.0.1 (default, "local" PROXY_MODE) keeps the API loopback-
# only so a co-located NGINX can proxy in. 0.0.0.0 ("external"
# PROXY_MODE) makes the LXC's primary IP reachable so an external
# proxy (Caddy on the host, Traefik, etc.) can hit it.
APP_BIND=${APP_BIND}
# PROXY_MODE = local | external. Read by update.sh on subsequent
# runs so the operator doesn't get re-prompted.
PROXY_MODE=${PROXY_MODE}

# ─── Database ───
# DB_USER is the cluster bootstrap superuser (created by the postgres
# image's initdb --username=xray). Used by install.sh / update.sh to
# apply migrations and for ad-hoc admin work.
DB_HOST=postgres
DB_PORT=5432
DB_NAME=xray
DB_USER=xray
DB_PASSWORD=${DB_PASSWORD}

# DB_APP_USER is the runtime role the application server connects as
# (NOSUPERUSER NOINHERIT, owns nothing). RLS policies fire for queries
# made under this connection because the role is neither the table
# owner nor a superuser. Provisioned by install.sh step 9c.
DB_APP_USER=xray_app
DB_APP_PASSWORD=${DB_APP_PASSWORD}

# ─── Authentication ───
JWT_SECRET=${JWT_SECRET}
ENCRYPTION_KEY=${ENCRYPTION_KEY}

# ─── Pipeline JWT (RS256 keypair for xray-pipeline audience) ───
# Platform-wide keypair. Private key signs the pipeline data-access JWT;
# the public key will ship to the pipeline DB later (Model J). Base64
# encoded — server decodes at boot.
XRAY_PIPELINE_JWT_PRIVATE_KEY=${PIPELINE_JWT_PRIVATE_KEY}
XRAY_PIPELINE_JWT_PUBLIC_KEY=${PIPELINE_JWT_PUBLIC_KEY}

# ─── OAuth callback URL ───
# Provider registrations (HouseCall Pro, QuickBooks, etc.) must point
# at this URL. Derived from APP_URL by default; override if XRay lives
# behind a different domain for the OAuth callback path specifically.
XRAY_OAUTH_REDIRECT_URI=https://${DOMAIN}/api/oauth/callback

# ─── WebAuthn ───
RP_NAME=XRay BI
RP_ID=${DOMAIN}
ORIGIN=https://${DOMAIN}

# ─── Stripe (configure later in admin UI) ───
STRIPE_WEBHOOK_SECRET=${STRIPE_WEBHOOK_SECRET}

# ─── SMTP (configure later in admin UI or set here) ───
SMTP_HOST=
SMTP_PORT=587
SMTP_USER=
SMTP_PASS=
SMTP_FROM=

# ─── Admin ───
ADMIN_EMAIL=${ADMIN_EMAIL}
ENVEOF

# Preserve VAPID keys carried across re-runs: if the operator had
# them in the prior .env, write them back here so step 8b's
# idempotency check sees them and skips regeneration. On first
# install both vars are empty and this block writes nothing.
if [ -n "$VAPID_PUBLIC_KEY" ] && [ -n "$VAPID_PRIVATE_KEY" ]; then
  cat >> "$SCRIPT_DIR/.env" <<VAPIDPRESERVEEOF

# ─── Web Push (VAPID) — for MEET call mobile notifications ───
VAPID_PUBLIC_KEY=${VAPID_PUBLIC_KEY}
VAPID_PRIVATE_KEY=${VAPID_PRIVATE_KEY}
VAPID_SUBJECT=${VAPID_SUBJECT:-mailto:${ADMIN_EMAIL}}
VAPIDPRESERVEEOF
fi

chmod 600 "$SCRIPT_DIR/.env"
ok ".env written and locked (chmod 600)"

# ── Step 6: Nginx Configuration ───────────────────────────
step 6 "Configuring Nginx"

NGINX_CONF="/etc/nginx/sites-available/xray.conf"
TEMPLATE="$SCRIPT_DIR/nginx/xray.conf.template"

# In external-proxy mode the bundled NGINX is not installed, the
# /etc/letsencrypt/* path isn't ours, and the SPA is served by Express
# directly. Skip the whole config block — the external proxy owns TLS
# + frontend hosting.
if [ "$PROXY_MODE" = "external" ]; then
  ok "External proxy mode — skipping NGINX config + frontend deploy"
  HAS_CERTS=false
else

if [ ! -f "$TEMPLATE" ]; then
  fail "Nginx template not found at $TEMPLATE"
fi

# Check for existing Let's Encrypt certs
CERT_PATH="/etc/letsencrypt/live/${DOMAIN}"
if [ -d "$CERT_PATH" ]; then
  info "Found existing TLS certificates at $CERT_PATH"
  HAS_CERTS=true
else
  info "No existing TLS certificates found"
  HAS_CERTS=false
fi

# Copy SSL params (ensure snippets dir exists — template references this path)
if [ -f "$SCRIPT_DIR/nginx/ssl-params.conf" ]; then
  mkdir -p /etc/nginx/snippets
  cp "$SCRIPT_DIR/nginx/ssl-params.conf" /etc/nginx/snippets/ssl-params.conf
  ok "SSL hardening params installed"
fi

# Generate nginx config from template
sed \
  -e "s|__DOMAIN__|${DOMAIN}|g" \
  -e "s|__EMBED_DOMAIN__|${DOMAIN}|g" \
  -e "s|__APP_PORT__|${APP_PORT}|g" \
  "$TEMPLATE" > "$NGINX_CONF"

if [ "$HAS_CERTS" = true ]; then
  # SSL is already configured in the template, just verify paths
  ok "Nginx configured with HTTPS (existing certs)"
else
  # Replace the HTTPS block with HTTP-only for now
  cat > "$NGINX_CONF" <<HTTPCONF
# XRay BI Platform — HTTP-only (run certbot for HTTPS)
# Rate limiting removed

upstream xray_server {
    server 127.0.0.1:${APP_PORT};
}

server {
    listen 80;
    server_name ${DOMAIN};

    root /var/www/xray;

    location / {
        try_files \$uri \$uri/ /index.html;
    }

    location /index.html {
        add_header Cache-Control "no-cache";
    }

    location /bundles/ {
        add_header Cache-Control "public, max-age=3600";
    }

    location /api/auth/ {

        proxy_pass http://xray_server;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }

    location /api/ {

        proxy_pass http://xray_server;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
HTTPCONF
  warn "Nginx configured with HTTP only (run certbot after install for HTTPS)"
fi

# Symlink and enable
ln -sf "$NGINX_CONF" /etc/nginx/sites-enabled/xray.conf
rm -f /etc/nginx/sites-enabled/default 2>/dev/null || true

# Deploy frontend static files
mkdir -p /var/www/xray/bundles
for f in index.html app.css app.js landing.css landing.js manifest.json sw.js icon.svg icon-192.png icon-512.png share.html; do
  if [ -f "$SCRIPT_DIR/frontend/$f" ]; then
    cp "$SCRIPT_DIR/frontend/$f" /var/www/xray/
  fi
done
if [ -d "$SCRIPT_DIR/frontend/bundles" ]; then
  cp "$SCRIPT_DIR/frontend/bundles/"* /var/www/xray/bundles/
fi
# Copy extension directories (AI SDK, admin view, etc.)
for d in ai; do
  if [ -d "$SCRIPT_DIR/frontend/$d" ]; then
    mkdir -p "/var/www/xray/$d"
    cp -r "$SCRIPT_DIR/frontend/$d/"* "/var/www/xray/$d/"
  fi
done
chown -R www-data:www-data /var/www/xray

nginx -t && systemctl reload nginx
ok "Nginx configured and reloaded"

fi  # close: PROXY_MODE != external

# ── Step 7: TLS with Let's Encrypt ────────────────────────
step 7 "TLS / HTTPS setup"

if [ "$PROXY_MODE" = "external" ]; then
  ok "External proxy mode — TLS handled by your reverse proxy, skipping"
elif [ "$HAS_CERTS" = true ]; then
  ok "TLS already configured — skipping"
else
  echo ""
  read -rp "  Install TLS certificate via Let's Encrypt? [Y/n]: " INSTALL_TLS
  INSTALL_TLS="${INSTALL_TLS:-Y}"

  if [[ "$INSTALL_TLS" =~ ^[Yy] ]]; then
    if ! command -v certbot &>/dev/null; then
      info "Installing certbot..."
      apt-get install -y -qq certbot python3-certbot-nginx >/dev/null
    fi

    info "Requesting certificate for ${DOMAIN}..."
    certbot --nginx \
      -d "$DOMAIN" \
      --non-interactive \
      --agree-tos \
      --email "$ADMIN_EMAIL" \
      --redirect

    # Now regenerate nginx config with full HTTPS
    sed \
      -e "s|__DOMAIN__|${DOMAIN}|g" \
      -e "s|__EMBED_DOMAIN__|${DOMAIN}|g" \
      -e "s|__APP_PORT__|${APP_PORT}|g" \
      "$TEMPLATE" > "$NGINX_CONF"

    nginx -t && systemctl reload nginx
    ok "TLS certificate installed and Nginx updated to HTTPS"
  else
    warn "Skipping TLS — site will run on HTTP only"
    warn "Run 'sudo certbot --nginx -d ${DOMAIN}' later to enable HTTPS"
  fi
fi

# ── Step 8: Docker Build & Launch ─────────────────────────
step 8 "Building and launching containers"

cd "$SCRIPT_DIR"
info "Building Docker images..."
docker compose up -d --build

ok "Containers started"

# ── Step 8b: Generate VAPID keys using server container ──
# Three previously-bitey behaviors are corrected here (T.4):
#   1. Idempotency — re-running install.sh with VAPID already in .env
#      MUST skip the generator. Skipping by name (grep) makes the step
#      cheap to repeat and safe even if the server container is mid-
#      restart.
#   2. -T on docker compose exec — disables TTY allocation so a
#      misbehaving child process can't hijack the operator's outer
#      PTY (the disconnect symptom seen in ProxyPilot terminals).
#   3. Error capture via `if !` — defeats `set -e`'s "exit on
#      non-zero", surfaces stderr, and gives the operator the exact
#      command to retry instead of dropping them at a bare prompt.
if grep -q '^VAPID_PUBLIC_KEY=.\+' "$SCRIPT_DIR/.env" 2>/dev/null \
   && grep -q '^VAPID_PRIVATE_KEY=.\+' "$SCRIPT_DIR/.env" 2>/dev/null; then
  ok "VAPID keys already present in .env — skipping generation"
else
  info "Generating VAPID keys for push notifications..."
  # Brief wait for the server container to be runnable. We don't poll
  # health here because the migrations haven't run yet — the container
  # is "up" but not "healthy" by the API definition; web-push doesn't
  # need the DB so this is fine.
  sleep 2
  if ! VAPID_OUTPUT=$(docker compose exec -T server npx web-push generate-vapid-keys --json 2>&1); then
    warn "VAPID key generation failed — push notifications will be disabled until configured."
    printf '%s\n' "$VAPID_OUTPUT" | sed 's/^/    /'
    warn "Re-run install.sh once the server is healthy, or run manually:"
    warn "    docker compose exec -T server npx web-push generate-vapid-keys --json"
  else
    VAPID_PUBLIC_KEY=$(echo "$VAPID_OUTPUT" | grep -o '"publicKey":"[^"]*"' | cut -d'"' -f4)
    VAPID_PRIVATE_KEY=$(echo "$VAPID_OUTPUT" | grep -o '"privateKey":"[^"]*"' | cut -d'"' -f4)
    if [ -n "$VAPID_PUBLIC_KEY" ] && [ -n "$VAPID_PRIVATE_KEY" ]; then
      cat >> "$SCRIPT_DIR/.env" <<VAPIDEOF

# ─── Web Push (VAPID) — for MEET call mobile notifications ───
VAPID_PUBLIC_KEY=${VAPID_PUBLIC_KEY}
VAPID_PRIVATE_KEY=${VAPID_PRIVATE_KEY}
VAPID_SUBJECT=mailto:${ADMIN_EMAIL}
VAPIDEOF
      docker compose restart server >/dev/null 2>&1 || true
      ok "VAPID keys generated and server restarted"
    else
      warn "VAPID generator returned unparseable output — configure manually in .env later"
      printf '%s\n' "$VAPID_OUTPUT" | head -3 | sed 's/^/    /'
    fi
  fi
fi

# ── Step 9: Run database migrations ──────────────────────
# Migrations run in two stages:
#   1. migrations/*.sql — additive schema changes. Safe to run at any
#      time because adding a column/table doesn't break existing code.
#   2. migrations/post-rebuild/*.sql — destructive changes (DROP COLUMN
#      etc). These would break the still-running old container on an
#      update, so on install.sh they run AFTER the container is up too,
#      for consistency with update.sh's ordering.
# On a fresh install the container is already up (step 8), so both
# stages execute in order within this step.
step 9 "Running database migrations"

PG_CONTAINER=$(docker compose ps -q postgres 2>/dev/null)
run_migrations() {
  local dir="$1"; local label="$2"
  [ -d "$dir" ] || return 0
  local count=0
  for migration in "$dir"/*.sql; do
    [ -f "$migration" ] || continue
    local mname
    mname=$(basename "$migration")
    info "Running $label/$mname..."
    docker cp "$migration" "$PG_CONTAINER:/tmp/$mname"
    if docker exec "$PG_CONTAINER" psql -U "${DB_USER:-xray}" -d "${DB_NAME:-xray}" -f "/tmp/$mname" >/dev/null 2>&1; then
      count=$((count + 1))
    else
      warn "Migration $label/$mname had errors (may already be applied)"
    fi
  done
  ok "$count $label migration(s) applied"
}

if [ -n "$PG_CONTAINER" ] && [ -d "$SCRIPT_DIR/migrations" ]; then
  # Wait for postgres to be ready
  for i in $(seq 1 15); do
    if docker exec "$PG_CONTAINER" pg_isready -U "${DB_USER:-xray}" >/dev/null 2>&1; then
      break
    fi
    sleep 1
  done

  run_migrations "$SCRIPT_DIR/migrations" "pre-rebuild"
  run_migrations "$SCRIPT_DIR/migrations/post-rebuild" "post-rebuild"
else
  warn "Could not run migrations (postgres container not found or no migrations/)"
fi

# ── Step 9c: Provision the application's runtime DB role (xray_app) ──
# RLS only fires when the connecting user is NEITHER the table owner
# NOR a superuser. The bootstrap user (xray) is both — created by
# initdb --username=xray and owns every platform.* table from
# init.sql. Provisioning a separate xray_app role with DML grants but
# no ownership and no superuser bit makes the runtime application
# connection RLS-respecting from boot 0. xray stays as the bootstrap
# super for migrations and admin work; the server reconnects as
# xray_app at the end of step 8 (DATABASE_URL in docker-compose.yml
# points at DB_APP_USER + DB_APP_PASSWORD by default).
if [ -n "$PG_CONTAINER" ]; then
  step 9c "Provisioning runtime DB role (xray_app)"
  docker exec -i "$PG_CONTAINER" psql -v ON_ERROR_STOP=1 -U "${DB_USER:-xray}" -d "${DB_NAME:-xray}" >/dev/null <<SQL
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${DB_APP_USER:-xray_app}') THEN
    CREATE ROLE "${DB_APP_USER:-xray_app}" WITH LOGIN PASSWORD '${DB_APP_PASSWORD}'
      NOSUPERUSER NOINHERIT NOCREATEDB NOCREATEROLE NOREPLICATION
      CONNECTION LIMIT 50;
  ELSE
    ALTER ROLE "${DB_APP_USER:-xray_app}" WITH PASSWORD '${DB_APP_PASSWORD}';
  END IF;
END \$\$;
GRANT USAGE ON SCHEMA platform TO "${DB_APP_USER:-xray_app}";
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA platform TO "${DB_APP_USER:-xray_app}";
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA platform TO "${DB_APP_USER:-xray_app}";
ALTER DEFAULT PRIVILEGES IN SCHEMA platform GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO "${DB_APP_USER:-xray_app}";
ALTER DEFAULT PRIVILEGES IN SCHEMA platform GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO "${DB_APP_USER:-xray_app}";
SQL
  if [ $? -eq 0 ]; then
    ok "Runtime role ${DB_APP_USER:-xray_app} provisioned (NOSUPERUSER, NOINHERIT, DML grants on platform.*)"
    # Force-recreate the server so it reconnects under xray_app. On a
    # fresh install the server was created in step 8 with .env already
    # holding DB_APP_USER + DB_APP_PASSWORD, so its env is correct;
    # `docker compose restart` would suffice. We use --force-recreate
    # --no-deps anyway so this path is identical to update.sh's step 5
    # — single shape, no divergence between install + update flows.
    # --no-deps keeps postgres untouched.
    docker compose up -d --force-recreate --no-deps server >/dev/null 2>&1 \
      && ok "Server force-recreated on xray_app connection" \
      || warn "Could not recreate server — run manually: docker compose up -d --force-recreate --no-deps server"
  else
    warn "xray_app provisioning had errors — server will fall back to ${DB_USER:-xray} (RLS decorative until fixed)"
  fi
fi

# ── Step 9b: Backfill encrypted credentials (migration 017 companion) ──
# No-op on a fresh install (no plaintext rows to rewrite), but harmless
# and keeps the flow consistent with update.sh. Idempotent.
info "Running credential backfill..."
SERVER_CONTAINER=$(docker compose ps -q server 2>/dev/null || echo "")
if [ -n "$SERVER_CONTAINER" ]; then
  if docker compose exec -T server test -f dist/scripts/backfill-encrypt-credentials.js 2>/dev/null; then
    docker compose exec -T server node dist/scripts/backfill-encrypt-credentials.js 2>&1 \
      | sed 's/^/    /' || warn "Backfill reported errors — rerun manually if needed"
    ok "Backfill complete"
  else
    info "Backfill script not in image — skipping (expected on older builds)"
  fi
else
  warn "Server container not running — skipping backfill"
fi

# ── Step 10: Health Check ─────────────────────────────────
step "10" "Waiting for application to become healthy"

HEALTH_URL="http://127.0.0.1:${APP_PORT}/healthz"
MAX_WAIT=60
ELAPSED=0

while [ $ELAPSED -lt $MAX_WAIT ]; do
  if curl -sf "$HEALTH_URL" >/dev/null 2>&1; then
    ok "Application is healthy!"
    break
  fi
  sleep 2
  ELAPSED=$((ELAPSED + 2))
  echo -ne "  Waiting... ${ELAPSED}s / ${MAX_WAIT}s\r"
done

if [ $ELAPSED -ge $MAX_WAIT ]; then
  echo
  err "Health check failed: ${HEALTH_URL} did not return 200 within ${MAX_WAIT}s"
  err "Install did not complete. Recent server logs:"
  echo
  # Dump the last 30 lines so the operator can see what actually went
  # wrong without running a follow-up command.
  RECENT_LOGS=$(docker compose logs --tail 50 server --no-color 2>&1 || echo "")
  printf '%s\n' "$RECENT_LOGS" | sed 's/^/    /'
  echo

  # T.3: detect the canonical "old volume + new password" failure
  # mode and print the recovery commands in-line. Auto-recovering
  # would risk wiping data; spelling out the choice is what the
  # operator actually needs.
  if printf '%s' "$RECENT_LOGS" | grep -qE 'password authentication failed for user|28P01'; then
    echo
    err "Postgres rejected the server's credentials. The most common"
    err "cause is a stale postgres data volume from a previous install"
    err "with a different password than the one currently in .env."
    echo
    err "Recovery option A — wipe the postgres volume (DESTROYS DATA):"
    err "    docker compose down -v"
    err "    docker compose up -d"
    echo
    err "Recovery option B — keep the data, reset the role password to"
    err "match .env:"
    err "    DB_APP_PWD=\$(grep '^DB_APP_PASSWORD=' .env | cut -d= -f2-)"
    err "    docker compose exec -T postgres psql -U \"\${DB_USER:-xray}\" -d \"\${DB_NAME:-xray}\" \\"
    err "      -c \"ALTER USER \${DB_APP_USER:-xray_app} WITH PASSWORD '\$DB_APP_PWD';\""
    err "    docker compose restart server"
  else
    err "Investigate with: docker compose logs -f server"
    err "Once fixed, re-run ./install.sh — it's idempotent."
  fi
  exit 1
fi

# ── Step 11: Summary ──────────────────────────────────────
step 11 "Installation complete"

echo ""
echo -e "${GREEN}${BOLD}  ┌─────────────────────────────────────────────────┐${NC}"
echo -e "${GREEN}${BOLD}  │           XRay BI Platform — Installed          │${NC}"
echo -e "${GREEN}${BOLD}  └─────────────────────────────────────────────────┘${NC}"
echo ""

if [ "$PROXY_MODE" = "external" ]; then
  echo -e "  ${BOLD}App URL:${NC}       https://${DOMAIN}  (TLS terminated by your external proxy)"
elif [ "$HAS_CERTS" = true ] || [[ "${INSTALL_TLS:-N}" =~ ^[Yy] ]]; then
  echo -e "  ${BOLD}App URL:${NC}       https://${DOMAIN}"
else
  echo -e "  ${BOLD}App URL:${NC}       http://${DOMAIN}"
fi

if [ "$PROXY_MODE" = "external" ]; then
  # Pick a likely-reachable address for the operator to point their
  # external proxy at. `hostname -I` returns the first non-loopback
  # IPv4 — good enough for the LXC/host-bridged case. Operator can
  # always swap in the LXC's known IP from `incus list` if this isn't
  # what they want.
  LXC_IP=$(hostname -I 2>/dev/null | awk '{print $1}' || echo "<lxc-ip>")
  echo -e "  ${BOLD}Bound on:${NC}      ${LXC_IP}:${APP_PORT}  (Express serves SPA + API)"
  echo -e "  ${BOLD}Health:${NC}        http://${LXC_IP}:${APP_PORT}/healthz  (DB-up probe)"
  echo ""
  echo -e "  ${BOLD}Caddyfile snippet for your reverse proxy host:${NC}"
  echo -e "    ${CYAN}${DOMAIN} {${NC}"
  echo -e "    ${CYAN}    reverse_proxy ${LXC_IP}:${APP_PORT}${NC}"
  echo -e "    ${CYAN}}${NC}"
fi

echo -e "  ${BOLD}Admin email:${NC}   ${ADMIN_EMAIL}"
echo -e "  ${BOLD}API health:${NC}    http://127.0.0.1:${APP_PORT}/api/health"
echo ""
echo -e "  ${BOLD}Useful commands:${NC}"
echo -e "    ${CYAN}docker compose logs -f server${NC}   — View server logs"
echo -e "    ${CYAN}docker compose ps${NC}               — Container status"
echo -e "    ${CYAN}docker compose restart${NC}           — Restart services"
echo -e "    ${CYAN}docker compose down${NC}              — Stop services"
echo -e "    ${CYAN}cat .env${NC}                         — View configuration"
echo ""
echo -e "  ${BOLD}Next steps:${NC}"
echo -e "    1. Visit the app URL and sign up with ${ADMIN_EMAIL}"
echo -e "    2. Configure SMTP in Platform Settings for magic links"
echo -e "    3. Configure Stripe for billing (optional)"
echo -e "    4. Generate API keys for n8n / external integrations"
echo ""
