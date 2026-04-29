#!/usr/bin/env bash
# Provision the application's runtime DB role on first postgres start.
# Runs after 01-init.sql (the schema bootstrap), so platform.* tables
# exist when grants are applied.
#
# This script runs ONCE — when the postgres data volume is first
# initialized. On `docker compose down -v && up -d` it re-runs against
# the fresh volume, which is precisely the recovery path that was
# broken before this script existed (the bootstrap superuser was
# created by initdb but xray_app was never provisioned, so the server
# crash-looped with 28P01).
#
# Env vars consumed (passed in by the postgres service in
# docker-compose.yml):
#   POSTGRES_USER, POSTGRES_DB — set by the postgres image itself.
#   DB_APP_USER, DB_APP_PASSWORD — added in compose for this script.
#
# install.sh / update.sh have a backstop (step 9c / 4c) that ALSO
# runs this DDL via `docker exec` against an already-running
# container, so existing installs that predate this init script
# pick up the role on the next install/update run. The two paths
# are intentionally idempotent and converge on the same end state.

set -euo pipefail

: "${POSTGRES_USER:?POSTGRES_USER must be set}"
: "${POSTGRES_DB:?POSTGRES_DB must be set}"
DB_APP_USER="${DB_APP_USER:-xray_app}"
: "${DB_APP_PASSWORD:?DB_APP_PASSWORD must be set in postgres service env}"

echo "[postgres-init] Provisioning runtime DB role: ${DB_APP_USER}"

# Shell-interpolated SQL — values come from container env. The
# generator in install.sh (gen_password) produces [A-Za-z0-9]
# only, so no quoting hazard for the password literal. The role
# name is double-quoted as an identifier; password is single-
# quoted as a literal. Pattern matches install.sh's step 9c
# backstop so the two paths produce byte-identical results.
psql -v ON_ERROR_STOP=1 \
     --username "${POSTGRES_USER}" \
     --dbname "${POSTGRES_DB}" <<SQL
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${DB_APP_USER}') THEN
    CREATE ROLE "${DB_APP_USER}" WITH LOGIN PASSWORD '${DB_APP_PASSWORD}'
      NOSUPERUSER NOINHERIT NOCREATEDB NOCREATEROLE NOREPLICATION
      CONNECTION LIMIT 50;
  ELSE
    ALTER ROLE "${DB_APP_USER}" WITH PASSWORD '${DB_APP_PASSWORD}';
  END IF;
END \$\$;

GRANT USAGE ON SCHEMA platform TO "${DB_APP_USER}";
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA platform TO "${DB_APP_USER}";
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA platform TO "${DB_APP_USER}";
ALTER DEFAULT PRIVILEGES IN SCHEMA platform GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO "${DB_APP_USER}";
ALTER DEFAULT PRIVILEGES IN SCHEMA platform GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO "${DB_APP_USER}";
SQL

echo "[postgres-init] ${DB_APP_USER} provisioned (NOSUPERUSER, NOINHERIT, DML grants on platform.*)"
