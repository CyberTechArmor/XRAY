-- Down migration for 024_fan_out_runs.sql. Drops observability tables.
BEGIN;
DROP TABLE IF EXISTS platform.fan_out_deliveries;
DROP TABLE IF EXISTS platform.fan_out_runs;
COMMIT;
