-- Migration 024: fan_out_runs + fan_out_deliveries observability tables.
--
-- Every POST /api/integrations/:slug/fan-out call lands one row in
-- fan_out_runs (the envelope of one dispatch) and N rows in
-- fan_out_deliveries (one per tenant the run touched — dispatched OR
-- skipped). The admin UI surfaces "Last fan-out: N dispatched, M
-- skipped, at <timestamp>" from the most recent run per integration.
--
-- Idempotency model:
--   - Caller may supply an idempotency_key on the request body; if
--     present, the service looks up an existing fan_out_runs row by
--     that key and returns its summary instead of dispatching a fresh
--     run. Keeps n8n retries safe.
--   - Per-delivery: idempotency_key = sha256(fan_out_id || tenant_id),
--     unique-indexed on fan_out_deliveries so a replayed single tenant
--     in the same run is a no-op (shouldn't happen; belt-and-suspenders).
--
-- Purely additive, pre-rebuild stage. Idempotent.

BEGIN;

CREATE TABLE IF NOT EXISTS platform.fan_out_runs (
    id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    integration_id              UUID NOT NULL REFERENCES platform.integrations(id) ON DELETE CASCADE,
    -- Caller-supplied key for replay dedupe. NULL when caller didn't
    -- send one; service creates a fresh run in that case.
    idempotency_key             TEXT,
    target_url                  TEXT NOT NULL,
    -- Named window_params (not `window`) because `window` is a reserved
    -- keyword in PostgreSQL (used for window functions). The public
    -- JSON field (request body + envelope JWT claim) stays named
    -- `window` — the column rename is SQL-only.
    window_params               JSONB NOT NULL DEFAULT '{}'::jsonb,
    metadata                    JSONB NOT NULL DEFAULT '{}'::jsonb,
    dispatched                  INTEGER NOT NULL DEFAULT 0,
    skipped_needs_reconnect     INTEGER NOT NULL DEFAULT 0,
    skipped_inactive            INTEGER NOT NULL DEFAULT 0,
    skipped_integration_missing INTEGER NOT NULL DEFAULT 0,
    started_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at                TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS fan_out_runs_integration_idempotency_unique
    ON platform.fan_out_runs (integration_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_fan_out_runs_integration_started
    ON platform.fan_out_runs (integration_id, started_at DESC);

CREATE TABLE IF NOT EXISTS platform.fan_out_deliveries (
    fan_out_id       UUID NOT NULL REFERENCES platform.fan_out_runs(id) ON DELETE CASCADE,
    tenant_id        UUID NOT NULL REFERENCES platform.tenants(id) ON DELETE CASCADE,
    idempotency_key  TEXT NOT NULL,
    status           TEXT NOT NULL
                     CHECK (status IN ('pending', 'delivered', 'failed', 'skipped')),
    skip_reason      TEXT,
    attempt_count    INTEGER NOT NULL DEFAULT 0,
    last_error       TEXT,
    delivered_at     TIMESTAMPTZ,
    PRIMARY KEY (fan_out_id, tenant_id)
);

-- Per-(run, tenant) idempotency; a replayed tenant inside the same run
-- collides here. Intentionally a unique INDEX (not just a constraint)
-- so the service can do ON CONFLICT DO NOTHING.
CREATE UNIQUE INDEX IF NOT EXISTS fan_out_deliveries_idempotency_unique
    ON platform.fan_out_deliveries (idempotency_key);

CREATE INDEX IF NOT EXISTS idx_fan_out_deliveries_status
    ON platform.fan_out_deliveries (status, fan_out_id);

COMMIT;
