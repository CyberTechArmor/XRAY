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
}

export async function query(params: AuditQueryParams): Promise<PaginatedAuditLog> {
  return withClient(async (client) => {
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
    const page = params.page || 1;
    const limit = Math.min(params.limit || 50, 200);
    const offset = (page - 1) * limit;

    const conditions: string[] = ['tenant_id = $1'];
    const values: unknown[] = [params.tenantId];
    let paramIdx = 2;

    if (params.action) {
      conditions.push(`action = $${paramIdx}`);
      values.push(params.action);
      paramIdx++;
    }

    if (params.userId) {
      conditions.push(`user_id = $${paramIdx}`);
      values.push(params.userId);
      paramIdx++;
    }

    if (params.resourceType) {
      conditions.push(`resource_type = $${paramIdx}`);
      values.push(params.resourceType);
      paramIdx++;
    }

    const whereClause = conditions.join(' AND ');

    const countResult = await client.query(
      `SELECT COUNT(*) FROM platform.audit_log WHERE ${whereClause}`,
      values
    );
    const total = parseInt(countResult.rows[0].count, 10);

    const dataResult = await client.query(
      `SELECT id, tenant_id, user_id, action, resource_type, resource_id, metadata, created_at
       FROM platform.audit_log
       WHERE ${whereClause}
       ORDER BY created_at DESC
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
