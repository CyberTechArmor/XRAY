import { withClient } from '../db/connection';
import { AppError } from '../middleware/error-handler';

interface CadenceCheck {
  allowed: boolean;
  retryAfter?: number; // seconds until next allowed request
}

const CADENCE_INTERVALS: Record<string, number> = {
  realtime: 0,
  '5min': 5 * 60,
  hourly: 60 * 60,
  daily: 24 * 60 * 60,
};

// In-memory tracking of last request times per user+source
const lastRequestTimes = new Map<string, number>();

export function checkCadence(
  dashboardId: string,
  sourceKey: string,
  userId: string
): CadenceCheck {
  const cacheKey = `${userId}:${dashboardId}:${sourceKey}`;
  const lastTime = lastRequestTimes.get(cacheKey);

  if (!lastTime) {
    return { allowed: true };
  }

  // Look up cadence from the source (we use a default of hourly if unknown)
  // The actual cadence check uses the interval stored by the caller
  return { allowed: true };
}

export async function queryDashboardSource(
  dashboardId: string,
  sourceKey: string,
  tenantId: string,
  userId: string
): Promise<{ data: Record<string, unknown>[]; source: Record<string, unknown> }> {
  return withClient(async (client) => {
    // Set tenant context for RLS
    await client.query(`SET LOCAL app.current_tenant = '${tenantId}'`);
    await client.query(`SET LOCAL app.is_platform_admin = 'false'`);

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

    let query: string;
    if (source.query_template) {
      // Use the predefined query template
      query = source.query_template;
    } else {
      // Default: select all from the table
      query = `SELECT * FROM "${schemaName}"."${source.table_name}"`;
    }

    // Set search path to tenant schema for query execution
    await client.query(`SET search_path = "${schemaName}", public`);

    const dataResult = await client.query(query);

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
