#!/usr/bin/env bash
# Platform DB — S3 mirror layer.
#
# Layers on top of scripts/backup-platform.sh + scripts/wal-archive.sh
# (B1) without changing them. The local volume stays the source of
# truth; this script just mirrors what's already there to an
# S3-compatible offsite bucket. If BACKUP_S3_BUCKET is unset, exits
# silently — the local-only path keeps working.
#
# Decoupled from Postgres on purpose: archive_command writes to the
# local volume and ALWAYS succeeds (assuming local disk has space).
# S3 unreachable doesn't make Postgres back up WAL into pg_wal until
# the disk fills — exactly the failure mode you don't want under
# network glitches.
#
# Operator schedules:
#
#   # Mirror new WAL segments to S3 every 5 minutes
#   */5 * * * * /opt/xray/scripts/backup-s3-sync.sh wal >> /var/log/xray-backup.log 2>&1
#
#   # Mirror new base backups to S3 (called by backup-platform.sh
#   # automatically; can also be invoked standalone for one-shot syncs)
#   /opt/xray/scripts/backup-s3-sync.sh base
#
#   # Mirror everything (handy after the cold-restore staging completes)
#   /opt/xray/scripts/backup-s3-sync.sh all
#
# Env (all from .env at the repo root or the host shell):
#   BACKUP_S3_BUCKET            — required to enable S3 mirror
#   BACKUP_S3_ENDPOINT          — e.g. https://s3.us-east-005.backblazeb2.com
#                                  (omit for AWS S3)
#   BACKUP_S3_REGION            — default: us-east-1
#   BACKUP_S3_ACCESS_KEY_ID     — required
#   BACKUP_S3_SECRET_ACCESS_KEY — required
#   BACKUP_S3_PREFIX            — key prefix in the bucket. Default: platform
#   BACKUP_S3_CLIENT_IMAGE      — aws-cli image. Default: amazon/aws-cli:latest
#   BACKUP_VOLUME_NAME          — docker named volume. Default: xray_pg_backups

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Source .env so cron-invoked runs pick up S3 settings without an
# explicit `--env-file`. set -a turns auto-export on so `source` exports
# every assigned name into the environment.
if [ -f "${SCRIPT_DIR}/../.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "${SCRIPT_DIR}/../.env"
  set +a
fi

if [ -z "${BACKUP_S3_BUCKET:-}" ]; then
  echo "[backup-s3-sync] BACKUP_S3_BUCKET unset — local-only mode; skipping S3 mirror"
  exit 0
fi

if [ -z "${BACKUP_S3_ACCESS_KEY_ID:-}" ] || [ -z "${BACKUP_S3_SECRET_ACCESS_KEY:-}" ]; then
  echo "[backup-s3-sync] BACKUP_S3_ACCESS_KEY_ID / BACKUP_S3_SECRET_ACCESS_KEY required when BACKUP_S3_BUCKET is set" >&2
  exit 64
fi

MODE="${1:-all}"
PREFIX="${BACKUP_S3_PREFIX:-platform}"
VOLUME_NAME="${BACKUP_VOLUME_NAME:-xray_pg_backups}"
CLIENT_IMAGE="${BACKUP_S3_CLIENT_IMAGE:-amazon/aws-cli:latest}"
REGION="${BACKUP_S3_REGION:-us-east-1}"

ENDPOINT_FLAG=()
if [ -n "${BACKUP_S3_ENDPOINT:-}" ]; then
  ENDPOINT_FLAG=(--endpoint-url "${BACKUP_S3_ENDPOINT}")
fi

run_aws() {
  # Mount the backups named volume read-only so a misbehaving aws-cli
  # can't corrupt the local source of truth. -t omitted (we're not
  # interactive); cron-friendly.
  docker run --rm \
    -e AWS_ACCESS_KEY_ID="${BACKUP_S3_ACCESS_KEY_ID}" \
    -e AWS_SECRET_ACCESS_KEY="${BACKUP_S3_SECRET_ACCESS_KEY}" \
    -e AWS_DEFAULT_REGION="${REGION}" \
    -v "${VOLUME_NAME}:/data:ro" \
    "${CLIENT_IMAGE}" \
    "$@"
}

case "$MODE" in
  wal)
    # Per-WAL: append-only on the local side (wal-archive.sh refuses
    # overwrites), so size-only diff is enough — `aws s3 sync` skips
    # files whose size matches the remote object. --no-progress for
    # cron-friendly logs. Don't --delete; WAL retention prune happens
    # locally first and we explicitly schedule remote pruning via the
    # `prune` mode (operator-driven, not part of the cron loop).
    run_aws s3 sync /data/wal/ "s3://${BACKUP_S3_BUCKET}/${PREFIX}/wal/" \
      "${ENDPOINT_FLAG[@]}" --no-progress --size-only
    echo "[backup-s3-sync] WAL sync done"
    ;;
  base)
    run_aws s3 sync /data/base/ "s3://${BACKUP_S3_BUCKET}/${PREFIX}/base/" \
      "${ENDPOINT_FLAG[@]}" --no-progress --size-only
    echo "[backup-s3-sync] base sync done"
    ;;
  all)
    run_aws s3 sync /data/ "s3://${BACKUP_S3_BUCKET}/${PREFIX}/" \
      "${ENDPOINT_FLAG[@]}" --no-progress --size-only
    echo "[backup-s3-sync] full sync done"
    ;;
  prune)
    # Operator-driven remote prune. Mirrors local retention by
    # deleting any remote object whose key isn't present locally
    # anymore. --delete on a sync is the simplest way to express this.
    # Run after the local prune in scripts/backup-platform.sh has
    # already executed for the day.
    run_aws s3 sync /data/ "s3://${BACKUP_S3_BUCKET}/${PREFIX}/" \
      "${ENDPOINT_FLAG[@]}" --no-progress --size-only --delete
    echo "[backup-s3-sync] remote prune (sync --delete) done"
    ;;
  *)
    echo "Usage: $0 {wal|base|all|prune}" >&2
    exit 64
    ;;
esac
