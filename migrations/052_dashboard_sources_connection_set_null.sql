-- Migration 052: dashboard_sources.connection_id → ON DELETE SET NULL
--
-- Lets the application DELETE platform.connections rows freely
-- without an FK violation when a tenant disconnects (we now drop
-- the row instead of nulling its tokens) or when a platform admin
-- deletes an integration whose connections are still around.
--
-- The column was already nullable, so SET NULL is consistent with
-- the existing schema. A dashboard whose source was tied to a
-- now-deleted connection will surface NULL connection_id; the
-- dashboard config remains and the operator can rebind a new
-- connection without losing widget definitions.
--
-- Idempotent: drops the auto-named FK if present, then re-adds
-- with the new ON DELETE clause.

BEGIN;

ALTER TABLE platform.dashboard_sources
  DROP CONSTRAINT IF EXISTS dashboard_sources_connection_id_fkey;

ALTER TABLE platform.dashboard_sources
  ADD CONSTRAINT dashboard_sources_connection_id_fkey
    FOREIGN KEY (connection_id)
    REFERENCES platform.connections(id)
    ON DELETE SET NULL;

COMMIT;
