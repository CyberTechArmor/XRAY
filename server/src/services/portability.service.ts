import { withAdminClient } from '../db/connection';
import { AppError } from '../middleware/error-handler';
import * as auditService from './audit.service';
import archiver from 'archiver';
import AdmZip from 'adm-zip';
import { Writable, PassThrough } from 'stream';
import * as path from 'path';

// ─── Export ────────────────────────────────────────────────

interface ExportOptions {
  tenants?: boolean;
  dashboards?: boolean;
  connections?: boolean;
  roles?: boolean;
  emailTemplates?: boolean;
  connectionTemplates?: boolean;
}

/**
 * Build a complete platform export as a ZIP buffer.
 * Contains manifest.json + data/*.json + images/*
 */
export async function exportPlatform(opts: ExportOptions, userId?: string): Promise<Buffer> {
  const data: Record<string, unknown> = {};
  const imageUrls: Set<string> = new Set();

  await withAdminClient(async (client) => {

    // ── Tenants + members + billing + notes ──
    if (opts.tenants !== false) {
      const tenants = await client.query(
        `SELECT t.*, bs.plan_tier, bs.dashboard_limit, bs.payment_status
         FROM platform.tenants t
         LEFT JOIN platform.billing_state bs ON bs.tenant_id = t.id
         ORDER BY t.created_at`
      );
      const tenantIds = tenants.rows.map((t: any) => t.id);
      const users = tenantIds.length ? await client.query(
        `SELECT u.id, u.tenant_id, u.email, u.name, u.role_id, u.status, u.auth_method, u.created_at
         FROM platform.users u WHERE u.tenant_id = ANY($1) ORDER BY u.created_at`,
        [tenantIds]
      ) : { rows: [] };
      const notes = tenantIds.length ? await client.query(
        `SELECT n.*, u.email AS author_email FROM platform.tenant_notes n
         LEFT JOIN platform.users u ON u.id = n.author_id
         WHERE n.tenant_id = ANY($1) ORDER BY n.created_at`,
        [tenantIds]
      ) : { rows: [] };

      data.tenants = tenants.rows;
      data.users = users.rows;
      data.tenant_notes = notes.rows;
    }

    // ── Dashboards + access ──
    if (opts.dashboards !== false) {
      const dashboards = await client.query(
        'SELECT * FROM platform.dashboards ORDER BY created_at'
      );
      const dashIds = dashboards.rows.map((d: any) => d.id);
      const access = dashIds.length ? await client.query(
        `SELECT da.*, u.email AS user_email FROM platform.dashboard_access da
         LEFT JOIN platform.users u ON u.id = da.user_id
         WHERE da.dashboard_id = ANY($1)`,
        [dashIds]
      ) : { rows: [] };
      const embeds = dashIds.length ? await client.query(
        `SELECT * FROM platform.dashboard_embeds WHERE dashboard_id = ANY($1)`,
        [dashIds]
      ) : { rows: [] };

      data.dashboards = dashboards.rows;
      data.dashboard_access = access.rows;
      data.dashboard_embeds = embeds.rows;

      // Collect tile image URLs
      dashboards.rows.forEach((d: any) => {
        if (d.tile_image_url) imageUrls.add(d.tile_image_url);
      });
    }

    // ── Connections + tables + comments ──
    // Step 4: OAuth + API-key credentials on platform.connections are
    // excluded from the export. These are live credentials specific to
    // the running platform's ENCRYPTION_KEY + provider app registration;
    // they shouldn't round-trip through a JSON export. After an import,
    // tenants re-run the Connect flow. The integration_id + auth_method
    // ARE exported so the imported rows are recognizable and the
    // scheduler knows which are OAuth-shaped, but the actual tokens
    // and api_key ciphertexts are dropped.
    const CONNECTION_OAUTH_EXCLUDE = [
      'oauth_refresh_token',
      'oauth_access_token',
      'oauth_access_token_expires_at',
      'oauth_last_refreshed_at',
      'oauth_refresh_failed_count',
      'oauth_last_error',
      'api_key',
    ];
    if (opts.connections !== false) {
      const connections = await client.query(
        'SELECT * FROM platform.connections ORDER BY created_at'
      );
      connections.rows = connections.rows.map((row: Record<string, unknown>) => {
        const clean = { ...row };
        for (const col of CONNECTION_OAUTH_EXCLUDE) delete clean[col];
        return clean;
      });
      const connIds = connections.rows.map((c: any) => c.id);
      const tables = connIds.length ? await client.query(
        `SELECT * FROM platform.connection_tables WHERE connection_id = ANY($1)`,
        [connIds]
      ) : { rows: [] };
      const comments = connIds.length ? await client.query(
        `SELECT c.*, u.email AS author_email FROM platform.connection_comments c
         LEFT JOIN platform.users u ON u.id = c.author_id
         WHERE c.connection_id = ANY($1) ORDER BY c.created_at`,
        [connIds]
      ) : { rows: [] };

      data.connections = connections.rows;
      data.connection_tables = tables.rows;
      data.connection_comments = comments.rows;

      // Collect connection image URLs
      connections.rows.forEach((c: any) => {
        if (c.image_url) imageUrls.add(c.image_url);
      });
    }

    // ── Roles + permissions ──
    if (opts.roles !== false) {
      const roles = await client.query('SELECT * FROM platform.roles ORDER BY name');
      const permissions = await client.query('SELECT * FROM platform.permissions ORDER BY key');
      const rolePerms = await client.query('SELECT * FROM platform.role_permissions');

      data.roles = roles.rows;
      data.permissions = permissions.rows;
      data.role_permissions = rolePerms.rows;
    }

    // ── Email templates ──
    if (opts.emailTemplates !== false) {
      const templates = await client.query('SELECT * FROM platform.email_templates ORDER BY template_key');
      data.email_templates = templates.rows;
    }

    // ── Connection templates ──
    if (opts.connectionTemplates !== false) {
      const templates = await client.query('SELECT * FROM platform.connection_templates ORDER BY name');
      data.connection_templates = templates.rows;
    }
  });

  // Build ZIP
  const chunks: Buffer[] = [];
  const passThrough = new PassThrough();
  passThrough.on('data', (chunk: Buffer) => chunks.push(chunk));

  const archive = archiver('zip', { zlib: { level: 6 } });
  archive.pipe(passThrough);

  // Manifest
  const manifest = {
    version: '1.0.0',
    platform: 'xray-bi',
    exported_at: new Date().toISOString(),
    exported_by: userId || 'system',
    sections: Object.keys(data),
    image_count: imageUrls.size,
  };
  archive.append(JSON.stringify(manifest, null, 2), { name: 'manifest.json' });

  // Data files - one per table
  for (const [key, rows] of Object.entries(data)) {
    archive.append(JSON.stringify(rows, null, 2), { name: `data/${key}.json` });
  }

  // Download and include images
  let imgIndex = 0;
  for (const url of imageUrls) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
      if (response.ok) {
        const buffer = Buffer.from(await response.arrayBuffer());
        const ext = guessExtension(url, response.headers.get('content-type') || '');
        archive.append(buffer, { name: `images/${imgIndex}_${sanitizeFilename(url)}${ext}` });
        imgIndex++;
      }
    } catch {
      // Skip unreachable images
    }
  }

  // Image URL mapping for reimport
  const imageMapping = Array.from(imageUrls).map((url, i) => {
    const ext = guessExtension(url, '');
    return { original_url: url, archive_path: `images/${i}_${sanitizeFilename(url)}${ext}` };
  });
  archive.append(JSON.stringify(imageMapping, null, 2), { name: 'images/index.json' });

  await archive.finalize();
  // Wait for stream to finish
  await new Promise<void>((resolve) => passThrough.on('end', resolve));

  const zipBuffer = Buffer.concat(chunks);

  auditService.log({
    tenantId: '00000000-0000-0000-0000-000000000000',
    userId,
    action: 'platform.export',
    resourceType: 'export',
    metadata: { sections: Object.keys(data), size: zipBuffer.length },
  });

  return zipBuffer;
}

// ─── Import ────────────────────────────────────────────────

interface ImportResult {
  imported: Record<string, number>;
  skipped: Record<string, number>;
  errors: string[];
}

/**
 * Import platform data from a ZIP buffer.
 * No-overwrite: skips records whose primary key or unique constraint already exists.
 */
export async function importPlatform(zipBuffer: Buffer, userId?: string): Promise<ImportResult> {
  const zip = new AdmZip(zipBuffer);
  const entries = zip.getEntries();

  // Read manifest
  const manifestEntry = entries.find(e => e.entryName === 'manifest.json');
  if (!manifestEntry) {
    throw new AppError(400, 'INVALID_ARCHIVE', 'Missing manifest.json in archive');
  }
  const manifest = JSON.parse(manifestEntry.getData().toString('utf8'));
  if (manifest.platform !== 'xray-bi') {
    throw new AppError(400, 'INVALID_ARCHIVE', 'Archive is not an XRay BI export');
  }

  // Read all data files
  const dataFiles: Record<string, any[]> = {};
  for (const entry of entries) {
    if (entry.entryName.startsWith('data/') && entry.entryName.endsWith('.json')) {
      const key = entry.entryName.replace('data/', '').replace('.json', '');
      try {
        dataFiles[key] = JSON.parse(entry.getData().toString('utf8'));
      } catch {
        // skip malformed files
      }
    }
  }

  // Read image mapping
  let imageMapping: Array<{ original_url: string; archive_path: string }> = [];
  const imgIndexEntry = entries.find(e => e.entryName === 'images/index.json');
  if (imgIndexEntry) {
    try {
      imageMapping = JSON.parse(imgIndexEntry.getData().toString('utf8'));
    } catch { /* skip */ }
  }

  const result: ImportResult = { imported: {}, skipped: {}, errors: [] };

  await withAdminClient(async (client) => {

    // ── Import roles (before users, as users reference roles) ──
    if (dataFiles.roles) {
      const { imported, skipped } = await importRows(client, 'platform.roles', dataFiles.roles, 'id', ['id', 'name', 'slug', 'description', 'is_system']);
      result.imported.roles = imported;
      result.skipped.roles = skipped;
    }

    if (dataFiles.permissions) {
      const { imported, skipped } = await importRows(client, 'platform.permissions', dataFiles.permissions, 'id', ['id', 'key', 'label', 'category', 'description']);
      result.imported.permissions = imported;
      result.skipped.permissions = skipped;
    }

    if (dataFiles.role_permissions) {
      const { imported, skipped } = await importRows(client, 'platform.role_permissions', dataFiles.role_permissions, 'role_id,permission_id', ['role_id', 'permission_id']);
      result.imported.role_permissions = imported;
      result.skipped.role_permissions = skipped;
    }

    // ── Import tenants ──
    if (dataFiles.tenants) {
      const { imported, skipped } = await importRows(client, 'platform.tenants', dataFiles.tenants, 'id',
        ['id', 'name', 'slug', 'owner_user_id', 'status', 'created_at', 'updated_at']);
      result.imported.tenants = imported;
      result.skipped.tenants = skipped;

      // Create billing state for new tenants
      for (const tenant of dataFiles.tenants) {
        if (tenant.plan_tier) {
          await safeInsert(client, 'platform.billing_state',
            { tenant_id: tenant.id, plan_tier: tenant.plan_tier, dashboard_limit: tenant.dashboard_limit ?? 0, payment_status: tenant.payment_status ?? 'none' },
            'tenant_id');
        }
      }
    }

    // ── Import users ──
    if (dataFiles.users) {
      const { imported, skipped } = await importRows(client, 'platform.users', dataFiles.users, 'id',
        ['id', 'tenant_id', 'email', 'name', 'role_id', 'status', 'auth_method', 'created_at']);
      result.imported.users = imported;
      result.skipped.users = skipped;
    }

    // ── Import tenant notes ──
    if (dataFiles.tenant_notes) {
      const { imported, skipped } = await importRows(client, 'platform.tenant_notes', dataFiles.tenant_notes, 'id',
        ['id', 'tenant_id', 'author_id', 'content', 'created_at', 'updated_at']);
      result.imported.tenant_notes = imported;
      result.skipped.tenant_notes = skipped;
    }

    // ── Import connections ──
    // integration_id + auth_method imported so the scheduler recognizes
    // OAuth-shaped rows. Tokens / api_key are NOT in the export
    // (excluded above) and NOT in this whitelist — tenants reconnect
    // after import to populate fresh credentials.
    if (dataFiles.connections) {
      const { imported, skipped } = await importRows(client, 'platform.connections', dataFiles.connections, 'id',
        ['id', 'tenant_id', 'name', 'source_type', 'source_detail', 'pipeline_ref', 'description', 'connection_details', 'image_url', 'status', 'integration_id', 'auth_method', 'created_at', 'updated_at']);
      result.imported.connections = imported;
      result.skipped.connections = skipped;
    }

    if (dataFiles.connection_tables) {
      const { imported, skipped } = await importRows(client, 'platform.connection_tables', dataFiles.connection_tables, 'id',
        ['id', 'connection_id', 'tenant_id', 'table_name', 'description', 'row_count']);
      result.imported.connection_tables = imported;
      result.skipped.connection_tables = skipped;
    }

    if (dataFiles.connection_comments) {
      const { imported, skipped } = await importRows(client, 'platform.connection_comments', dataFiles.connection_comments, 'id',
        ['id', 'connection_id', 'author_id', 'content', 'created_at', 'updated_at']);
      result.imported.connection_comments = imported;
      result.skipped.connection_comments = skipped;
    }

    // ── Import dashboards ──
    if (dataFiles.dashboards) {
      // `fetch_headers` is intentionally absent from this whitelist
      // post step 3 (migration 020 drops the column). Older exports that
      // still carry the field will just have it ignored on import — the
      // JWT bridge path replaces it.
      // scope (step 4b) joins the whitelist so Global dashboards
      // (scope='global', tenant_id=NULL) round-trip correctly. Older
      // exports pre-4b will have scope absent in the row; the column
      // default 'tenant' applies at INSERT time.
      const { imported, skipped } = await importRows(client, 'platform.dashboards', dataFiles.dashboards, 'id',
        ['id', 'tenant_id', 'name', 'description', 'view_html', 'view_css', 'view_js', 'fetch_url', 'fetch_method', 'fetch_body', 'tile_image_url', 'status', 'is_public', 'created_at', 'updated_at', 'template_id', 'integration', 'params', 'bridge_secret', 'scope']);
      result.imported.dashboards = imported;
      result.skipped.dashboards = skipped;
    }

    if (dataFiles.dashboard_access) {
      const { imported, skipped } = await importRows(client, 'platform.dashboard_access', dataFiles.dashboard_access, 'id',
        ['id', 'dashboard_id', 'user_id', 'granted_by', 'created_at']);
      result.imported.dashboard_access = imported;
      result.skipped.dashboard_access = skipped;
    }

    if (dataFiles.dashboard_embeds) {
      const { imported, skipped } = await importRows(client, 'platform.dashboard_embeds', dataFiles.dashboard_embeds, 'id',
        ['id', 'dashboard_id', 'embed_token', 'allowed_domains', 'is_active', 'expires_at', 'created_at']);
      result.imported.dashboard_embeds = imported;
      result.skipped.dashboard_embeds = skipped;
    }

    // ── Import email templates ──
    if (dataFiles.email_templates) {
      const { imported, skipped } = await importRows(client, 'platform.email_templates', dataFiles.email_templates, 'template_key',
        ['template_key', 'subject', 'body_html', 'body_text', 'variables', 'description']);
      result.imported.email_templates = imported;
      result.skipped.email_templates = skipped;
    }

    // ── Import connection templates ──
    if (dataFiles.connection_templates) {
      const { imported, skipped } = await importRows(client, 'platform.connection_templates', dataFiles.connection_templates, 'id',
        ['id', 'name', 'description', 'fetch_method', 'fetch_url', 'fetch_headers', 'fetch_body']);
      result.imported.connection_templates = imported;
      result.skipped.connection_templates = skipped;
    }
  });

  auditService.log({
    tenantId: '00000000-0000-0000-0000-000000000000',
    userId,
    action: 'platform.import',
    resourceType: 'import',
    metadata: { imported: result.imported, skipped: result.skipped, errors: result.errors.length },
  });

  return result;
}

// ─── Helpers ──────────────────────────────────────────────

async function importRows(
  client: any,
  table: string,
  rows: any[],
  conflictKey: string,
  columns: string[]
): Promise<{ imported: number; skipped: number }> {
  let imported = 0;
  let skipped = 0;

  for (const row of rows) {
    try {
      // Build column/value lists from available data
      const availableCols: string[] = [];
      const values: unknown[] = [];
      const placeholders: string[] = [];
      let idx = 1;

      for (const col of columns) {
        if (row[col] !== undefined) {
          availableCols.push(col);
          // Handle JSONB and array values
          const val = row[col];
          if (val !== null && typeof val === 'object' && !Array.isArray(val)) {
            values.push(JSON.stringify(val));
          } else if (Array.isArray(val)) {
            // PostgreSQL array - check if it's a text array
            values.push(val);
          } else {
            values.push(val);
          }
          placeholders.push(`$${idx}`);
          idx++;
        }
      }

      if (availableCols.length === 0) continue;

      const sql = `INSERT INTO ${table} (${availableCols.join(', ')}) VALUES (${placeholders.join(', ')}) ON CONFLICT (${conflictKey}) DO NOTHING`;
      const result = await client.query(sql, values);
      if (result.rowCount > 0) {
        imported++;
      } else {
        skipped++;
      }
    } catch (err: any) {
      skipped++;
      // Foreign key violations etc are expected when partial data
    }
  }

  return { imported, skipped };
}

async function safeInsert(client: any, table: string, data: Record<string, unknown>, conflictKey: string) {
  const cols = Object.keys(data);
  const vals = Object.values(data);
  const placeholders = cols.map((_, i) => `$${i + 1}`);
  try {
    await client.query(
      `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders.join(', ')}) ON CONFLICT (${conflictKey}) DO NOTHING`,
      vals
    );
  } catch {
    // Ignore errors
  }
}

function guessExtension(url: string, contentType: string): string {
  if (contentType.includes('svg')) return '.svg';
  if (contentType.includes('png')) return '.png';
  if (contentType.includes('jpeg') || contentType.includes('jpg')) return '.jpg';
  if (contentType.includes('gif')) return '.gif';
  if (contentType.includes('webp')) return '.webp';
  // Try from URL
  const urlPath = url.split('?')[0];
  const ext = path.extname(urlPath);
  if (ext && ext.length <= 5) return ext;
  return '.bin';
}

function sanitizeFilename(url: string): string {
  return url.split('/').pop()?.split('?')[0]?.replace(/[^a-zA-Z0-9._-]/g, '_')?.substring(0, 40) || 'image';
}
