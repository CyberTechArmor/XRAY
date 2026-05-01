#!/bin/bash
# XRay deploy script — updates frontend + rebuilds server container + runs migrations
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# Load env vars for DB credentials
if [ -f "$SCRIPT_DIR/.env" ]; then
  set -a; source "$SCRIPT_DIR/.env"; set +a
fi

echo "=== [1/6] Deploying frontend files to /var/www/xray ==="
mkdir -p /var/www/xray/bundles
for f in index.html app.css app.js landing.css landing.js manifest.json sw.js icon.svg icon-192.png icon-512.png share.html; do
  if [ -f "$SCRIPT_DIR/frontend/$f" ]; then
    cp "$SCRIPT_DIR/frontend/$f" /var/www/xray/
    echo "  copied $f"
  fi
done
if [ -d "$SCRIPT_DIR/frontend/bundles" ]; then
  cp "$SCRIPT_DIR/frontend/bundles/"* /var/www/xray/bundles/
  echo "  copied bundles/"
fi
for d in ai; do
  if [ -d "$SCRIPT_DIR/frontend/$d" ]; then
    mkdir -p "/var/www/xray/$d"
    cp -r "$SCRIPT_DIR/frontend/$d/"* "/var/www/xray/$d/"
    echo "  copied $d/"
  fi
done
chown -R www-data:www-data /var/www/xray 2>/dev/null || true

echo "=== [2/6] Running pre-rebuild migrations ==="
# Pre-rebuild: additive schema changes only (ADD COLUMN, new tables, new
# triggers on new columns). New code needs the new columns present
# before it boots, so these run BEFORE the rebuild.
# Destructive changes (DROP COLUMN etc) live in migrations/post-rebuild/
# and run AFTER the rebuild — see step [4/6].
PG_CONTAINER=$(docker compose ps -q postgres)

# platform.schema_migrations ledger — short-circuits already-applied
# files so a deploy with no new migrations does no docker-exec round-
# trips per file (was 50+ before, scaling linearly with migrations/).
ensure_migrations_ledger() {
  [ -n "$PG_CONTAINER" ] || return 0
  docker exec "$PG_CONTAINER" psql -U "${DB_USER:-xray}" -d "${DB_NAME:-xray}" -v ON_ERROR_STOP=1 -q -c "
    CREATE SCHEMA IF NOT EXISTS platform;
    CREATE TABLE IF NOT EXISTS platform.schema_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  " >/dev/null 2>&1 || true
}

migration_already_applied() {
  local key="$1"
  local escaped
  escaped=$(printf '%s' "$key" | sed "s/'/''/g")
  docker exec "$PG_CONTAINER" psql -U "${DB_USER:-xray}" -d "${DB_NAME:-xray}" -t -A -c \
    "SELECT 1 FROM platform.schema_migrations WHERE filename = '$escaped' LIMIT 1" 2>/dev/null | grep -q 1
}

record_migration_applied() {
  local key="$1"
  local escaped
  escaped=$(printf '%s' "$key" | sed "s/'/''/g")
  docker exec "$PG_CONTAINER" psql -U "${DB_USER:-xray}" -d "${DB_NAME:-xray}" -q -c \
    "INSERT INTO platform.schema_migrations (filename) VALUES ('$escaped') ON CONFLICT DO NOTHING" >/dev/null 2>&1 || true
}

run_migrations_dir() {
  local dir="$1"; local label="$2"
  [ -d "$dir" ] || return 0
  [ -n "$PG_CONTAINER" ] || { echo "  WARNING: postgres container not found, skipping $label"; return 0; }
  ensure_migrations_ledger
  local applied=0 skipped=0
  for migration in "$dir"/*.sql; do
    [ -f "$migration" ] || continue
    local mname
    mname=$(basename "$migration")
    local key="$label/$mname"
    if migration_already_applied "$key"; then
      skipped=$((skipped + 1))
      continue
    fi
    echo "  running $key..."
    docker cp "$migration" "$PG_CONTAINER:/tmp/$mname"
    local out rc
    out=$(docker exec "$PG_CONTAINER" psql -v ON_ERROR_STOP=1 -U "${DB_USER:-xray}" -d "${DB_NAME:-xray}" -f "/tmp/$mname" 2>&1)
    rc=$?
    echo "$out" | grep -E "^(CREATE|ALTER|INSERT|DROP|ERROR)" | head -5
    if [ $rc -eq 0 ]; then
      record_migration_applied "$key"
      applied=$((applied + 1))
    else
      echo "  ERROR running $key — bailing"
      return 1
    fi
  done
  echo "  $label: $applied applied, $skipped skipped (already in ledger)"
}

if [ -n "$PG_CONTAINER" ] && [ -d "$SCRIPT_DIR/migrations" ]; then
  # Wait for postgres to be ready
  for i in $(seq 1 15); do
    if docker exec "$PG_CONTAINER" pg_isready -U "${DB_USER:-xray}" >/dev/null 2>&1; then
      break
    fi
    sleep 1
  done

  run_migrations_dir "$SCRIPT_DIR/migrations" "pre-rebuild"
else
  echo "  WARNING: postgres container not found, skipping migrations"
fi

echo "=== [3/6] Rebuilding and restarting server container ==="
docker compose up -d --build server

echo "=== [4/6] Running post-rebuild migrations ==="
# Destructive schema changes (DROP COLUMN etc). Safe only after the new
# container is serving requests, because no code path in the new image
# references the dropped columns.
run_migrations_dir "$SCRIPT_DIR/migrations/post-rebuild" "post-rebuild"

echo "=== [5/6] Running credential backfill ==="
SERVER_CONTAINER=$(docker compose ps -q server 2>/dev/null || echo "")
if [ -n "$SERVER_CONTAINER" ]; then
  if docker compose exec -T server test -f dist/scripts/backfill-encrypt-credentials.js 2>/dev/null; then
    docker compose exec -T server node dist/scripts/backfill-encrypt-credentials.js 2>&1 | sed 's/^/  /'
  else
    echo "  (backfill script not in image — skipping)"
  fi
else
  echo "  WARNING: server container not running, skipping backfill"
fi

echo "=== [6/6] Reloading nginx ==="
nginx -t && systemctl reload nginx

echo ""
echo "Deploy complete!"
echo "  Check server logs: docker compose logs -f server"
echo "  Check health:      curl -s http://127.0.0.1:${APP_PORT:-3000}/api/health"
