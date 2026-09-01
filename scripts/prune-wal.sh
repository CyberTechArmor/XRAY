#!/usr/bin/env bash
# WAL archive prune — reclaim archived WAL segments that no retained
# base backup could ever need.
#
# WHY THIS EXISTS
# ---------------
# scripts/wal-archive.sh is append-only by construction: Postgres
# hands it every completed segment and it copies that segment into
# the archive directory. Nothing on that path ever deletes.
#
# Before this script, the ONLY code that removed archived WAL was the
# prune step at the tail of backup-platform.sh. That coupling is the
# bug: an install that never ran a base backup — the shipped default,
# since every schedule in Admin → Backups starts disabled — kept
# 100% of every segment it had ever archived, forever. Postgres pads
# each segment to a full 16 MB regardless of how much real change it
# carries, and archive_timeout=300 forces a segment switch every five
# minutes of activity, so even a near-idle deployment writes tens of
# 16 MB files a day into a directory with no reaper.
#
# Decoupling the prune fixes that: it can now run on its own schedule,
# from the Backups admin UI, or by hand, without waiting on a base
# backup to happen first.
#
# SAFETY MODEL
# ------------
# WAL is only prunable relative to a base backup. A segment written
# before the oldest base backup's START WAL LOCATION can never be
# replayed onto any base we still hold, so it is dead weight. A
# segment at or after that point may be required to bring that base
# up to a consistent, recoverable state — deleting it silently makes
# the base unrestorable.
#
# So the anchor is ALWAYS the oldest base backup we still keep, read
# from that backup's own backup_label. It is never a clock. The
# pre-existing mtime-based prune in backup-platform.sh got this
# wrong: with the same BACKUP_RETAIN_DAYS applied to both base dirs
# and WAL, and the newest base kept unconditionally, a base older
# than the retention window survived while the WAL it needs was
# deleted out from under it. That backup restores to nothing.
#
# With no base backup at all, NOTHING is prunable and this script
# deletes nothing and says so. That is not a failure to fix in this
# script — it means the install has no recovery point, and the real
# remedy is to take a base backup (which then makes the whole
# accumulated archive prunable in one pass).
#
# Deletion is done by pg_archivecleanup, the tool Postgres ships for
# exactly this job. It understands segment naming, timeline history
# files, and .backup markers — all things a hand-rolled `find` gets
# wrong.
#
# Usage:
#   ./scripts/prune-wal.sh              # prune
#   ./scripts/prune-wal.sh --dry-run    # report what would go, delete nothing
#
# Env (defaults match docker-compose.yml):
#   BACKUP_ROOT         — local backup root. Default: /var/lib/postgresql/backups
#   POSTGRES_SERVICE    — compose service label. Default: postgres
#   POSTGRES_CONTAINER  — fallback container name if the label lookup misses

set -euo pipefail

BACKUP_ROOT="${BACKUP_ROOT:-/var/lib/postgresql/backups}"
DRY_RUN=0

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run|-n) DRY_RUN=1; shift ;;
    -h|--help)
      sed -n '2,60p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "[prune-wal] unknown argument: $1" >&2
      exit 64
      ;;
  esac
done

# Same container-resolution strategy as backup-platform.sh: ask the
# docker daemon by compose service label so this works from host cron
# (CWD has docker-compose.yml) and from the backup-worker sidecar
# (docker.sock mounted, no compose file) alike.
resolve_pg_container() {
  local found
  found=$(docker ps \
    --filter "label=com.docker.compose.service=${POSTGRES_SERVICE:-postgres}" \
    --filter "status=running" \
    --format "{{.ID}}" 2>/dev/null | head -1 || true)
  if [ -n "$found" ]; then
    echo "$found"
    return 0
  fi
  echo "${POSTGRES_CONTAINER:-postgres}"
}

PG_ID="$(resolve_pg_container)"
if [ -z "$PG_ID" ]; then
  echo "[prune-wal] FATAL: could not find a running postgres container" >&2
  exit 1
fi
echo "[prune-wal] resolved postgres container: ${PG_ID}"
if [ "$DRY_RUN" -eq 1 ]; then
  echo "[prune-wal] DRY RUN — no files will be deleted"
fi

# Everything below runs inside the postgres container: that is where
# the pg_backups volume is mounted read-write and where the Postgres
# binaries (pg_archivecleanup, tar) live. The server container mounts
# the same volume read-only on purpose, so it can report but not
# delete.
docker exec -i \
  -e BACKUP_ROOT="$BACKUP_ROOT" \
  -e DRY_RUN="$DRY_RUN" \
  "$PG_ID" sh -s <<'INNER_EOF'
set -eu

BASE_DIR="${BACKUP_ROOT}/base"
WAL_DIR="${BACKUP_ROOT}/wal"

if [ ! -d "$WAL_DIR" ]; then
  echo "[prune-wal] no WAL archive directory at ${WAL_DIR} — nothing to do"
  exit 0
fi

# Report the starting position so the operator can see the reclaim in
# the job output rather than having to SSH in and du.
seg_count_before=$(find "$WAL_DIR" -maxdepth 1 -type f -name '0*' | wc -l | tr -d ' ')
size_before=$(du -sk "$WAL_DIR" 2>/dev/null | awk '{print $1}')
echo "[prune-wal] archive before: ${seg_count_before} segments, ${size_before} KB"

# ── Anchor: the OLDEST base backup we still hold ──────────────
# Base directories are named after a UTC timestamp by
# backup-platform.sh, so lexicographic ascending IS chronological
# ascending. Deliberately not sorting on mtime: mtimes are unstable
# across bind mounts and network filesystems, and this decision
# decides what gets deleted.
OLDEST_BASE=$(ls -1 "$BASE_DIR" 2>/dev/null | sort | head -n 1 || true)

if [ -z "${OLDEST_BASE:-}" ]; then
  cat <<'NOBASE'
[prune-wal] NO BASE BACKUPS EXIST — refusing to delete any WAL.

  Archived WAL is only meaningful when replayed onto a base backup.
  With zero base backups on this volume, every segment in the archive
  is simultaneously (a) unable to restore anything by itself and
  (b) unsafe to delete, because the moment a base backup IS taken
  the segments around it become the recovery path.

  This is why the archive grew without bound: WAL archiving has been
  running since first boot, and the prune it depends on only ever ran
  as the last step of a base backup that never happened.

  REMEDY — take a base backup, then prune:
    Admin -> Backups -> "Backup now", then "Prune WAL"
  or over SSH:
    ./scripts/backup-platform.sh && ./scripts/prune-wal.sh

  The base backup establishes the recovery point; the prune then
  reclaims everything archived before it, which on a long-running
  install is very nearly the entire archive.

  To stop it recurring, enable the "Base backup" schedule in
  Admin -> Backups (suggested: 0 2 * * *). Each run prunes on the
  way out, so the archive settles at roughly one retention window.
NOBASE
  exit 0
fi

echo "[prune-wal] oldest retained base backup: ${OLDEST_BASE}"

# ── Read that base's START WAL file from its backup_label ─────
# pg_basebackup -Ft -z puts backup_label at the root of base.tar.gz.
# The line looks like:
#   START WAL LOCATION: 0/2000028 (file 000000010000000000000002)
# The parenthesised filename is exactly the "oldest file to keep"
# argument pg_archivecleanup wants.
LABEL=""
if [ -f "${BASE_DIR}/${OLDEST_BASE}/base.tar.gz" ]; then
  LABEL=$(tar -xzOf "${BASE_DIR}/${OLDEST_BASE}/base.tar.gz" backup_label 2>/dev/null || true)
elif [ -f "${BASE_DIR}/${OLDEST_BASE}/base.tar" ]; then
  LABEL=$(tar -xOf "${BASE_DIR}/${OLDEST_BASE}/base.tar" backup_label 2>/dev/null || true)
elif [ -f "${BASE_DIR}/${OLDEST_BASE}/backup_label" ]; then
  LABEL=$(cat "${BASE_DIR}/${OLDEST_BASE}/backup_label" 2>/dev/null || true)
fi

ANCHOR=$(echo "$LABEL" | sed -n 's/^START WAL LOCATION:.*(file \([0-9A-F]\{24\}\)).*/\1/p' | head -n 1)

# Fallback: backup history files.
#
# With archive_mode=on, Postgres archives a "<segment>.<offset>.backup"
# text file at the end of every base backup, carrying the same
# START WAL LOCATION line. Reading one needs no tar at all, which
# matters because the postgres image ships busybox tar and its flag
# handling is not guaranteed to match GNU's for extract-to-stdout.
#
# The OLDEST history file is used deliberately. It may belong to a
# base backup that has since been deleted, in which case its anchor
# sits earlier than the oldest base we actually hold — so this errs
# toward keeping too much WAL, never too little.
if [ -z "${ANCHOR:-}" ]; then
  OLDEST_HISTORY=$(ls -1 "$WAL_DIR" 2>/dev/null | grep '\.backup$' | sort | head -n 1 || true)
  if [ -n "${OLDEST_HISTORY:-}" ]; then
    echo "[prune-wal] backup_label unreadable; falling back to history file ${OLDEST_HISTORY}"
    ANCHOR=$(sed -n 's/^START WAL LOCATION:.*(file \([0-9A-F]\{24\}\)).*/\1/p' \
      "${WAL_DIR}/${OLDEST_HISTORY}" 2>/dev/null | head -n 1)
  fi
fi

if [ -z "${ANCHOR:-}" ]; then
  cat <<UNREADABLE
[prune-wal] REFUSING TO PRUNE — could not read START WAL LOCATION from
  base backup "${OLDEST_BASE}".

  Neither the backup's own backup_label nor any archived .backup
  history file yielded a START WAL LOCATION. Without that anchor there
  is no way to tell which segments the base still needs, and a wrong
  guess makes it unrestorable. Nothing was deleted.

  Check that ${BASE_DIR}/${OLDEST_BASE}/base.tar.gz exists and is a
  complete pg_basebackup tar (an interrupted run leaves a truncated
  tarball). Deleting that incomplete base and taking a fresh one with
  "Backup now" clears this.
UNREADABLE
  exit 3
fi

echo "[prune-wal] anchor segment (oldest to keep): ${ANCHOR}"

if ! command -v pg_archivecleanup >/dev/null 2>&1; then
  echo "[prune-wal] FATAL: pg_archivecleanup not found in the postgres image" >&2
  exit 4
fi

# pg_archivecleanup deletes every segment that sorts before ANCHOR,
# keeps ANCHOR itself, and leaves timeline .history files alone. -n
# is its native dry-run: it prints the files it would remove.
if [ "$DRY_RUN" -eq 1 ]; then
  echo "[prune-wal] segments that WOULD be removed:"
  pg_archivecleanup -n "$WAL_DIR" "$ANCHOR" 2>&1 | tail -n 40
  would_go=$(pg_archivecleanup -n "$WAL_DIR" "$ANCHOR" 2>/dev/null | wc -l | tr -d ' ')
  echo "[prune-wal] DRY RUN: ${would_go} of ${seg_count_before} segments are prunable"
  exit 0
fi

pg_archivecleanup -d "$WAL_DIR" "$ANCHOR" 2>&1 | tail -n 40

seg_count_after=$(find "$WAL_DIR" -maxdepth 1 -type f -name '0*' | wc -l | tr -d ' ')
size_after=$(du -sk "$WAL_DIR" 2>/dev/null | awk '{print $1}')
removed=$(( seg_count_before - seg_count_after ))
freed_kb=$(( size_before - size_after ))
echo "[prune-wal] archive after: ${seg_count_after} segments, ${size_after} KB"
echo "[prune-wal] removed ${removed} segments, freed ${freed_kb} KB"
INNER_EOF

echo "[prune-wal] done"
