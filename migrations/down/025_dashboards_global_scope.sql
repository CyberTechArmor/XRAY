-- Down migration for 025_dashboards_global_scope.sql.
--
-- Pre-requisite: no Global rows must exist (their tenant_id is NULL,
-- which the post-down NOT NULL constraint would reject). The down
-- script DELETEs them as the only safe path — document loss is expected
-- on rollback.

BEGIN;

DELETE FROM platform.dashboards WHERE scope = 'global';

ALTER TABLE platform.dashboards DROP CONSTRAINT IF EXISTS dashboards_global_not_public;
ALTER TABLE platform.dashboards DROP CONSTRAINT IF EXISTS dashboards_scope_tenant_id;

DROP INDEX IF EXISTS idx_dashboards_tenant_scope_status;
DROP INDEX IF EXISTS idx_dashboards_global_integration;

ALTER TABLE platform.dashboards ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE platform.dashboards DROP COLUMN IF EXISTS scope;

COMMIT;
