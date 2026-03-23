#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
# XRay SaaS Platform — Update Script
# Pulls latest code and redeploys frontend + backend + nginx
# Usage:  sudo bash update.sh
# ─────────────────────────────────────────────────────────────
set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
ok()   { echo -e "  ${GREEN}✓${NC} $1"; }
warn() { echo -e "  ${YELLOW}!${NC} $1"; }
err()  { echo -e "  ${RED}✗${NC} $1"; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo ""
echo "  ╔═══════════════════════════════════════╗"
echo "  ║       XRay Platform — Update          ║"
echo "  ╚═══════════════════════════════════════╝"
echo ""

# ── Step 1: Pull latest code ──
echo "  [1/5] Pulling latest code..."
cd "$SCRIPT_DIR"
if git rev-parse --is-inside-work-tree &>/dev/null; then
  BRANCH=$(git rev-parse --abbrev-ref HEAD)
  git pull origin "$BRANCH" --ff-only 2>/dev/null && ok "Code updated (branch: $BRANCH)" || {
    warn "Git pull failed — using local files as-is"
  }
else
  warn "Not a git repo — using local files"
fi

# ── Step 2: Deploy frontend files ──
echo "  [2/6] Deploying frontend..."
WEBROOT="/var/www/xray"
if [ -d "$WEBROOT" ]; then
  mkdir -p "$WEBROOT/bundles"
  FCOUNT=0
  for f in index.html app.css app.js landing.css landing.js manifest.json sw.js icon.svg icon-192.png icon-512.png share.html; do
    if [ -f "$SCRIPT_DIR/frontend/$f" ]; then
      cp "$SCRIPT_DIR/frontend/$f" "$WEBROOT/"
      FCOUNT=$((FCOUNT + 1))
    fi
  done
  ok "$FCOUNT frontend files updated"
  if [ -d "$SCRIPT_DIR/frontend/bundles" ]; then
    cp "$SCRIPT_DIR/frontend/bundles/"* "$WEBROOT/bundles/"
    ok "Bundles updated ($(ls "$SCRIPT_DIR/frontend/bundles/" | wc -l) files)"
  fi
  chown -R www-data:www-data "$WEBROOT" 2>/dev/null || true
else
  warn "Webroot $WEBROOT not found — skipping frontend deploy"
fi

# ── Step 3: Update nginx config from template ──
echo "  [3/6] Updating nginx config..."
NGINX_CONF="/etc/nginx/sites-available/xray.conf"
if [ -f "$NGINX_CONF" ] && [ -f "$SCRIPT_DIR/nginx/xray.conf.template" ]; then
  # Extract current domain, embed domain, and app port from existing config
  DOMAIN=$(grep -oP 'server_name \K[^ ;]+' "$NGINX_CONF" | head -1)
  EMBED_DOMAIN=$(grep -oP 'server_name [^ ]+ \K[^ ;]+' "$NGINX_CONF" | head -1 || echo "")
  APP_PORT=$(grep -oP 'server 127\.0\.0\.1:\K[0-9]+' "$NGINX_CONF" | head -1)

  if [ -n "$DOMAIN" ] && [ -n "$APP_PORT" ]; then
    cp "$NGINX_CONF" "${NGINX_CONF}.bak"
    sed -e "s/__DOMAIN__/$DOMAIN/g" \
        -e "s/__EMBED_DOMAIN__/${EMBED_DOMAIN:-embed.$DOMAIN}/g" \
        -e "s/__APP_PORT__/$APP_PORT/g" \
        "$SCRIPT_DIR/nginx/xray.conf.template" > "$NGINX_CONF"
    ok "Nginx config updated (domain: $DOMAIN, port: $APP_PORT)"
  else
    warn "Could not extract domain/port from existing config — skipping"
  fi
else
  warn "Nginx config or template not found — skipping"
fi

# ── Step 4: Rebuild and restart backend ──
echo "  [4/6] Rebuilding backend..."
if [ -f "$SCRIPT_DIR/docker-compose.yml" ]; then
  cd "$SCRIPT_DIR"
  docker compose build --quiet 2>/dev/null && ok "Backend rebuilt" || warn "Docker build failed"
  docker compose up -d 2>/dev/null && ok "Backend restarted" || warn "Docker restart failed"
else
  warn "No docker-compose.yml found — skipping backend rebuild"
fi

# ── Step 5: Run database migrations ──
echo "  [5/6] Running database migrations..."
PG_CONTAINER=$(docker compose ps -q postgres 2>/dev/null || echo "")
if [ -n "$PG_CONTAINER" ] && [ -d "$SCRIPT_DIR/migrations" ]; then
  # Wait for postgres to be ready
  for i in $(seq 1 10); do
    if docker exec "$PG_CONTAINER" pg_isready -U "${DB_USER:-xray}" >/dev/null 2>&1; then
      break
    fi
    sleep 1
  done

  MIGRATION_COUNT=0
  for migration in "$SCRIPT_DIR"/migrations/*.sql; do
    [ -f "$migration" ] || continue
    MNAME=$(basename "$migration")
    docker cp "$migration" "$PG_CONTAINER:/tmp/$MNAME"
    if docker exec "$PG_CONTAINER" psql -U "${DB_USER:-xray}" -d "${DB_NAME:-xray}" -f "/tmp/$MNAME" >/dev/null 2>&1; then
      MIGRATION_COUNT=$((MIGRATION_COUNT + 1))
    fi
  done
  ok "$MIGRATION_COUNT migration(s) applied"
else
  warn "Skipping migrations (no postgres container or migrations/ dir)"
fi

# ── Step 6: Reload nginx ──
echo "  [6/6] Reloading nginx..."
if command -v nginx &>/dev/null; then
  nginx -t 2>/dev/null && systemctl reload nginx 2>/dev/null && ok "Nginx reloaded" || warn "Nginx reload failed"
else
  warn "Nginx not found"
fi

echo ""
ok "Update complete!"
echo ""
