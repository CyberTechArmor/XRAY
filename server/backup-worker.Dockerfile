# Backup-worker sidecar — Phase B of the Backups admin UI.
#
# Runs scripts/backup-worker.sh as a long-lived daemon that polls the
# platform.backup_jobs queue and shells out to the existing backup
# scripts on demand. Kept deliberately minimal: bash + docker CLI +
# postgres-client (psql) + aws-cli. The scripts mounted in at runtime
# do all the heavy lifting; this image just provides the runtime.
#
# Build context is the repo root (so the COPY of scripts/ at runtime
# is from a reachable path); image is referenced from
# docker-compose.yml's backup-worker service.

FROM alpine:3.19

# bash         — the worker script and all the scripts it calls require bash
# docker-cli   — needed for `docker exec postgres pg_basebackup …`
#                in backup-platform.sh and the sidecar-spawn pattern
#                in restore-drill.sh
# postgresql-client — psql for queue claim/update + the diagnostic
#                queries inside the scripts
# aws-cli      — used by backup-s3-sync.sh for the offsite mirror
# coreutils    — alpine's busybox `head`/`date` are mostly compatible,
#                but coreutils gives us the GNU shapes the scripts assume
# tzdata       — so `date -u` and timestamp formatting render correctly
#                across deploy hosts in non-UTC timezones
RUN apk add --no-cache \
    bash \
    docker-cli \
    postgresql16-client \
    aws-cli \
    coreutils \
    tzdata

# Scripts are mounted in at runtime via the compose volume bind so
# operator-side updates (just git pull on the host) propagate without
# rebuilding this image. The ENTRYPOINT references the runtime mount
# location.
WORKDIR /scripts

ENTRYPOINT ["/scripts/backup-worker.sh"]
