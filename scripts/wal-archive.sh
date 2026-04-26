#!/bin/sh
# WAL archive command — invoked by Postgres for every completed WAL
# segment. Writes the segment to the local archive directory; on
# step-12 follow-up, also mirrors to S3 if BACKUP_S3_BUCKET is set.
#
# Postgres calls this script with `%p %f` substituted:
#   $1 — full path to the source WAL file inside pg_wal
#   $2 — bare filename (e.g. 000000010000000000000003)
#
# Exit codes:
#   0  — segment archived (local always; S3 if configured)
#   1+ — anything else; Postgres will retry the same segment forever
#        until it succeeds. WAL accumulates in pg_wal until then.
#
# Self-healing: creates the archive dir on first use so a fresh
# container deploy doesn't lose the first batch of WAL.

set -eu

SRC_PATH="$1"
SEG_NAME="$2"

ARCHIVE_DIR="${BACKUP_ARCHIVE_DIR:-/var/lib/postgresql/backups/wal}"

mkdir -p "$ARCHIVE_DIR"

# Refuse to overwrite — Postgres recycles WAL filenames over time, so
# an existing same-named file at archive time means our WAL retention
# window already pruned-and-rewrote, OR the archive_command is being
# re-invoked for a segment we already archived. Either case, hard-fail
# so the operator notices.
if [ -f "$ARCHIVE_DIR/$SEG_NAME" ]; then
  echo "wal-archive: refusing to overwrite existing $ARCHIVE_DIR/$SEG_NAME" >&2
  exit 2
fi

# Atomic move via a tmp + rename so a partial write isn't visible to
# the restore drill or to S3 sync.
TMP_PATH="$ARCHIVE_DIR/.$SEG_NAME.tmp"
cp "$SRC_PATH" "$TMP_PATH"
mv "$TMP_PATH" "$ARCHIVE_DIR/$SEG_NAME"

# S3 mirror is layered on top in step 12 (B2). The hook is here as a
# placeholder so the local-archive path stays the single source of
# truth even after S3 lands.

exit 0
