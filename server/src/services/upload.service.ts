import { withClient } from '../db/connection';
import { AppError } from '../middleware/error-handler';

export interface FileRecord {
  id: string;
  tenant_id: string;
  uploaded_by: string;
  original_name: string;
  stored_name: string;
  mime_type: string;
  size_bytes: number;
  context_type: string;
  context_id: string | null;
  created_at: string;
}

// ── Create file record ──
export async function createFileRecord(input: {
  tenantId: string;
  uploadedBy: string;
  originalName: string;
  storedName: string;
  mimeType: string;
  sizeBytes: number;
  contextType: string;
  contextId?: string;
}): Promise<FileRecord> {
  return withClient(async (client) => {
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
    const result = await client.query(
      `INSERT INTO platform.file_uploads
        (tenant_id, uploaded_by, original_name, stored_name, mime_type, size_bytes, context_type, context_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        input.tenantId, input.uploadedBy, input.originalName, input.storedName,
        input.mimeType, input.sizeBytes, input.contextType, input.contextId || null,
      ]
    );
    return result.rows[0];
  });
}

// ── Get file by ID ──
export async function getFileById(fileId: string): Promise<FileRecord> {
  return withClient(async (client) => {
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
    const result = await client.query(
      `SELECT * FROM platform.file_uploads WHERE id = $1`,
      [fileId]
    );
    if (result.rows.length === 0) {
      throw new AppError(404, 'NOT_FOUND', 'File not found');
    }
    return result.rows[0];
  });
}

// ── List files by context ──
export async function listFilesByContext(
  contextType: string,
  contextId: string,
  tenantId?: string
): Promise<FileRecord[]> {
  return withClient(async (client) => {
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
    if (tenantId) {
      const result = await client.query(
        `SELECT * FROM platform.file_uploads
         WHERE context_type = $1 AND context_id = $2 AND tenant_id = $3
         ORDER BY created_at DESC`,
        [contextType, contextId, tenantId]
      );
      return result.rows;
    }
    const result = await client.query(
      `SELECT * FROM platform.file_uploads
       WHERE context_type = $1 AND context_id = $2
       ORDER BY created_at DESC`,
      [contextType, contextId]
    );
    return result.rows;
  });
}

// ── List all billing files across tenants (platform admin) ──
export async function listAllBillingFiles(
  opts: { limit?: number; offset?: number }
): Promise<{ rows: any[]; total: number }> {
  return withClient(async (client) => {
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
    const countResult = await client.query(
      `SELECT count(*)::int AS total FROM platform.file_uploads WHERE context_type = 'invoice'`
    );
    const limit = opts.limit || 50;
    const offset = opts.offset || 0;
    const result = await client.query(
      `SELECT fu.*, u.email AS uploader_email, u.name AS uploader_name, t.name AS tenant_name
       FROM platform.file_uploads fu
       LEFT JOIN platform.users u ON u.id = fu.uploaded_by
       LEFT JOIN platform.tenants t ON t.id = fu.tenant_id
       WHERE fu.context_type = 'invoice'
       ORDER BY fu.created_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    return { rows: result.rows, total: countResult.rows[0].total };
  });
}

// ── List all files for tenant ──
export async function listAllFiles(
  tenantId: string,
  opts: { contextType?: string; limit?: number; offset?: number }
): Promise<{ rows: FileRecord[]; total: number }> {
  return withClient(async (client) => {
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
    const conditions = ['tenant_id = $1'];
    const params: unknown[] = [tenantId];
    if (opts.contextType) {
      conditions.push('context_type = $' + (params.length + 1));
      params.push(opts.contextType);
    }
    const where = conditions.join(' AND ');
    const countResult = await client.query(
      `SELECT count(*)::int AS total FROM platform.file_uploads WHERE ${where}`,
      params
    );
    const limit = opts.limit || 50;
    const offset = opts.offset || 0;
    const result = await client.query(
      `SELECT fu.*, u.email AS uploader_email, u.name AS uploader_name
       FROM platform.file_uploads fu
       LEFT JOIN platform.users u ON u.id = fu.uploaded_by
       WHERE ${where.replace(/tenant_id/g, 'fu.tenant_id').replace(/context_type/g, 'fu.context_type')}
       ORDER BY fu.created_at DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    );
    return { rows: result.rows, total: countResult.rows[0].total };
  });
}

// ── List all files across all tenants (platform admin) ──
export async function listAllFilesAdmin(
  opts: { contextType?: string; tenantId?: string; limit?: number; offset?: number }
): Promise<{ rows: any[]; total: number }> {
  return withClient(async (client) => {
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (opts.contextType) {
      conditions.push('fu.context_type = $' + (params.length + 1));
      params.push(opts.contextType);
    }
    if (opts.tenantId) {
      conditions.push('fu.tenant_id = $' + (params.length + 1));
      params.push(opts.tenantId);
    }
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    const countResult = await client.query(
      `SELECT count(*)::int AS total FROM platform.file_uploads fu ${where}`,
      params
    );
    const limit = opts.limit || 50;
    const offset = opts.offset || 0;
    const result = await client.query(
      `SELECT fu.*, u.email AS uploader_email, u.name AS uploader_name, t.name AS tenant_name
       FROM platform.file_uploads fu
       LEFT JOIN platform.users u ON u.id = fu.uploaded_by
       LEFT JOIN platform.tenants t ON t.id = fu.tenant_id
       ${where}
       ORDER BY fu.created_at DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    );
    return { rows: result.rows, total: countResult.rows[0].total };
  });
}

// ── Share file to a tenant (creates a linked record pointing to same stored file) ──
export async function shareFileToTenant(
  fileId: string,
  targetTenantId: string,
  sharedBy: string
): Promise<FileRecord> {
  return withClient(async (client) => {
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
    const orig = await client.query(`SELECT * FROM platform.file_uploads WHERE id = $1`, [fileId]);
    if (orig.rows.length === 0) throw new AppError(404, 'NOT_FOUND', 'File not found');
    const f = orig.rows[0];
    // Don't duplicate if already exists for this tenant with same stored_name
    const existing = await client.query(
      `SELECT id FROM platform.file_uploads WHERE tenant_id = $1 AND stored_name = $2`,
      [targetTenantId, f.stored_name]
    );
    if (existing.rows.length > 0) {
      return (await client.query(`SELECT * FROM platform.file_uploads WHERE id = $1`, [existing.rows[0].id])).rows[0];
    }
    const result = await client.query(
      `INSERT INTO platform.file_uploads
        (tenant_id, uploaded_by, original_name, stored_name, mime_type, size_bytes, context_type, context_id)
       VALUES ($1, $2, $3, $4, $5, $6, 'general', NULL)
       RETURNING *`,
      [targetTenantId, sharedBy, f.original_name, f.stored_name, f.mime_type, f.size_bytes]
    );
    return result.rows[0];
  });
}

// ── Delete file record ──
export async function deleteFileRecord(fileId: string): Promise<{ id: string }> {
  return withClient(async (client) => {
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
    const result = await client.query(
      `DELETE FROM platform.file_uploads WHERE id = $1 RETURNING id, stored_name`,
      [fileId]
    );
    if (result.rows.length === 0) {
      throw new AppError(404, 'NOT_FOUND', 'File not found');
    }
    return result.rows[0];
  });
}
