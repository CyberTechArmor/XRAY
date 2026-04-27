#!/usr/bin/env bash
# Operator-runs-on-VPS regression test for the role-split deploy path.
#
# After ./update.sh (or ./install.sh) on a host where PR #283 +
# follow-up landed, this script verifies that the server pool actually
# switched to the non-owner xray_app role and that RLS is enforcing.
# Designed to catch the failure mode that prompted PR #283's hotfix:
# .env got DB_APP_USER, the role got created, but the server kept
# connecting under the bootstrap xray role because step 5's
# `docker compose up -d` didn't force-recreate.
#
# Run it on the deploy host (the one running docker compose) AFTER
# update.sh completes:
#
#   ./scripts/test-update-role-split.sh
#
# This script is intentionally NOT run in CI — CI uses a separate
# postgres:16-alpine service container without docker-compose, so the
# state it would test (a running compose stack) doesn't exist there.
# The CI-side coverage of the same contract is the rls-probe (platform)
# job in .github/workflows/ci.yml, which exercises the SQL-level RLS
# policy + non-owner role contract on every PR.
#
# Exit codes:
#   0  all checks PASS
#   1  one or more checks FAIL — output identifies which
#   64 usage / environment error (no .env, no docker, etc.)

set -euo pipefail

RED=$'\033[0;31m'; GREEN=$'\033[0;32m'; YELLOW=$'\033[1;33m'; NC=$'\033[0m'
ok()   { echo "  ${GREEN}✓${NC} $1"; }
warn() { echo "  ${YELLOW}!${NC} $1"; }
fail() { echo "  ${RED}✗${NC} $1"; FAILS=$((FAILS + 1)); }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
FAILS=0

if ! command -v docker >/dev/null 2>&1; then
  echo "docker not on PATH — run this on the deploy host" >&2
  exit 64
fi

if [ ! -f "${ROOT_DIR}/.env" ]; then
  echo ".env not found at ${ROOT_DIR}/.env — run from the repo root" >&2
  exit 64
fi

# Source .env so DB_APP_USER / DB_USER / DB_NAME / APP_PORT are in scope.
set -a
# shellcheck disable=SC1091
. "${ROOT_DIR}/.env"
set +a

DB_USER="${DB_USER:-xray}"
DB_APP_USER="${DB_APP_USER:-xray_app}"
DB_NAME="${DB_NAME:-xray}"
APP_PORT="${APP_PORT:-3000}"

cd "${ROOT_DIR}"

echo ""
echo "  ╔═══════════════════════════════════════════════════════╗"
echo "  ║   XRay role-split regression test                     ║"
echo "  ╚═══════════════════════════════════════════════════════╝"
echo ""
echo "  DB_USER=${DB_USER}  DB_APP_USER=${DB_APP_USER}  APP_PORT=${APP_PORT}"
echo ""

PG_CONTAINER="$(docker compose ps -q postgres 2>/dev/null || true)"
if [ -z "$PG_CONTAINER" ]; then
  echo "  ${RED}✗${NC} postgres compose service not running — start the stack first" >&2
  exit 64
fi

# ── Check 1: .env has DB_APP_USER + DB_APP_PASSWORD ─────────────
if grep -q '^DB_APP_USER=.\+' "${ROOT_DIR}/.env" \
   && grep -q '^DB_APP_PASSWORD=.\+' "${ROOT_DIR}/.env"; then
  ok ".env has DB_APP_USER + DB_APP_PASSWORD"
else
  fail ".env missing DB_APP_USER or DB_APP_PASSWORD — re-run update.sh"
fi

# ── Check 2: xray_app role exists, NOT superuser ────────────────
ROLE_INFO="$(docker exec "$PG_CONTAINER" psql -tA -U "$DB_USER" -d "$DB_NAME" \
  -c "SELECT rolsuper::text || ',' || rolbypassrls::text FROM pg_roles WHERE rolname='${DB_APP_USER}'" \
  2>/dev/null || true)"
if [ -z "$ROLE_INFO" ]; then
  fail "${DB_APP_USER} role does not exist in postgres"
elif [ "$ROLE_INFO" = "f,f" ]; then
  ok "${DB_APP_USER} role exists with rolsuper=f, rolbypassrls=f"
else
  fail "${DB_APP_USER} has wrong attributes: ${ROLE_INFO} (expect f,f)"
fi

# ── Check 3: server pool is connecting as xray_app, NOT xray ────
# pg_stat_activity lists every active backend; the server pool keeps
# 1+ idle connections plus an active one per request. Anything connected
# under the application database that ISN'T the deploy script itself
# should be on DB_APP_USER.
POOL_BREAKDOWN="$(docker exec "$PG_CONTAINER" psql -tA -U "$DB_USER" -d "$DB_NAME" -F'|' \
  -c "SELECT usename, count(*) FROM pg_stat_activity
       WHERE datname='${DB_NAME}' AND application_name <> 'psql'
       GROUP BY usename ORDER BY usename" \
  2>/dev/null || true)"
echo "    pg_stat_activity (datname=${DB_NAME}, excl. psql):"
echo "$POOL_BREAKDOWN" | sed 's/^/      /'

APP_CONNS="$(echo "$POOL_BREAKDOWN" | awk -F'|' -v u="$DB_APP_USER" '$1==u {print $2}')"
XRAY_CONNS="$(echo "$POOL_BREAKDOWN" | awk -F'|' -v u="$DB_USER" '$1==u {print $2}')"

if [ -n "${APP_CONNS:-}" ] && [ "${APP_CONNS:-0}" -gt 0 ]; then
  ok "server pool has ${APP_CONNS} connection(s) under ${DB_APP_USER}"
else
  fail "server pool has NO connections under ${DB_APP_USER} — recreate didn't take effect"
fi

if [ -n "${XRAY_CONNS:-}" ] && [ "${XRAY_CONNS:-0}" -gt 0 ]; then
  fail "server pool still has ${XRAY_CONNS} connection(s) under ${DB_USER} — RLS will be bypassed for those queries"
fi

# ── Check 4: cross-tenant SQL probe passes as xray_app ──────────
# Confirms the policies actually fire for the role the application
# uses. Mirrors what the rls-probe (platform) CI job does, but against
# the live compose stack.
PROBE_PATH="${ROOT_DIR}/migrations/probes/probe-rls-cross-tenant.sql"
if [ ! -f "$PROBE_PATH" ]; then
  warn "probe SQL not found at ${PROBE_PATH} — skipping cross-tenant check"
else
  docker cp "$PROBE_PATH" "$PG_CONTAINER:/tmp/probe-rls-cross-tenant.sql" >/dev/null 2>&1 || true
  PROBE_OUT="$(docker exec -e PGPASSWORD="${DB_APP_PASSWORD:-}" "$PG_CONTAINER" \
    psql -U "$DB_APP_USER" -d "$DB_NAME" -f /tmp/probe-rls-cross-tenant.sql 2>&1 || true)"
  if echo "$PROBE_OUT" | grep -q "PROBE PASS"; then
    ok "cross-tenant SQL probe: PROBE PASS"
  else
    fail "cross-tenant SQL probe did NOT pass — output:"
    echo "$PROBE_OUT" | sed 's/^/      /'
  fi
fi

# ── Check 5: /api/health is healthy ─────────────────────────────
# Loopback-only since compose binds 127.0.0.1:${APP_PORT}.
HEALTH_CODE="$(curl -fsS -o /dev/null -w '%{http_code}' "http://127.0.0.1:${APP_PORT}/api/health" 2>/dev/null || echo "000")"
if [ "$HEALTH_CODE" = "200" ]; then
  ok "/api/health returns 200"
else
  fail "/api/health returned ${HEALTH_CODE} (expected 200)"
fi

echo ""
if [ "$FAILS" -eq 0 ]; then
  echo "  ${GREEN}All checks PASS — role-split deploy is healthy.${NC}"
  echo ""
  exit 0
else
  echo "  ${RED}${FAILS} check(s) FAILED.${NC}"
  echo "  Inspect output above; the most common failure mode is the"
  echo "  server keeping its old DATABASE_URL because docker compose"
  echo "  didn't recreate it. Recover with:"
  echo ""
  echo "    docker compose up -d --force-recreate --no-deps server"
  echo ""
  exit 1
fi
