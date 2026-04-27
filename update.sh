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

# ── Migration helper ──
# Applies every *.sql in a given directory with error detection. Shared
# between the pre-rebuild and post-rebuild stages below.
PG_CONTAINER=$(docker compose ps -q postgres 2>/dev/null || echo "")
apply_migrations_from() {
  local dir="$1"; local stage_label="$2"
  [ -d "$dir" ] || return 0
  [ -n "$PG_CONTAINER" ] || { warn "Skipping $stage_label migrations (no postgres container)"; return 0; }
  local count=0 failed=0
  for migration in "$dir"/*.sql; do
    [ -f "$migration" ] || continue
    local mname
    mname=$(basename "$migration")
    docker cp "$migration" "$PG_CONTAINER:/tmp/$mname"
    local out
    out=$(docker exec "$PG_CONTAINER" psql -v ON_ERROR_STOP=1 -U "${DB_USER:-xray}" -d "${DB_NAME:-xray}" -f "/tmp/$mname" 2>&1) && {
      count=$((count + 1))
    } || {
      # Benign "already exists" errors are expected when re-applying. Surface
      # anything else so broken migrations don't get swallowed.
      local real_errors
      real_errors=$(echo "$out" | grep -iE "(ERROR|FATAL)" | grep -viE "already exists|duplicate" || true)
      if [ -n "$real_errors" ]; then
        failed=$((failed + 1))
        warn "migration $stage_label/$mname: $(echo "$real_errors" | head -3)"
      else
        count=$((count + 1))
      fi
    }
  done
  if [ "$failed" -gt 0 ]; then
    warn "$failed $stage_label migration(s) had errors — review output above"
  fi
  ok "$count $stage_label migration(s) applied"
}

# ── Step 4: Pre-rebuild migrations ──
# Additive-only schema changes (new columns, new tables, new triggers
# that guard new columns). Running these FIRST means the NEW code boots
# against a DB that already has the columns it SELECTs — avoids a window
# where new code 500s on missing columns.
# Destructive migrations (DROP COLUMN, DROP TABLE) belong in
# migrations/post-rebuild/ and run in a later step for the mirror-image
# reason: dropping a column while the OLD container still serves traffic
# makes the old code 500 until the rebuild swaps.
echo "  [4/7] Running pre-rebuild migrations..."
if [ -n "$PG_CONTAINER" ] && [ -d "$SCRIPT_DIR/migrations" ]; then
  # Wait for postgres to be ready
  for i in $(seq 1 10); do
    if docker exec "$PG_CONTAINER" pg_isready -U "${DB_USER:-xray}" >/dev/null 2>&1; then
      break
    fi
    sleep 1
  done
  apply_migrations_from "$SCRIPT_DIR/migrations" "pre-rebuild"
else
  warn "Skipping migrations (no postgres container or migrations/ dir)"
fi

# ── Step 4b: Ensure DB_APP_USER + DB_APP_PASSWORD in .env ──
# RLS only fires when the connecting user is NEITHER the table owner
# NOR a superuser. Existing installs ran with DB_USER=xray (the
# bootstrap super) as the runtime connection — RLS was decorative.
# This step adds DB_APP_USER + DB_APP_PASSWORD for the application's
# new non-owner non-super runtime role; xray stays as the bootstrap
# super for migrations and admin work. Idempotent: skipped if already
# configured.
if [ -f "$SCRIPT_DIR/.env" ] && ! grep -q '^DB_APP_PASSWORD=.\+' "$SCRIPT_DIR/.env" 2>/dev/null; then
  echo "  [4b] Generating DB_APP_PASSWORD for runtime role split..."
  GENERATED_DB_APP_PW=$(openssl rand -base64 32 | tr -dc 'A-Za-z0-9' | head -c 32)
  cat >> "$SCRIPT_DIR/.env" <<APPENVEOF

# ─── Application runtime DB role (added by update.sh) ───
# DB_USER (xray) is the bootstrap superuser — used by install.sh /
# update.sh for migrations + admin work. DB_APP_USER is the runtime
# role the application connects as (NOSUPERUSER NOINHERIT, owns
# nothing) so RLS policies actually fire on every query.
DB_APP_USER=xray_app
DB_APP_PASSWORD=${GENERATED_DB_APP_PW}
APPENVEOF
  ok "DB_APP_USER + DB_APP_PASSWORD added to .env"
elif [ -f "$SCRIPT_DIR/.env" ]; then
  ok "DB_APP_PASSWORD already configured in .env"
fi

# ── Step 4c: Provision (or sync) the runtime DB role ──
# Idempotent — creates xray_app if missing, otherwise rotates its
# password to match the .env value (handles the case where .env was
# regenerated but the role already exists from a prior run).
if [ -n "$PG_CONTAINER" ] && [ -f "$SCRIPT_DIR/.env" ]; then
  # Source .env so $DB_APP_USER / $DB_APP_PASSWORD are in scope. Run in
  # a subshell so we don't pollute the rest of update.sh's environment.
  (
    set -a
    # shellcheck disable=SC1091
    . "$SCRIPT_DIR/.env"
    set +a
    if [ -n "${DB_APP_PASSWORD:-}" ]; then
      echo "  [4c] Syncing runtime DB role (${DB_APP_USER:-xray_app})..."
      docker exec -i "$PG_CONTAINER" psql -v ON_ERROR_STOP=1 \
        -U "${DB_USER:-xray}" -d "${DB_NAME:-xray}" >/dev/null <<SQL
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
        ok "Runtime role synced — server will reconnect as ${DB_APP_USER:-xray_app} after the rebuild step"
      else
        warn "Runtime role sync had errors — server will fall back to ${DB_USER:-xray} (RLS decorative until fixed)"
      fi
    fi
  )
fi

# ── Step 5: Rebuild and restart backend ──
# Ordered AFTER pre-rebuild migrations so the new code boots into a
# schema that already has any new columns it SELECTs, and BEFORE the
# post-rebuild migrations so destructive changes only land after the old
# code stops serving traffic.
echo "  [5/7] Rebuilding backend..."
if [ -f "$SCRIPT_DIR/docker-compose.yml" ]; then
  cd "$SCRIPT_DIR"
  docker compose build --no-cache 2>&1 | tail -5 && ok "Backend rebuilt" || warn "Docker build failed"
  # Bring the stack up first (idempotent — starts anything not running,
  # leaves running services alone). Then explicitly --force-recreate the
  # server so it picks up env changes from .env (DB_APP_USER /
  # DB_APP_PASSWORD added in step 4b above). docker compose up -d ALONE
  # is unreliable for env-only drift on interpolated values across
  # compose versions — see docker/compose#9961 — and skipping the
  # recreate leaves the server connecting under the old DATABASE_URL.
  # --no-deps keeps postgres untouched (its data volume + bootstrap are
  # stable across redeploys; recreating it is needless churn).
  docker compose up -d 2>&1 | tail -5 || warn "Docker up failed"
  if docker compose up -d --force-recreate --no-deps server 2>&1 | tail -5; then
    ok "Backend restarted (server force-recreated to pick up .env changes)"
  else
    warn "Server force-recreate failed"
  fi
else
  warn "No docker-compose.yml found — skipping backend rebuild"
fi

# ── Step 5c: Post-rebuild migrations ──
# Destructive schema changes. Safe to run now because the new container
# is up and no code path in the new image SELECTs the dropped columns.
echo "  [5c] Running post-rebuild migrations..."
# Re-capture PG_CONTAINER. Step 5's `docker compose up -d` recreates any
# service whose config has drifted (new volume mount, new command flag,
# new env var) — postgres included. The ID captured at line 89 may now
# be stale and `docker exec` would fail with "No such container".
PG_CONTAINER=$(docker compose ps -q postgres 2>/dev/null || echo "")
if [ -n "$PG_CONTAINER" ]; then
  for i in $(seq 1 15); do
    if docker exec "$PG_CONTAINER" pg_isready -U "${DB_USER:-xray}" >/dev/null 2>&1; then
      break
    fi
    sleep 1
  done
fi
apply_migrations_from "$SCRIPT_DIR/migrations/post-rebuild" "post-rebuild"

# ── Step 5b0: Ensure Pipeline JWT keypair + OAuth redirect URI in .env ──
# Step 4 introduced a platform-wide RS256 keypair that signs the
# xray-pipeline JWT. Absent keypair = graceful skip in server code
# (render doesn't 500), but we generate on upgrade so the keypair is
# ready by the time Model J's pipeline.authorize() lands. Idempotent.
if [ -f "$SCRIPT_DIR/.env" ]; then
  if ! grep -q '^XRAY_PIPELINE_JWT_PRIVATE_KEY=.\+' "$SCRIPT_DIR/.env" 2>/dev/null; then
    echo "  [5b0] Generating pipeline JWT RS256 keypair..."
    PIPELINE_JWT_DIR=$(mktemp -d)
    if openssl genrsa -out "$PIPELINE_JWT_DIR/private.pem" 2048 >/dev/null 2>&1 \
       && openssl rsa -in "$PIPELINE_JWT_DIR/private.pem" -pubout -out "$PIPELINE_JWT_DIR/public.pem" >/dev/null 2>&1; then
      PIPELINE_PRIV=$(base64 -w0 < "$PIPELINE_JWT_DIR/private.pem")
      PIPELINE_PUB=$(base64 -w0 < "$PIPELINE_JWT_DIR/public.pem")
      cat >> "$SCRIPT_DIR/.env" <<PIPELINEJWTEOF

# ─── Pipeline JWT (RS256 keypair for xray-pipeline audience) ───
XRAY_PIPELINE_JWT_PRIVATE_KEY=${PIPELINE_PRIV}
XRAY_PIPELINE_JWT_PUBLIC_KEY=${PIPELINE_PUB}
PIPELINEJWTEOF
      ok "Pipeline JWT keypair generated and appended to .env"
      docker compose restart server >/dev/null 2>&1 && ok "Server restarted with pipeline keypair" || true
    else
      warn "Could not generate pipeline JWT keypair — render path will skip minting until fixed"
    fi
    rm -rf "$PIPELINE_JWT_DIR"
  else
    ok "Pipeline JWT keypair already configured"
  fi

  # Seed XRAY_OAUTH_REDIRECT_URI from APP_URL if absent. Admin can
  # override later for multi-domain setups.
  if ! grep -q '^XRAY_OAUTH_REDIRECT_URI=.\+' "$SCRIPT_DIR/.env" 2>/dev/null; then
    APP_URL_VAL=$(grep -oP '^APP_URL=\K.*' "$SCRIPT_DIR/.env" 2>/dev/null || echo "")
    if [ -n "$APP_URL_VAL" ]; then
      REDIRECT_URI="${APP_URL_VAL%/}/api/oauth/callback"
      cat >> "$SCRIPT_DIR/.env" <<OAUTHREDIRECTEOF

# ─── OAuth callback URL (register with each provider) ───
XRAY_OAUTH_REDIRECT_URI=${REDIRECT_URI}
OAUTHREDIRECTEOF
      ok "XRAY_OAUTH_REDIRECT_URI seeded: ${REDIRECT_URI}"
    fi
  fi
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
# Idempotent. Rewrites any plaintext rows in webhooks.secret and
# connections.connection_details as enc:v1 envelopes. Skips
# already-encrypted rows. Harmless on fresh DBs with no plaintext rows.
# (The dashboards.fetch_headers entry was removed in step 3 alongside
# migration 020.) See CONTEXT.md.
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

# ── Step 8: Self-verify the role-split deploy ──
# Catches the failure mode that prompted PR #283's hotfix: .env got
# DB_APP_USER, the role got created, but the server kept connecting
# under the bootstrap xray role because docker compose didn't
# recreate. WARN-don't-fail: surfaces the regression but doesn't
# abort the script (the server is up either way; RLS just stays
# decorative until the operator force-recreates manually).
if [ -x "$SCRIPT_DIR/scripts/test-update-role-split.sh" ]; then
  echo "  [8/8] Verifying role-split deploy..."
  if "$SCRIPT_DIR/scripts/test-update-role-split.sh"; then
    ok "Role-split self-verify passed"
  else
    warn "Role-split self-verify FAILED — review output above. Common recovery:"
    warn "  docker compose up -d --force-recreate --no-deps server"
  fi
fi

echo ""
ok "Update complete!"
echo ""
