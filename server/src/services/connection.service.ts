import { withClient } from '../db/connection';
import { AppError } from '../middleware/error-handler';
import { decryptSecret } from '../lib/encrypted-column';

function decryptConnectionRow<T extends { id: string; connection_details?: string | null }>(row: T): T {
  if (row.connection_details !== undefined) {
    row.connection_details = decryptSecret(row.connection_details, `connections:connection_details:${row.id}`);
  }
  return row;
}

export async function listConnections(tenantId: string) {
  return withClient(async (client) => {
    await client.query(`SELECT set_config('app.current_tenant', $1, true)`, [tenantId]);
    await client.query(`SELECT set_config('app.is_platform_admin', 'false', true)`);
    const result = await client.query(
      'SELECT * FROM platform.connections WHERE tenant_id = $1 ORDER BY created_at DESC',
      [tenantId]
    );
    return result.rows.map(decryptConnectionRow);
  });
}

export async function getConnection(tenantId: string, connectionId: string) {
  return withClient(async (client) => {
    await client.query(`SELECT set_config('app.current_tenant', $1, true)`, [tenantId]);
    await client.query(`SELECT set_config('app.is_platform_admin', 'false', true)`);
    const connResult = await client.query(
      'SELECT * FROM platform.connections WHERE id = $1 AND tenant_id = $2',
      [connectionId, tenantId]
    );
    if (connResult.rows.length === 0) {
      throw new AppError(404, 'NOT_FOUND', 'Connection not found');
    }
    const tablesResult = await client.query(
      'SELECT * FROM platform.connection_tables WHERE connection_id = $1 ORDER BY table_name',
      [connectionId]
    );
    return { ...decryptConnectionRow(connResult.rows[0]), tables: tablesResult.rows };
  });
}
