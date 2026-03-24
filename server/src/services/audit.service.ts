import { getPool, withClient } from '../db/connection';

interface AuditLogEntry {
  tenantId: string;
  userId?: string;
  action: string;
  resourceType?: string;
  resourceId?: string;
  metadata?: Record<string, unknown>;
}

interface AuditQueryParams {
  tenantId: string;
  page?: number;
  limit?: number;
  action?: string;
  userId?: string;
  resourceType?: string;
}

interface PaginatedAuditLog {
  data: Array<Record<string, unknown>>;
  total: number;
  page: number;
  limit: number;
}

/**
 * Fire-and-forget audit log insertion.
 * Errors are logged but do not propagate.
 */
export function log(entry: AuditLogEntry): void {
  withClient(async (client) => {
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
    await client.query(
      `INSERT INTO platform.audit_log (tenant_id, user_id, action, resource_type, resource_id, metadata)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        entry.tenantId,
        entry.userId || null,
        entry.action,
        entry.resourceType || null,
        entry.resourceId || null,
        entry.metadata ? JSON.stringify(entry.metadata) : null,
      ]
    );
  }).catch((err) => {
    console.error('Failed to write audit log:', err);
  });

  // Dispatch outbound webhooks for this event (fire-and-forget)
  if (entry.tenantId && entry.action) {
    import('./webhook.service').then(wh => {
      return wh.dispatchEvent(entry.tenantId, entry.action, {
        resourceType: entry.resourceType,
        resourceId: entry.resourceId,
        ...(entry.metadata || {}),
      });
    }).catch((err) => {
      console.error('Webhook dispatch from audit failed:', err instanceof Error ? err.message : err);
    });
  }
}

/**
 * Platform-wide audit query (for super admin).
 */
export async function queryAll(params: Omit<AuditQueryParams, 'tenantId'> & { tenantId?: string }): Promise<PaginatedAuditLog> {
  return withClient(async (client) => {
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
    const page = params.page || 1;
    const limit = Math.min(params.limit || 50, 200);
    const offset = (page - 1) * limit;

    const conditions: string[] = [];
    const values: unknown[] = [];
    let paramIdx = 1;

    if (params.tenantId) {
      conditions.push(`a.tenant_id = $${paramIdx}`);
      values.push(params.tenantId);
      paramIdx++;
    }
    if (params.action) {
      conditions.push(`a.action = $${paramIdx}`);
      values.push(params.action);
      paramIdx++;
    }
    if (params.userId) {
      conditions.push(`a.user_id = $${paramIdx}`);
      values.push(params.userId);
      paramIdx++;
    }
    if (params.resourceType) {
      conditions.push(`a.resource_type = $${paramIdx}`);
      values.push(params.resourceType);
      paramIdx++;
    }

    const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

    const countResult = await client.query(
      `SELECT COUNT(*) FROM platform.audit_log a ${whereClause}`,
      values
    );
    const total = parseInt(countResult.rows[0].count, 10);

    const dataResult = await client.query(
      `SELECT a.id, a.tenant_id, a.user_id, a.action, a.resource_type, a.resource_id, a.metadata, a.created_at,
              t.name AS tenant_name, u.email AS user_email
       FROM platform.audit_log a
       LEFT JOIN platform.tenants t ON t.id = a.tenant_id
       LEFT JOIN platform.users u ON u.id = a.user_id
       ${whereClause}
       ORDER BY a.created_at DESC
       LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
      [...values, limit, offset]
    );

    return {
      data: dataResult.rows,
      total,
      page,
      limit,
    };
  });
}

export async function query(params: AuditQueryParams): Promise<PaginatedAuditLog> {
  return withClient(async (client) => {
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
    const page = params.page || 1;
    const limit = Math.min(params.limit || 50, 200);
    const offset = (page - 1) * limit;

    const conditions: string[] = ['a.tenant_id = $1'];
    const values: unknown[] = [params.tenantId];
    let paramIdx = 2;

    if (params.action) {
      conditions.push(`a.action = $${paramIdx}`);
      values.push(params.action);
      paramIdx++;
    }

    if (params.userId) {
      conditions.push(`a.user_id = $${paramIdx}`);
      values.push(params.userId);
      paramIdx++;
    }

    if (params.resourceType) {
      conditions.push(`a.resource_type = $${paramIdx}`);
      values.push(params.resourceType);
      paramIdx++;
    }

    const whereClause = conditions.join(' AND ');

    const countResult = await client.query(
      `SELECT COUNT(*) FROM platform.audit_log a WHERE ${whereClause}`,
      values
    );
    const total = parseInt(countResult.rows[0].count, 10);

    const dataResult = await client.query(
      `SELECT a.id, a.tenant_id, a.user_id, a.action, a.resource_type, a.resource_id, a.metadata, a.created_at,
              u.email AS user_email, u.name AS user_name
       FROM platform.audit_log a
       LEFT JOIN platform.users u ON u.id = a.user_id
       WHERE ${whereClause}
       ORDER BY a.created_at DESC
       LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
      [...values, limit, offset]
    );

    return {
      data: dataResult.rows,
      total,
      page,
      limit,
    };
  });
}
