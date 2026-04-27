#!/usr/bin/env bash
# Backup worker — Phase B daemon for the Backups admin UI.
#
# Polls platform.backup_jobs for the oldest pending row, claims it
# atomically (FOR UPDATE SKIP LOCKED), shells out to the matching
# script in scripts/, and writes the result back. The XRay server
# enqueues; this worker executes.
#
# Why a separate container (vs. mounting docker.sock into the server):
# the server connects as the non-owner non-super xray_app role and has
# no shell-out path. Mounting docker.sock into the server would turn
# server compromise into host compromise. The worker is a smaller
# blast radius — bash + docker CLI + psql + aws CLI, nothing more.
#
# Required env (passed in by docker-compose.yml):
#   DB_HOST                — postgres service hostname (default: postgres)
#   DB_PORT                — Postgres port (default: 5432)
#   DB_USER                — bootstrap super (default: xray); needed for
#                            RLS bypass on platform.backup_jobs +
#                            platform.backup_drill_runs
#   DB_PASSWORD            — bootstrap user password
#   DB_NAME                — DB name (default: xray)
#   POLL_INTERVAL_SEC      — sleep between polls when queue is empty
#                            (default: 5)
#   WORKER_SCRIPTS_DIR     — where the trigger scripts are mounted
#                            (default: /scripts)
#   BACKUP_S3_*            — S3 mirror config; pass-through to the
#                            scripts that need them (Phase C will
#                            override with platform_settings reads)
#
# Exit codes:
#   never returns under normal operation; SIGTERM stops the loop
#   cleanly between jobs.

set -euo pipefail

DB_HOST="${DB_HOST:-postgres}"
DB_PORT="${DB_PORT:-5432}"
DB_USER="${DB_USER:-xray}"
DB_NAME="${DB_NAME:-xray}"
POLL_INTERVAL_SEC="${POLL_INTERVAL_SEC:-5}"
WORKER_SCRIPTS_DIR="${WORKER_SCRIPTS_DIR:-/scripts}"

if [ -z "${DB_PASSWORD:-}" ]; then
  echo "[backup-worker] DB_PASSWORD must be set" >&2
  exit 1
fi
export PGPASSWORD="$DB_PASSWORD"

# Output cap — matches the application-side TRUNC in backup.service
# (rowToJob's preview, getJob's full read). 1 MB is enough for any
# realistic restore-drill log; runaway scripts get capped.
MAX_OUTPUT_BYTES=$((1024 * 1024))

PSQL=(psql -tA -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -v ON_ERROR_STOP=1)

run_psql() {
  "${PSQL[@]}" "$@"
}

# ── Claim ─────────────────────────────────────────────────────
# Atomic: SELECT … FOR UPDATE SKIP LOCKED so two workers (if scaled)
# never grab the same row. The transaction commits the UPDATE, so
# the row's status flips to 'running' immediately.
claim_next_job() {
  run_psql -F'|' <<'SQL'
WITH next AS (
  SELECT id FROM platform.backup_jobs
   WHERE status = 'pending'
   ORDER BY created_at ASC
   LIMIT 1
   FOR UPDATE SKIP LOCKED
)
UPDATE platform.backup_jobs j
   SET status = 'running', started_at = NOW()
  FROM next
 WHERE j.id = next.id
RETURNING j.id, j.kind, j.args::text, COALESCE(j.requested_by::text, '');
SQL
}

# ── Phase C: hot-reload S3 config from platform_settings ──────
# Server admins edit bucket/endpoint/region/prefix/access-key-id/
# retention via Admin → Backups (writes to platform.platform_settings).
# Read those rows here and export as the BACKUP_S3_* env vars the
# existing scripts already consume — DB takes precedence, env stays
# as fallback (so first-deploy + .env-only installs keep working
# until the operator seeds the settings rows).
#
# The SECRET access key (BACKUP_S3_SECRET_ACCESS_KEY) is NOT in this
# fetch — it stays env-only. Decrypting an AES-GCM ciphertext from
# the DB inside this bash daemon requires either a Node runtime in
# the worker image (image bloat) or a hand-rolled openssl pipeline
# (fragile). The rare-rotation cost of restarting the worker on .env
# edits is acceptable.
fetch_s3_settings_into_env() {
  local row
  for kv in \
    "backup_s3_bucket:BACKUP_S3_BUCKET" \
    "backup_s3_endpoint:BACKUP_S3_ENDPOINT" \
    "backup_s3_region:BACKUP_S3_REGION" \
    "backup_s3_prefix:BACKUP_S3_PREFIX" \
    "backup_s3_access_key_id:BACKUP_S3_ACCESS_KEY_ID" \
    "backup_retain_days:BACKUP_RETAIN_DAYS"
  do
    local setting_key="${kv%%:*}"
    local env_key="${kv##*:}"
    row=$(run_psql -c "SELECT COALESCE(value, '') FROM platform.platform_settings WHERE key = '${setting_key}'" 2>/dev/null || echo "")
    # Trim trailing newline / whitespace from psql output.
    row="${row//[$'\t\r\n ']}"
    if [ -n "$row" ]; then
      export "$env_key"="$row"
      echo "[backup-worker] $env_key from platform_settings"
    fi
  done
}

# ── Job dispatch ──────────────────────────────────────────────
# Each kind shells out to the existing script and captures the
# combined stdout+stderr. Output is capped at 1 MB before write-back
# so a runaway script can't bloat the row.
run_job() {
  local id="$1" kind="$2" args="$3" requested_by="$4"
  local output_file
  output_file=$(mktemp)
  local exit_code=0
  local started_at
  started_at=$(date -u +%FT%TZ)

  echo "[backup-worker] running id=$id kind=$kind args=$args"

  case "$kind" in
    base)
      "$WORKER_SCRIPTS_DIR/backup-platform.sh" >"$output_file" 2>&1 || exit_code=$?
      ;;
    s3sync)
      # mode is in the JSON args; default to 'all' if absent or
      # malformed (we already validated server-side, but defense in
      # depth — a corrupt args row shouldn't crash the worker loop).
      local mode
      mode=$(echo "$args" | sed -n 's/.*"mode"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
      [ -z "$mode" ] && mode="all"
      # Phase C: pull non-secret S3 config from platform_settings
      # before invoking the script. .env stays as fallback (the
      # script reads $BACKUP_S3_* via env). DB row precedence keeps
      # the admin-UI-edited values authoritative; if a row isn't
      # set, env wins. Secret access key stays env-only.
      fetch_s3_settings_into_env
      "$WORKER_SCRIPTS_DIR/backup-s3-sync.sh" "$mode" >"$output_file" 2>&1 || exit_code=$?
      ;;
    drill)
      # Tear down any leftover sidecar from a previous interrupted
      # drill before starting; otherwise the new run errors out on
      # "container already exists". Output of the teardown is
      # discarded — only the actual drill output matters.
      "$WORKER_SCRIPTS_DIR/restore-drill.sh" --teardown >/dev/null 2>&1 || true
      local drill_args=()
      if echo "$args" | grep -q '"from_s3"[[:space:]]*:[[:space:]]*true'; then
        drill_args+=(--from-s3)
      fi
      local target_time
      target_time=$(echo "$args" | sed -n 's/.*"target_time"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
      if [ -n "$target_time" ]; then
        drill_args+=(--target-time "$target_time")
      fi
      "$WORKER_SCRIPTS_DIR/restore-drill.sh" "${drill_args[@]}" >"$output_file" 2>&1 || exit_code=$?
      ;;
    *)
      echo "[backup-worker] unknown kind: $kind" >"$output_file"
      exit_code=99
      ;;
  esac

  # Cap output before write-back. head -c keeps the first MAX_OUTPUT_BYTES
  # bytes; subsequent content silently dropped (non-fatal — the
  # truncation marker in the application-side rowToJob will signal it).
  local capped
  capped=$(head -c "$MAX_OUTPUT_BYTES" "$output_file")

  local final_status='completed'
  if [ "$exit_code" -ne 0 ]; then final_status='failed'; fi

  # Write terminal status + output in one UPDATE. psql's -v binding
  # gives us :'name' interpolation that handles arbitrary text safely
  # (it does the proper SQL string escaping); shell-doubling single
  # quotes via ${var//\'/\'\'} is the same belt-and-braces psql does
  # internally, but explicit here so a stray single quote in script
  # output never produces malformed SQL.
  psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" \
       -v ON_ERROR_STOP=1 \
       -v out="${capped//\'/\'\'}" \
       -v jid="$id" \
       -v st="$final_status" \
       -c "UPDATE platform.backup_jobs
              SET status = :'st',
                  exit_code = ${exit_code},
                  finished_at = NOW(),
                  output = :'out'
            WHERE id = :'jid'" \
       >/dev/null 2>&1 || echo "[backup-worker] WARN failed to write terminal status for $id" >&2

  # ── Drill-specific: also write to backup_drill_runs ──
  # Lets the Backups admin "Drill history" panel pick up worker-driven
  # runs the same way it picks up cron-driven ones. The output
  # captured in this row mirrors the backup_jobs.output for symmetry.
  if [ "$kind" = "drill" ]; then
    local triggered_by='cron'
    local user_id_arg='NULL'
    if [ -n "$requested_by" ]; then
      triggered_by='admin_ui'
      user_id_arg="'$requested_by'"
    fi
    local schema_ok='NULL'
    local rows_count='NULL'
    local base_used='NULL'
    if grep -q '\\\\d platform.tenants' "$output_file" 2>/dev/null; then
      schema_ok='true'
    fi
    if grep -q "PROBE PASS\|drill PASS" "$output_file" 2>/dev/null; then
      schema_ok='true'
    fi
    psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" \
         -v ON_ERROR_STOP=1 -v out="${capped//\'/\'\'}" \
         -c "INSERT INTO platform.backup_drill_runs
               (started_at, finished_at, exit_code, from_s3,
                schema_check_ok, output, triggered_by, user_id)
             VALUES ('$started_at', NOW(), $exit_code, false,
                     $schema_ok, :'out', '$triggered_by', $user_id_arg)" \
         >/dev/null 2>&1 || true
  fi

  rm -f "$output_file"
  echo "[backup-worker] done id=$id status=$final_status exit=$exit_code"
}

echo "[backup-worker] starting; poll every ${POLL_INTERVAL_SEC}s"
echo "[backup-worker] DB ${DB_USER}@${DB_HOST}:${DB_PORT}/${DB_NAME}"

# Connectivity probe at startup so misconfigured DB creds surface in
# the worker log instead of failing silently on every claim attempt.
if ! run_psql -c 'SELECT 1' >/dev/null 2>&1; then
  echo "[backup-worker] FATAL: cannot connect to postgres — check DB_PASSWORD in .env" >&2
  echo "[backup-worker] container will keep retrying; pollling will resume once postgres is reachable" >&2
fi

# Same for docker.sock — without it, every job-dispatch will fail.
if ! docker version >/dev/null 2>&1; then
  echo "[backup-worker] FATAL: docker.sock not reachable from this container" >&2
  echo "[backup-worker] expected mount: /var/run/docker.sock — check docker-compose.yml" >&2
fi

# Graceful shutdown: stop polling on SIGTERM. Any job currently
# running will finish (the docker stop default 10s timeout means a
# long-running drill may get SIGKILL'd; that's acceptable — the row
# will stay in 'running' state until either the worker restarts and
# notices, or an operator marks it failed manually).
trap 'echo "[backup-worker] received SIGTERM; exiting after current job"; exit 0' TERM

while true; do
  result=$(claim_next_job 2>&1 || true)
  # claim_next_job's stderr (psql connection failure, RLS policy
  # rejection, etc.) goes into $result alongside its stdout under
  # `2>&1 || true`. Detect that case so a transient error logs
  # cleanly rather than getting parsed as a job row.
  if echo "$result" | grep -qiE 'error|fatal|could not connect'; then
    echo "[backup-worker] WARN claim failed: $(echo "$result" | head -2)" >&2
    sleep "$POLL_INTERVAL_SEC"
    continue
  fi
  if [ -z "$result" ]; then
    sleep "$POLL_INTERVAL_SEC"
    continue
  fi
  IFS='|' read -r id kind args requested_by <<< "$result"
  if [ -n "$id" ]; then
    run_job "$id" "$kind" "$args" "$requested_by"
  else
    sleep "$POLL_INTERVAL_SEC"
  fi
done
