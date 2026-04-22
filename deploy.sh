#!/bin/bash
# XRay deploy script — updates frontend + rebuilds server container + runs migrations
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# Load env vars for DB credentials
if [ -f "$SCRIPT_DIR/.env" ]; then
  set -a; source "$SCRIPT_DIR/.env"; set +a
fi

echo "=== [1/5] Deploying frontend files to /var/www/xray ==="
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

echo "=== [2/5] Running database migrations ==="
# Ordered BEFORE the rebuild so the new code boots into a schema that
# already has any new columns it SELECTs. Running migrations after the
# rebuild creates a race where render calls 500 until the last migration
# lands.
PG_CONTAINER=$(docker compose ps -q postgres)
if [ -n "$PG_CONTAINER" ] && [ -d "$SCRIPT_DIR/migrations" ]; then
  # Wait for postgres to be ready
  for i in $(seq 1 15); do
    if docker exec "$PG_CONTAINER" pg_isready -U "${DB_USER:-xray}" >/dev/null 2>&1; then
      break
    fi
    sleep 1
  done

  for migration in "$SCRIPT_DIR"/migrations/*.sql; do
    [ -f "$migration" ] || continue
    MNAME=$(basename "$migration")
    echo "  running $MNAME..."
    docker cp "$migration" "$PG_CONTAINER:/tmp/$MNAME"
    docker exec "$PG_CONTAINER" psql -U "${DB_USER:-xray}" -d "${DB_NAME:-xray}" -f "/tmp/$MNAME" 2>&1 | grep -E "^(CREATE|ALTER|INSERT|ERROR)" | head -5
  done
else
  echo "  WARNING: postgres container not found, skipping migrations"
fi

echo "=== [3/5] Rebuilding and restarting server container ==="
docker compose up -d --build server

echo "=== [4/5] Running credential backfill ==="
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

echo "=== [5/5] Reloading nginx ==="
nginx -t && systemctl reload nginx

echo ""
echo "Deploy complete!"
echo "  Check server logs: docker compose logs -f server"
echo "  Check health:      curl -s http://127.0.0.1:${APP_PORT:-3000}/api/health"
