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

# ── Schedules: cron-expression evaluator + auto-enqueue loop ──
#
# Three schedules are managed via platform_settings rows (admin
# editable in Admin → Backups → Scheduled tasks):
#
#   backup_schedule_base          — cron expression, e.g. "0 2 * * *"
#   backup_schedule_base_enabled  — "true" | "false"
#   backup_schedule_base_last_run — ISO timestamp; updated every fire
#
#   ...and the same triplet for s3sync + drill.
#
# Default-disabled. Operator opts in via the UI. The scheduler loop
# runs alongside the main job-claim loop (background process); when
# a schedule fires it enqueues a row exactly like a manual click and
# the main loop picks it up on the next claim cycle.
#
# Cron parser supports:  *   N   */N   on each of the five fields.
# That covers every cron entry recommended in docs/operator.md
# (daily at HH:MM, every-N-minutes, monthly-on-the-1st). Lists +
# ranges (1,3,5 / 1-5) intentionally not supported — keeps the
# bash evaluator small + auditable.

cron_field_matches() {
  # $1 = field expression  $2 = current numeric value  $3 = max for /N modulus
  local expr="$1" cur="$2" max="$3"
  if [ "$expr" = "*" ]; then return 0; fi
  case "$expr" in
    \*/*)
      local step="${expr#*/}"
      [ -z "$step" ] && return 1
      # Match if current value is divisible by step (relative to 0).
      [ $(( cur % step )) -eq 0 ] && return 0
      return 1
      ;;
    *)
      # Exact match. Strip leading zeros so "07" == 7.
      local n="${expr#0}"; [ -z "$n" ] && n=0
      [ "$cur" = "$n" ] || [ "$cur" = "$expr" ] && return 0
      return 1
      ;;
  esac
}

cron_matches_now() {
  # $1 = cron expression "M H DOM MON DOW"
  local expr="$1"
  # shellcheck disable=SC2206
  local parts=($expr)
  [ "${#parts[@]}" -eq 5 ] || return 1
  local m h dom mon dow
  m=$(date -u +%-M)   # minute of hour, 0-59
  h=$(date -u +%-H)   # hour of day, 0-23
  dom=$(date -u +%-d) # day of month, 1-31
  mon=$(date -u +%-m) # month, 1-12
  dow=$(date -u +%-u) # day of week, 1-7 (Mon-Sun) — cron uses 0-6 (Sun-Sat)
  # Translate to cron's DOW: Sun=0, Mon=1, ..., Sat=6.
  if [ "$dow" -eq 7 ]; then dow=0; fi
  cron_field_matches "${parts[0]}" "$m"   60 || return 1
  cron_field_matches "${parts[1]}" "$h"   24 || return 1
  cron_field_matches "${parts[2]}" "$dom" 31 || return 1
  cron_field_matches "${parts[3]}" "$mon" 12 || return 1
  cron_field_matches "${parts[4]}" "$dow" 7  || return 1
  return 0
}

read_schedule() {
  # $1 = kind (base | s3sync | drill)
  # echoes "<enabled>|<cron>|<last_run>" (pipe-separated; empty fields OK)
  local k="$1"
  run_psql -F'|' <<SQL
SELECT
  COALESCE((SELECT value FROM platform.platform_settings WHERE key='backup_schedule_${k}_enabled'), 'false'),
  COALESCE((SELECT value FROM platform.platform_settings WHERE key='backup_schedule_${k}'),         ''),
  COALESCE((SELECT value FROM platform.platform_settings WHERE key='backup_schedule_${k}_last_run'),'');
SQL
}

set_last_run() {
  # $1 = kind, $2 = ISO timestamp
  local k="$1" ts="$2"
  run_psql -c "INSERT INTO platform.platform_settings (key, value, updated_at)
               VALUES ('backup_schedule_${k}_last_run', '${ts}', NOW())
               ON CONFLICT (key) DO UPDATE SET value = '${ts}', updated_at = NOW()" \
    >/dev/null 2>&1 || true
}

enqueue_scheduled_job() {
  # $1 = kind ('base'|'s3sync'|'drill')
  local k="$1"
  local args="{}"
  if [ "$k" = "s3sync" ]; then args='{"mode":"all"}'; fi
  run_psql -c "INSERT INTO platform.backup_jobs (kind, args, requested_by)
               VALUES ('${k}', '${args}'::jsonb, NULL)" >/dev/null 2>&1 || \
    echo "[backup-worker] WARN scheduled enqueue failed for kind=${k}" >&2
}

scheduler_tick() {
  # Run once per minute. For each kind, check enabled + cron; if due
  # AND last_run isn't this same minute (idempotency guard against
  # multiple workers / sleep drift), enqueue.
  local now_minute
  now_minute=$(date -u +%FT%H:%M)  # minute granularity
  local kind sched enabled cron last_run
  for kind in base s3sync drill; do
    sched=$(read_schedule "$kind" | tr -d '\n' || true)
    IFS='|' read -r enabled cron last_run <<< "$sched"
    [ "$enabled" = "true" ] || continue
    [ -n "$cron" ] || continue
    cron_matches_now "$cron" || continue
    # Already fired this minute? Compare prefix down to minute.
    if [ -n "$last_run" ] && [ "${last_run:0:16}" = "$now_minute" ]; then
      continue
    fi
    echo "[backup-worker] schedule fired: kind=${kind} cron=\"${cron}\""
    enqueue_scheduled_job "$kind"
    set_last_run "$kind" "${now_minute}:00Z"
  done
}

scheduler_loop() {
  # Sleep until the start of the next minute, then tick once per
  # minute. Aligning to the minute boundary so our "did we fire this
  # minute already" guard is unambiguous regardless of drift.
  local sec_until_next
  sec_until_next=$(( 60 - $(date -u +%-S) ))
  sleep "$sec_until_next"
  while true; do
    scheduler_tick || true
    sleep 60
  done
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
      # Per-row "Test restore" sends a base name in args.base — the
      # restore-drill script's --base flag picks it; default 'latest'
      # otherwise (the cron / catch-all path).
      local base_name
      base_name=$(echo "$args" | sed -n 's/.*"base"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
      if [ -n "$base_name" ]; then
        drill_args+=(--base "$base_name")
      fi
      "$WORKER_SCRIPTS_DIR/restore-drill.sh" "${drill_args[@]}" >"$output_file" 2>&1 || exit_code=$?
      ;;
    delete_base)
      # Per-row delete from the Backups admin UI. Resolve the postgres
      # container by compose label (same pattern as backup-platform.sh)
      # and rm -rf the named directory under base/. The name was
      # whitelisted server-side to alphanumerics + . _ : - so no shell
      # metacharacters can land here, but we double-quote anyway as
      # belt-and-braces.
      local del_name
      del_name=$(echo "$args" | sed -n 's/.*"name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
      if [ -z "$del_name" ]; then
        echo "[delete_base] FATAL: args.name missing" >"$output_file"
        exit_code=64
      else
        local pg_id
        pg_id=$(docker ps \
          --filter "label=com.docker.compose.service=postgres" \
          --filter "status=running" \
          --format "{{.ID}}" 2>/dev/null | head -1 || true)
        if [ -z "$pg_id" ]; then
          echo "[delete_base] FATAL: no running postgres container" >"$output_file"
          exit_code=2
        else
          {
            echo "[delete_base] removing /var/lib/postgresql/backups/base/${del_name} from container ${pg_id}"
            docker exec -i "$pg_id" sh -c "
              set -eu
              target='/var/lib/postgresql/backups/base/${del_name}'
              if [ ! -d \"\$target\" ]; then
                echo \"[delete_base] not found: \$target\"
                exit 3
              fi
              rm -rf -- \"\$target\"
              echo \"[delete_base] removed \$target\"
            " 2>&1
          } >"$output_file" 2>&1 || exit_code=$?
        fi
      fi
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

  # Write terminal status + output. Use a file-based SQL script with
  # PostgreSQL dollar-quoting ($xrayout$…$xrayout$) so the output text
  # can contain arbitrary content — single quotes, backslashes, tens
  # of KB of pg_basebackup verbose logs — without any escaping
  # contortions or ARG_MAX hazards (psql -v out=... goes through the
  # bash command line; large drill outputs can exceed ARG_MAX on
  # constrained hosts and silently truncate).
  #
  # Using a unique dollar-quote tag ($xrayout$) makes it impossible
  # for the output itself to terminate the literal — the chance of
  # script output containing the exact bytes "$xrayout$" is zero in
  # any realistic backup/drill log.
  local sql_file
  sql_file=$(mktemp)
  {
    echo "UPDATE platform.backup_jobs"
    echo "   SET status = '${final_status}',"
    echo "       exit_code = ${exit_code},"
    echo "       finished_at = NOW(),"
    echo "       output = \$xrayout\$"
    head -c "$MAX_OUTPUT_BYTES" "$output_file"
    echo ""
    echo "\$xrayout\$"
    echo " WHERE id = '${id}';"
  } > "$sql_file"

  if ! psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" \
            -v ON_ERROR_STOP=1 -f "$sql_file" >/dev/null 2>&1; then
    echo "[backup-worker] WARN terminal-status write failed for $id (sql in ${sql_file}; not removed for triage)" >&2
  else
    rm -f "$sql_file"
  fi

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
    # Same dollar-quoted approach as the backup_jobs UPDATE above —
    # arbitrary drill output (verbose pg_basebackup + WAL replay logs)
    # is bytes-of-anything safe and not subject to ARG_MAX truncation.
    local drill_sql_file
    drill_sql_file=$(mktemp)
    {
      echo "INSERT INTO platform.backup_drill_runs"
      echo "  (started_at, finished_at, exit_code, from_s3,"
      echo "   schema_check_ok, output, triggered_by, user_id)"
      echo "VALUES ('${started_at}', NOW(), ${exit_code}, false,"
      echo "        ${schema_ok}, \$xrayout\$"
      head -c "$MAX_OUTPUT_BYTES" "$output_file"
      echo ""
      echo "\$xrayout\$, '${triggered_by}', ${user_id_arg});"
    } > "$drill_sql_file"
    psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" \
         -v ON_ERROR_STOP=1 -f "$drill_sql_file" >/dev/null 2>&1 \
      && rm -f "$drill_sql_file" \
      || echo "[backup-worker] WARN drill-history write failed for $id (sql in ${drill_sql_file})" >&2
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

# Spawn the scheduler in the background so it ticks once per minute
# alongside the (5s default) job-claim cadence. PIDs captured so the
# SIGTERM trap can clean up.
scheduler_loop &
SCHEDULER_PID=$!
echo "[backup-worker] scheduler running (pid=${SCHEDULER_PID})"

# Graceful shutdown: stop polling on SIGTERM. Any job currently
# running will finish (the docker stop default 10s timeout means a
# long-running drill may get SIGKILL'd; that's acceptable — the row
# will stay in 'running' state until either the worker restarts and
# notices, or an operator marks it failed manually).
trap 'echo "[backup-worker] received SIGTERM; exiting after current job"; kill $SCHEDULER_PID 2>/dev/null; exit 0' TERM

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
