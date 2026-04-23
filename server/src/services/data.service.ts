import { withTenantContext } from '../db/connection';
import { AppError } from '../middleware/error-handler';

const CADENCE_INTERVALS: Record<string, number> = {
  realtime: 0,
  '5min': 5 * 60,
  hourly: 60 * 60,
  daily: 24 * 60 * 60,
};

// In-memory tracking of last request times per user+source
const lastRequestTimes = new Map<string, number>();

export async function queryDashboardSource(
  dashboardId: string,
  sourceKey: string,
  tenantId: string,
  userId: string
): Promise<{ data: Record<string, unknown>[]; source: Record<string, unknown> }> {
  return withTenantContext(tenantId, async (client) => {
    // Look up the dashboard source
    const sourceResult = await client.query(
      `SELECT ds.* FROM platform.dashboard_sources ds
       WHERE ds.dashboard_id = $1 AND ds.source_key = $2 AND ds.tenant_id = $3`,
      [dashboardId, sourceKey, tenantId]
    );

    if (sourceResult.rows.length === 0) {
      throw new AppError(404, 'SOURCE_NOT_FOUND', 'Dashboard source not found');
    }

    const source = sourceResult.rows[0];

    // Verify user has access to this dashboard
    const accessResult = await client.query(
      `SELECT 1 FROM platform.dashboard_access
       WHERE dashboard_id = $1 AND user_id = $2
       UNION
       SELECT 1 FROM platform.dashboards
       WHERE id = $1 AND is_public = true`,
      [dashboardId, userId]
    );

    // Also allow access if user has manage permission (checked separately by caller)
    // For now, check direct access
    if (accessResult.rows.length === 0) {
      throw new AppError(403, 'ACCESS_DENIED', 'You do not have access to this dashboard');
    }

    // Enforce cadence limit
    const cadenceSeconds = CADENCE_INTERVALS[source.refresh_cadence] ?? CADENCE_INTERVALS.hourly;
    const cacheKey = `${userId}:${dashboardId}:${sourceKey}`;
    const lastTime = lastRequestTimes.get(cacheKey);
    const now = Date.now() / 1000;

    if (cadenceSeconds > 0 && lastTime) {
      const elapsed = now - lastTime;
      if (elapsed < cadenceSeconds) {
        const retryAfter = Math.ceil(cadenceSeconds - elapsed);
        throw new AppError(429, 'CADENCE_LIMIT', `Please wait ${retryAfter} seconds before requesting this data again`);
      }
    }

    // Record request time
    lastRequestTimes.set(cacheKey, now);

    // Query the tenant warehouse schema
    const schemaName = `tn_${tenantId.replace(/-/g, '')}`;

    // Validate schema and table names contain only safe characters
    if (!/^tn_[a-f0-9]+$/.test(schemaName)) {
      throw new AppError(400, 'INVALID_SCHEMA', 'Invalid tenant schema name');
    }
    if (source.table_name && !/^[a-z_][a-z0-9_]*$/.test(source.table_name)) {
      throw new AppError(400, 'INVALID_TABLE', 'Invalid table name');
    }

    // Set search path using parameterized set_config
    await client.query(`SELECT set_config('search_path', $1 || ', public', true)`, [schemaName]);

    let dataResult;
    if (source.query_template) {
      // Query templates are admin-defined; execute with parameterized LIMIT for safety
      dataResult = await client.query(source.query_template + ' LIMIT 10000');
    } else {
      // Default: select all from the table (identifier already validated above)
      dataResult = await client.query(
        `SELECT * FROM "${schemaName}"."${source.table_name}" LIMIT 10000`
      );
    }

    return {
      data: dataResult.rows,
      source: {
        key: source.source_key,
        table_name: source.table_name,
        cadence: source.refresh_cadence,
      },
    };
  });
}
