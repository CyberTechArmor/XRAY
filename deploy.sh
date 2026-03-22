#!/bin/bash
# XRay deploy script — updates frontend + rebuilds server container + runs migrations
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo "=== [1/4] Deploying frontend files to /var/www/xray ==="
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
chown -R www-data:www-data /var/www/xray 2>/dev/null || true

echo "=== [2/4] Rebuilding and restarting server container ==="
docker compose up -d --build server

echo "=== [3/4] Running database migrations ==="
# Get the postgres container name
PG_CONTAINER=$(docker compose ps -q postgres)
if [ -n "$PG_CONTAINER" ]; then
  for migration in migrations/*.sql; do
    if [ -f "$migration" ]; then
      echo "  running $migration..."
      docker cp "$migration" "$PG_CONTAINER:/tmp/migration.sql"
      docker exec "$PG_CONTAINER" psql -U "${DB_USER:-xray}" -d "${DB_NAME:-xray}" -f /tmp/migration.sql 2>&1 | grep -v "^$" | head -5
    fi
  done
else
  echo "  WARNING: postgres container not found, skipping migrations"
fi

echo "=== [4/4] Reloading nginx ==="
nginx -t && systemctl reload nginx

echo ""
echo "Deploy complete! Check: docker compose logs -f server"
