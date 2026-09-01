#!/bin/sh
# WAL archive command — invoked by Postgres for every completed WAL
# segment. Writes the segment to the local archive directory,
# compressed by default.
#
# Postgres calls this script with `%p %f` substituted:
#   $1 — full path to the source WAL file inside pg_wal
#   $2 — bare filename (e.g. 000000010000000000000003)
#
# Exit codes:
#   0  — segment archived
#   1+ — anything else; Postgres will retry the same segment forever
#        until it succeeds. WAL accumulates in pg_wal until then.
#
# Self-healing: creates the archive dir on first use so a fresh
# container deploy doesn't lose the first batch of WAL.
#
# COMPRESSION
# -----------
# Postgres writes every WAL segment at a fixed 16 MB, zero-padded,
# regardless of how much change it actually carries. archive_timeout
# (300s in docker-compose.yml) force-switches a segment after five
# minutes of *any* write activity, so a lightly used database still
# ships many near-empty 16 MB files a day into the archive. Gzip
# collapses those to tens of KB — the padding compresses to almost
# nothing — while a genuinely full segment still shrinks by roughly
# half.
#
# This is what keeps the archive small without touching
# archive_timeout, so the recovery point objective stays at five
# minutes rather than being traded away for disk.
#
# Only real WAL segments (24 hex characters) are compressed. Backup
# history (.backup) and timeline (.history) files stay plain text:
# they are tiny, and scripts/prune-wal.sh reads .backup files directly
# to find the oldest segment it must keep.
#
# Restore side: scripts/restore-drill.sh sets a restore_command that
# handles both compressed and plain segments, so an archive containing
# a mix — segments written before this change alongside ones written
# after — restores correctly with no migration step.
#
# Set BACKUP_WAL_COMPRESS=0 to archive uncompressed.

set -eu

SRC_PATH="$1"
SEG_NAME="$2"

ARCHIVE_DIR="${BACKUP_ARCHIVE_DIR:-/var/lib/postgresql/backups/wal}"

mkdir -p "$ARCHIVE_DIR"

# Compress only 24-hex-character segment names. Anything else is
# metadata that other tooling reads as text.
COMPRESS=0
if [ "${BACKUP_WAL_COMPRESS:-1}" != "0" ]; then
  case "$SEG_NAME" in
    [0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F])
      if command -v gzip >/dev/null 2>&1; then
        COMPRESS=1
      fi
      ;;
  esac
fi

if [ "$COMPRESS" = "1" ]; then
  DEST_NAME="${SEG_NAME}.gz"
else
  DEST_NAME="${SEG_NAME}"
fi

# Refuse to overwrite — Postgres recycles WAL filenames over time, so
# an existing same-named file at archive time means our WAL retention
# window already pruned-and-rewrote, OR the archive_command is being
# re-invoked for a segment we already archived. Either case, hard-fail
# so the operator notices.
#
# Both spellings are checked: an archive that predates compression
# holds the plain name, and refusing on either keeps that guarantee
# intact across the switch.
if [ -f "$ARCHIVE_DIR/$SEG_NAME" ] || [ -f "$ARCHIVE_DIR/${SEG_NAME}.gz" ]; then
  echo "wal-archive: refusing to overwrite existing $ARCHIVE_DIR/$SEG_NAME" >&2
  exit 2
fi

# Atomic write via a tmp + rename so a partial write isn't visible to
# the restore drill, to the prune, or to S3 sync. A half-written
# segment that Postgres considered archived is unrecoverable data
# loss, so the rename must be the only thing that publishes it.
TMP_PATH="$ARCHIVE_DIR/.$DEST_NAME.tmp"
if [ "$COMPRESS" = "1" ]; then
  # Exit status matters: `set -e` covers the simple command, and the
  # redirect target is the tmp path, so a full disk or a gzip failure
  # leaves the tmp file behind and never renames.
  gzip -c "$SRC_PATH" > "$TMP_PATH"

  # gzip inflates incompressible input slightly. Real WAL is highly
  # structured and never hits that, but a segment carrying nothing but
  # encrypted or already-compressed payload could. Fall back to storing
  # it plain so "archiving compressed" can never cost disk rather than
  # save it. Mixed archives are already a supported state — the restore
  # command and the prune both handle either spelling.
  SRC_SIZE=$(wc -c < "$SRC_PATH")
  GZ_SIZE=$(wc -c < "$TMP_PATH")
  if [ "$GZ_SIZE" -ge "$SRC_SIZE" ]; then
    rm -f "$TMP_PATH"
    DEST_NAME="$SEG_NAME"
    TMP_PATH="$ARCHIVE_DIR/.$DEST_NAME.tmp"
    cp "$SRC_PATH" "$TMP_PATH"
  fi
else
  cp "$SRC_PATH" "$TMP_PATH"
fi
mv "$TMP_PATH" "$ARCHIVE_DIR/$DEST_NAME"

# S3 mirror is layered on top in step 12 (B2). The hook is here as a
# placeholder so the local-archive path stays the single source of
# truth even after S3 lands. `aws s3 sync` mirrors the directory as-is,
# so compressed segments need no special handling there.

exit 0
