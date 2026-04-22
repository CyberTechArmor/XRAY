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
echo "  [1/7] Pulling latest code..."
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
echo "  [2/7] Deploying frontend..."
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
  for d in ai; do
    if [ -d "$SCRIPT_DIR/frontend/$d" ]; then
      mkdir -p "$WEBROOT/$d"
      cp -r "$SCRIPT_DIR/frontend/$d/"* "$WEBROOT/$d/"
      ok "$d/ updated ($(ls "$SCRIPT_DIR/frontend/$d/" | wc -l) files)"
    fi
  done
  chown -R www-data:www-data "$WEBROOT" 2>/dev/null || true
else
  warn "Webroot $WEBROOT not found — skipping frontend deploy"
fi

# ── Step 3: Update nginx config from template ──
echo "  [3/7] Updating nginx config..."
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

# ── Step 4: Run database migrations BEFORE rebuilding server ──
# Additive-only schema changes go here so the NEW code boots against a
# DB that already has the new columns/tables. Running migrations after
# the rebuild would create a window where new code SELECTs columns the
# old DB doesn't have yet → render calls 500.
echo "  [4/7] Running database migrations..."
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
  MIGRATION_FAILED=0
  for migration in "$SCRIPT_DIR"/migrations/*.sql; do
    [ -f "$migration" ] || continue
    MNAME=$(basename "$migration")
    docker cp "$migration" "$PG_CONTAINER:/tmp/$MNAME"
    # Run on ON_ERROR_STOP so partial application is detected. Capture stderr
    # so the user can see what broke instead of the old silent-fail behavior.
    OUT=$(docker exec "$PG_CONTAINER" psql -v ON_ERROR_STOP=1 -U "${DB_USER:-xray}" -d "${DB_NAME:-xray}" -f "/tmp/$MNAME" 2>&1) && {
      MIGRATION_COUNT=$((MIGRATION_COUNT + 1))
    } || {
      # Benign "already exists" errors are expected when re-applying. Surface
      # anything else so broken migrations don't get swallowed. The previous
      # implementation chained `grep -q | grep -v` — but -q writes no output,
      # so the second grep always saw empty stdin and the condition always
      # evaluated false, silently masking real migration errors.
      REAL_ERRORS=$(echo "$OUT" | grep -iE "(ERROR|FATAL)" | grep -viE "already exists|duplicate" || true)
      if [ -n "$REAL_ERRORS" ]; then
        MIGRATION_FAILED=$((MIGRATION_FAILED + 1))
        warn "migration $MNAME: $(echo "$REAL_ERRORS" | head -3)"
      else
        # Idempotent re-apply — treat as success
        MIGRATION_COUNT=$((MIGRATION_COUNT + 1))
      fi
    }
  done
  if [ "$MIGRATION_FAILED" -gt 0 ]; then
    warn "$MIGRATION_FAILED migration(s) had errors — review output above"
  fi
  ok "$MIGRATION_COUNT migration(s) applied"
else
  warn "Skipping migrations (no postgres container or migrations/ dir)"
fi

# ── Step 5: Rebuild and restart backend ──
# Ordered AFTER migrations so the new code boots into a schema that
# already has any new columns it SELECTs.
echo "  [5/7] Rebuilding backend..."
if [ -f "$SCRIPT_DIR/docker-compose.yml" ]; then
  cd "$SCRIPT_DIR"
  docker compose build --no-cache 2>&1 | tail -5 && ok "Backend rebuilt" || warn "Docker build failed"
  docker compose up -d 2>/dev/null && ok "Backend restarted" || warn "Docker restart failed"
else
  warn "No docker-compose.yml found — skipping backend rebuild"
fi

# ── Step 5b: Ensure VAPID keys exist in .env ──
if [ -f "$SCRIPT_DIR/.env" ]; then
  if ! grep -q '^VAPID_PUBLIC_KEY=.\+' "$SCRIPT_DIR/.env" 2>/dev/null; then
    echo "  [5b] Generating VAPID keys for push notifications..."
    SERVER_CONTAINER=$(docker compose ps -q server 2>/dev/null || echo "")
    if [ -n "$SERVER_CONTAINER" ]; then
      VAPID_JSON=$(docker exec "$SERVER_CONTAINER" npx web-push generate-vapid-keys --json 2>/dev/null || echo "")
      if [ -n "$VAPID_JSON" ]; then
        VAPID_PUB=$(echo "$VAPID_JSON" | grep -o '"publicKey":"[^"]*"' | cut -d'"' -f4)
        VAPID_PRV=$(echo "$VAPID_JSON" | grep -o '"privateKey":"[^"]*"' | cut -d'"' -f4)
        if [ -n "$VAPID_PUB" ] && [ -n "$VAPID_PRV" ]; then
          ADMIN_EMAIL_VAL=$(grep -oP '^ADMIN_EMAIL=\K.*' "$SCRIPT_DIR/.env" 2>/dev/null || echo "admin@localhost")
          cat >> "$SCRIPT_DIR/.env" <<VAPIDEOF

# ─── Web Push (VAPID) — for MEET call mobile notifications ───
VAPID_PUBLIC_KEY=${VAPID_PUB}
VAPID_PRIVATE_KEY=${VAPID_PRV}
VAPID_SUBJECT=mailto:${ADMIN_EMAIL_VAL}
VAPIDEOF
          ok "VAPID keys added to .env (push notifications enabled)"
          docker compose restart server >/dev/null 2>&1 && ok "Server restarted with VAPID keys" || true
        else
          warn "Could not parse VAPID keys — push notifications will be disabled"
        fi
      else
        warn "Could not generate VAPID keys — push notifications will be disabled"
      fi
    else
      warn "Server container not running — skipping VAPID key generation"
    fi
  else
    ok "VAPID keys already configured"
  fi
fi

# ── Step 6: Backfill encrypted credentials (migration 017 companion) ──
# Idempotent. Rewrites any plaintext rows in webhooks.secret,
# connections.connection_details, and dashboards.fetch_headers as enc:v1
# envelopes. Skips already-encrypted rows. Harmless on fresh DBs with
# no plaintext rows. See CONTEXT.md.
echo "  [6/7] Running credential backfill..."
SERVER_CONTAINER=$(docker compose ps -q server 2>/dev/null || echo "")
if [ -n "$SERVER_CONTAINER" ]; then
  if docker compose exec -T server test -f dist/scripts/backfill-encrypt-credentials.js 2>/dev/null; then
    BACKFILL_OUT=$(docker compose exec -T server node dist/scripts/backfill-encrypt-credentials.js 2>&1) && {
      echo "$BACKFILL_OUT" | sed 's/^/    /'
      ok "Backfill complete"
    } || {
      warn "Backfill failed — rerun manually: docker compose exec -T server node dist/scripts/backfill-encrypt-credentials.js"
      echo "$BACKFILL_OUT" | sed 's/^/    /'
    }
  else
    warn "Backfill script not present in server image (older build?) — skipping"
  fi
else
  warn "Server container not running — skipping backfill"
fi

# ── Step 7: Reload nginx ──
echo "  [7/7] Reloading nginx..."
if command -v nginx &>/dev/null; then
  nginx -t 2>/dev/null && systemctl reload nginx 2>/dev/null && ok "Nginx reloaded" || warn "Nginx reload failed"
else
  warn "Nginx not found"
fi

echo ""
ok "Update complete!"
echo ""
