import { withTenantContext } from '../db/connection';
import { AppError } from '../middleware/error-handler';
import { decryptSecret } from '../lib/encrypted-column';

function decryptConnectionRow<T extends { id: string; connection_details?: string | null }>(row: T): T {
  if (row.connection_details !== undefined) {
    row.connection_details = decryptSecret(row.connection_details, `connections:connection_details:${row.id}`);
  }
  return row;
}

export async function listConnections(tenantId: string) {
  return withTenantContext(tenantId, async (client) => {
    const result = await client.query(
      'SELECT * FROM platform.connections WHERE tenant_id = $1 ORDER BY created_at DESC',
      [tenantId]
    );
    return result.rows.map(decryptConnectionRow);
  });
}

export async function getConnection(tenantId: string, connectionId: string) {
  return withTenantContext(tenantId, async (client) => {
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
