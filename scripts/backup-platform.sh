#!/usr/bin/env bash
# Platform DB — base backup driver.
#
# Runs `pg_basebackup` against the platform Postgres container into a
# timestamped directory under the local backup volume. Pairs with
# `scripts/wal-archive.sh` (continuous WAL archiving) and
# `scripts/restore-drill.sh` (verifies the backup is restorable).
#
# Local-first by design (operator preference): the local volume is the
# primary target. S3 mirroring layers on top in step 12 (B2) and is
# env-var-gated — no S3 credentials means local-only runs work
# unchanged.
#
# Idempotent: each run produces a new timestamped directory; existing
# directories aren't touched. Retention is enforced by the prune step
# at the end of the run (default: keep 14 days of base backups).
#
# Operator schedules via host cron, e.g. for nightly at 02:30 UTC:
#
#   30 2 * * * /opt/xray/scripts/backup-platform.sh >> /var/log/xray-backup.log 2>&1
#
# Required env (defaults match docker-compose.yml):
#   BACKUP_ROOT          — local backup root.    Default: /var/lib/postgresql/backups
#   POSTGRES_CONTAINER   — compose service name. Default: postgres
#   PGUSER / PGPASSWORD  — replication-capable user. Defaults: $DB_USER / $DB_PASSWORD
#                          from the running compose .env.
#   BACKUP_RETAIN_DAYS   — base-backup retention in days. Default: 14.

set -euo pipefail

BACKUP_ROOT="${BACKUP_ROOT:-/var/lib/postgresql/backups}"
POSTGRES_CONTAINER="${POSTGRES_CONTAINER:-postgres}"
RETAIN_DAYS="${BACKUP_RETAIN_DAYS:-14}"

# pg_basebackup connects via the host network (after compose-port-
# mapping the postgres service) by default. We instead exec the
# pg_basebackup that already ships in the postgres image — no host
# install needed and we avoid leaking PGPASSWORD onto the host shell.
TS="$(date -u +%Y%m%dT%H%M%SZ)"
LOCAL_BASE_DIR="${BACKUP_ROOT}/base/${TS}"

echo "[backup-platform] starting base backup → ${LOCAL_BASE_DIR}"

# Run pg_basebackup INSIDE the postgres container so it writes to the
# named-volume path that the archive script also writes to. -Ft
# (tar format) gives us a single base.tar.gz + pg_wal.tar.gz pair —
# straightforward to restore on a fresh host.
docker compose exec -T \
  -e PGPASSWORD="${PGPASSWORD:-${DB_PASSWORD:-}}" \
  "${POSTGRES_CONTAINER}" \
  sh -c "
    set -eu
    mkdir -p '${LOCAL_BASE_DIR}'
    pg_basebackup \
      -h /var/run/postgresql \
      -U '${PGUSER:-${DB_USER:-xray}}' \
      -D '${LOCAL_BASE_DIR}' \
      -Ft -z -X fetch \
      -P -v \
      --label='xray-platform-${TS}'
  "

# Manifest — captures restore metadata so the operator (or the
# restore drill) can pick the right base backup without reading
# pg_basebackup's binary headers. Plain text, version-stamped.
docker compose exec -T "${POSTGRES_CONTAINER}" sh -c "
  cat > '${LOCAL_BASE_DIR}/MANIFEST.txt' <<MANIFEST_EOF
xray-backup-version: 1
backup-kind: pg_basebackup-tar-gz
created-at: ${TS}
postgres-version: \$(psql -U '${PGUSER:-${DB_USER:-xray}}' -h /var/run/postgresql -At -c 'SHOW server_version' || echo unknown)
db-name: ${DB_NAME:-xray}
files:
  - base.tar.gz
  - pg_wal.tar.gz (transient WAL segments captured during base — replay starts here)
restore-with: scripts/restore-drill.sh ${TS}
MANIFEST_EOF
"

echo "[backup-platform] base backup complete: ${LOCAL_BASE_DIR}"

# Retention prune — drop base-backup directories older than $RETAIN_DAYS.
# Keeps the most recent backup unconditionally so a misconfigured
# RETAIN_DAYS=0 doesn't leave us empty-handed. find -mtime is the
# portable mechanism (busybox `date` in Alpine doesn't accept
# "N days ago" syntax).
echo "[backup-platform] pruning base backups + WAL older than ${RETAIN_DAYS} days"
docker compose exec -T "${POSTGRES_CONTAINER}" sh -c "
  set -eu
  KEEP_LATEST=\$(ls -1 '${BACKUP_ROOT}/base' 2>/dev/null | sort | tail -n 1 || true)
  if [ -n \"\${KEEP_LATEST:-}\" ]; then
    find '${BACKUP_ROOT}/base' -mindepth 1 -maxdepth 1 -type d \
      -mtime +${RETAIN_DAYS} \
      ! -name \"\$KEEP_LATEST\" \
      -print -exec rm -rf -- {} +
  fi

  # WAL pruning by mtime. WAL segment names sort lexicographically by
  # LSN, but parsing the oldest retained base's start LSN to do
  # name-based pruning is fragile; mtime-based is approximate but safe
  # because Postgres only recycles WAL after archive_command succeeds.
  if [ -d '${BACKUP_ROOT}/wal' ]; then
    find '${BACKUP_ROOT}/wal' -maxdepth 1 -type f -name '0*' \
      -mtime +${RETAIN_DAYS} -delete 2>/dev/null || true
  fi
"

# S3 mirror — additive, env-var-gated. Local-only deploys never reach
# this branch. Failures surface in cron output but don't abort the
# script (the local backup is already safe).
if [ -n "${BACKUP_S3_BUCKET:-}" ]; then
  echo "[backup-platform] mirroring base + WAL to S3"
  SCRIPT_DIR_BP="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  "${SCRIPT_DIR_BP}/backup-s3-sync.sh" base || \
    echo "[backup-platform] WARN: S3 base sync failed; local backup still valid"
  "${SCRIPT_DIR_BP}/backup-s3-sync.sh" wal || \
    echo "[backup-platform] WARN: S3 WAL sync failed; local archive still valid"
else
  echo "[backup-platform] BACKUP_S3_BUCKET unset — skipping S3 mirror (local-only mode)"
fi

echo "[backup-platform] done"
