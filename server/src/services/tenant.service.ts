import { withClient, withTransaction } from '../db/connection';
import { AppError } from '../middleware/error-handler';

interface Tenant {
  id: string;
  name: string;
  slug: string;
  owner_user_id: string | null;
  stripe_customer_id: string | null;
  warehouse_host: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

interface TenantDetail extends Tenant {
  user_count: number;
  dashboard_count: number;
  connection_count: number;
  billing_state: Record<string, unknown> | null;
}

export async function createTenant(input: {
  name: string;
  slug: string;
  ownerUserId?: string;
}): Promise<Tenant> {
  return withTransaction(async (client) => {
    const result = await client.query(
      `INSERT INTO platform.tenants (name, slug, owner_user_id)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [input.name, input.slug, input.ownerUserId || null]
    );

    const tenant = result.rows[0];

    // Create warehouse schema for tenant data
    const schemaName = `tn_${tenant.id.replace(/-/g, '')}`;
    await client.query(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`);

    return tenant;
  });
}

export async function getTenant(tenantId: string): Promise<Tenant> {
  return withClient(async (client) => {
    const result = await client.query(
      'SELECT * FROM platform.tenants WHERE id = $1',
      [tenantId]
    );
    if (result.rows.length === 0) {
      throw new AppError(404, 'TENANT_NOT_FOUND', 'Tenant not found');
    }
    return result.rows[0];
  });
}

export async function updateTenant(
  tenantId: string,
  updates: Partial<Pick<Tenant, 'name' | 'slug' | 'status' | 'warehouse_host'>>
): Promise<Tenant> {
  return withClient(async (client) => {
    const fields: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    for (const [key, value] of Object.entries(updates)) {
      if (value !== undefined) {
        fields.push(`${key} = $${idx}`);
        values.push(value);
        idx++;
      }
    }

    if (fields.length === 0) {
      throw new AppError(400, 'NO_UPDATES', 'No fields to update');
    }

    fields.push('updated_at = now()');
    values.push(tenantId);

    const result = await client.query(
      `UPDATE platform.tenants SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
      values
    );

    if (result.rows.length === 0) {
      throw new AppError(404, 'TENANT_NOT_FOUND', 'Tenant not found');
    }
    return result.rows[0];
  });
}

export async function listTenants(): Promise<Tenant[]> {
  return withClient(async (client) => {
    const result = await client.query(
      'SELECT * FROM platform.tenants ORDER BY created_at DESC'
    );
    return result.rows;
  });
}

export async function getTenantDetail(tenantId: string): Promise<TenantDetail> {
  return withClient(async (client) => {
    const tenantResult = await client.query(
      'SELECT * FROM platform.tenants WHERE id = $1',
      [tenantId]
    );
    if (tenantResult.rows.length === 0) {
      throw new AppError(404, 'TENANT_NOT_FOUND', 'Tenant not found');
    }

    const tenant = tenantResult.rows[0];

    const [userCount, dashboardCount, connectionCount, billingState] = await Promise.all([
      client.query(
        'SELECT COUNT(*) FROM platform.users WHERE tenant_id = $1',
        [tenantId]
      ),
      client.query(
        'SELECT COUNT(*) FROM platform.dashboards WHERE tenant_id = $1',
        [tenantId]
      ),
      client.query(
        'SELECT COUNT(*) FROM platform.connections WHERE tenant_id = $1',
        [tenantId]
      ),
      client.query(
        'SELECT * FROM platform.billing_state WHERE tenant_id = $1',
        [tenantId]
      ),
    ]);

    return {
      ...tenant,
      user_count: parseInt(userCount.rows[0].count, 10),
      dashboard_count: parseInt(dashboardCount.rows[0].count, 10),
      connection_count: parseInt(connectionCount.rows[0].count, 10),
      billing_state: billingState.rows[0] || null,
    };
  });
}
