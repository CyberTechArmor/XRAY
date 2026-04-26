#!/usr/bin/env bash
# Platform DB — restore drill.
#
# Spins up a SIDECAR Postgres container, restores the latest local
# base backup + replays WAL into it, runs a schema + smoke query,
# and tears down. NEVER touches the live platform DB.
#
# Operator runs this monthly (or before any cold-restore window) to
# prove the backups are actually restorable. The drill output is
# captured verbatim in docs/operator.md as evidence the restore path
# works.
#
# Usage:
#   ./scripts/restore-drill.sh [options]
#     --base <TS|latest>      Base-backup directory under
#                             pg_backups/base/. Default: latest.
#     --target-time <ISO>     PITR target (recovery_target_time).
#                             Default: replay all available WAL.
#     --from-s3               Stage base + WAL from S3 first
#                             (cold-restore-from-S3 dry-run). Requires
#                             BACKUP_S3_BUCKET + creds.
#     --keep                  Don't tear down on success — useful for
#                             interactive triage. Drill volume + sidecar
#                             will be left in place; rerun --teardown
#                             to clean up.
#     --teardown              Stop + remove the sidecar + drill volume,
#                             whether the previous run errored out or
#                             was --keep'd.
#
# Exit codes:
#   0  drill PASS — schema present, smoke query returns at least one
#      row from platform.tenants (or zero rows if the DB has none yet
#      but the table exists)
#   1  drill FAIL — any step errored; sidecar left in place for triage
#   64 usage error

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Source .env for DB_USER / DB_NAME / S3 creds.
if [ -f "${SCRIPT_DIR}/../.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "${SCRIPT_DIR}/../.env"
  set +a
fi

DB_USER="${DB_USER:-xray}"
DB_NAME="${DB_NAME:-xray}"
VOLUME_NAME="${BACKUP_VOLUME_NAME:-xray_pg_backups}"
SIDECAR_NAME="xray-restore-drill"
SIDECAR_VOLUME="xray_restore_drill_data"
SIDECAR_IMAGE="postgres:16-alpine"

# ── Argument parsing ─────────────────────────────────────────────
BASE="latest"
TARGET_TIME=""
FROM_S3="false"
KEEP="false"
TEARDOWN_ONLY="false"

while [ $# -gt 0 ]; do
  case "$1" in
    --base)         BASE="$2"; shift 2 ;;
    --target-time)  TARGET_TIME="$2"; shift 2 ;;
    --from-s3)      FROM_S3="true"; shift ;;
    --keep)         KEEP="true"; shift ;;
    --teardown)     TEARDOWN_ONLY="true"; shift ;;
    -h|--help)
      sed -n '3,30p' "$0" | sed 's/^#\s\?//'
      exit 0
      ;;
    *) echo "unknown arg: $1" >&2; exit 64 ;;
  esac
done

teardown() {
  docker rm -f "${SIDECAR_NAME}" >/dev/null 2>&1 || true
  docker volume rm "${SIDECAR_VOLUME}" >/dev/null 2>&1 || true
}

if [ "$TEARDOWN_ONLY" = "true" ]; then
  echo "[restore-drill] tearing down sidecar + drill volume"
  teardown
  echo "[restore-drill] teardown done"
  exit 0
fi

# ── Stage source from S3 if requested ────────────────────────────
# Cold-restore dry-run: pulls base + WAL into the local pg_backups
# volume from S3 first. Mirrors what an operator would do on a fresh
# host that has nothing local yet.
if [ "$FROM_S3" = "true" ]; then
  if [ -z "${BACKUP_S3_BUCKET:-}" ]; then
    echo "[restore-drill] --from-s3 requires BACKUP_S3_BUCKET" >&2
    exit 64
  fi
  echo "[restore-drill] staging base + WAL from S3 → local volume"
  "${SCRIPT_DIR}/backup-s3-sync.sh" all
fi

# ── Resolve base-backup TS ───────────────────────────────────────
if [ "$BASE" = "latest" ]; then
  BASE=$(docker run --rm -v "${VOLUME_NAME}:/data:ro" "${SIDECAR_IMAGE}" \
         sh -c "ls -1 /data/base 2>/dev/null | sort | tail -n 1")
  if [ -z "$BASE" ]; then
    echo "[restore-drill] no base backups found in volume ${VOLUME_NAME}" >&2
    exit 1
  fi
fi
echo "[restore-drill] base backup: ${BASE}"
[ -n "$TARGET_TIME" ] && echo "[restore-drill] PITR target: ${TARGET_TIME}"

# ── Reset the sidecar (idempotent) ───────────────────────────────
teardown

# ── Spin up the sidecar with prepared PGDATA ─────────────────────
# Using `docker run --entrypoint sh` lets us extract the tarballs INTO
# the data volume before postgres starts. The official entrypoint
# would otherwise run initdb against an empty PGDATA — we want the
# OPPOSITE: a pre-populated PGDATA that postgres opens in recovery.
echo "[restore-drill] preparing sidecar PGDATA"
docker run --rm \
  -v "${VOLUME_NAME}:/backups:ro" \
  -v "${SIDECAR_VOLUME}:/var/lib/postgresql/data" \
  --entrypoint sh \
  "${SIDECAR_IMAGE}" \
  -c "
    set -eu
    cd /var/lib/postgresql/data
    rm -rf ./* ./.[!.]* 2>/dev/null || true
    tar -xzf /backups/base/${BASE}/base.tar.gz -C .
    mkdir -p pg_wal
    tar -xzf /backups/base/${BASE}/pg_wal.tar.gz -C pg_wal
    cat >> postgresql.auto.conf <<CFGEOF
# Restore drill — recovery configuration
restore_command = 'cp /backups/wal/%f %p'
CFGEOF
    if [ -n '${TARGET_TIME}' ]; then
      echo \"recovery_target_time = '${TARGET_TIME}'\" >> postgresql.auto.conf
      echo \"recovery_target_action = 'promote'\" >> postgresql.auto.conf
    fi
    touch recovery.signal
    chown -R postgres:postgres .
    chmod 700 .
  "

echo "[restore-drill] starting sidecar postgres in recovery"
docker run -d \
  --name "${SIDECAR_NAME}" \
  -v "${VOLUME_NAME}:/backups:ro" \
  -v "${SIDECAR_VOLUME}:/var/lib/postgresql/data" \
  -e POSTGRES_PASSWORD=drill \
  "${SIDECAR_IMAGE}" \
  postgres -c listen_addresses='localhost' >/dev/null

# ── Poll for ready (recovery may take a while; cap at 120s) ──────
echo -n "[restore-drill] waiting for recovery to complete"
READY="false"
for _ in $(seq 1 60); do
  if docker exec "${SIDECAR_NAME}" pg_isready -h /var/run/postgresql -U "${DB_USER}" -d "${DB_NAME}" >/dev/null 2>&1; then
    READY="true"
    echo ""
    break
  fi
  echo -n "."
  sleep 2
done

if [ "$READY" != "true" ]; then
  echo ""
  echo "[restore-drill] FAIL: postgres did not become ready within 120s"
  echo "[restore-drill] last 30 lines of sidecar log:"
  docker logs --tail 30 "${SIDECAR_NAME}" 2>&1 || true
  exit 1
fi

# ── Schema + smoke query ─────────────────────────────────────────
echo "[restore-drill] schema check (\d platform.tenants):"
docker exec "${SIDECAR_NAME}" psql -h /var/run/postgresql -U "${DB_USER}" -d "${DB_NAME}" -c "\d platform.tenants" \
  || { echo "[restore-drill] FAIL: \d platform.tenants errored"; exit 1; }

echo ""
echo "[restore-drill] smoke query (counts on key tables):"
docker exec "${SIDECAR_NAME}" psql -h /var/run/postgresql -U "${DB_USER}" -d "${DB_NAME}" -At <<'SQL'
\pset format aligned
SELECT 'tenants'   AS table, count(*) AS rows FROM platform.tenants
UNION ALL SELECT 'users',         count(*) FROM platform.users
UNION ALL SELECT 'dashboards',    count(*) FROM platform.dashboards
UNION ALL SELECT 'connections',   count(*) FROM platform.connections
UNION ALL SELECT 'audit_log',     count(*) FROM platform.audit_log
ORDER BY 1;
SQL

echo ""
echo "[restore-drill] PASS — schema present + smoke query OK"

if [ "$KEEP" = "true" ]; then
  echo "[restore-drill] --keep set; sidecar left running on container '${SIDECAR_NAME}'"
  echo "[restore-drill] tear down with: $0 --teardown"
else
  teardown
  echo "[restore-drill] teardown complete"
fi
