-- Down migration for 021. Drops the trigger, function, indexes, and table.
-- Rollback is only sensible before any tenant has connected to an
-- integration (migration 022 adds the FK from connections → integrations
-- with ON DELETE RESTRICT, so this down migration fails if live tenant
-- connections exist — run 022/down first in that case).

BEGIN;

DROP TRIGGER IF EXISTS enforce_enc_integrations_client_secret ON platform.integrations;
DROP FUNCTION IF EXISTS platform.require_enc_integrations_client_secret();

DROP INDEX IF EXISTS platform.idx_integrations_status;

DROP TABLE IF EXISTS platform.integrations;

COMMIT;
