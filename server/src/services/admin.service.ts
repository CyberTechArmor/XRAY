import { withClient, withTransaction } from '../db/connection';
import { AppError } from '../middleware/error-handler';
import { encrypt } from '../lib/crypto';
import { refreshCache as refreshSettingsCache } from './settings.service';
import * as auditService from './audit.service';

// ─── Tenants ──────────────────────────────────────────────

export async function listAllTenants(query: { page: number; limit: number }) {
  return withClient(async (client) => {
    const offset = (query.page - 1) * query.limit;
    const countResult = await client.query('SELECT COUNT(*) FROM platform.tenants');
    const total = parseInt(countResult.rows[0].count, 10);
    const result = await client.query(
      `SELECT t.*, bs.plan_tier AS plan, bs.dashboard_limit, bs.payment_status,
              o.email AS owner_email,
              (SELECT COUNT(*) FROM platform.users u WHERE u.tenant_id = t.id) AS member_count
       FROM platform.tenants t
       LEFT JOIN platform.billing_state bs ON bs.tenant_id = t.id
       LEFT JOIN platform.users o ON o.id = t.owner_user_id
       ORDER BY t.created_at DESC LIMIT $1 OFFSET $2`,
      [query.limit, offset]
    );
    return { data: result.rows, total, page: query.page, limit: query.limit };
  });
}

export async function createTenant(input: { name: string; slug: string }) {
  return withTransaction(async (client) => {
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
    const result = await client.query(
      `INSERT INTO platform.tenants (name, slug) VALUES ($1, $2) RETURNING *`,
      [input.name, input.slug]
    );
    const tenant = result.rows[0];
    const schemaName = `tn_${tenant.id.replace(/-/g, '')}`;
    await client.query(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`);
    await client.query(
      `INSERT INTO platform.billing_state (tenant_id, plan_tier, dashboard_limit, payment_status)
       VALUES ($1, 'free', 0, 'none')`,
      [tenant.id]
    );
    auditService.log({ tenantId: tenant.id, action: 'tenant.create', resourceType: 'tenant', resourceId: tenant.id, metadata: { name: input.name, slug: input.slug } });
    return tenant;
  });
}

export async function getTenantDetail(tenantId: string) {
  return withClient(async (client) => {
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
    const tenantResult = await client.query('SELECT * FROM platform.tenants WHERE id = $1', [tenantId]);
    if (tenantResult.rows.length === 0) throw new AppError(404, 'NOT_FOUND', 'Tenant not found');
    const tenant = tenantResult.rows[0];
    const [uc, dc, cc, bs] = await Promise.all([
      client.query('SELECT COUNT(*) FROM platform.users WHERE tenant_id = $1', [tenantId]),
      client.query('SELECT COUNT(*) FROM platform.dashboards WHERE tenant_id = $1', [tenantId]),
      client.query('SELECT COUNT(*) FROM platform.connections WHERE tenant_id = $1', [tenantId]),
      client.query('SELECT * FROM platform.billing_state WHERE tenant_id = $1', [tenantId]),
    ]);
    return {
      ...tenant,
      user_count: parseInt(uc.rows[0].count, 10),
      dashboard_count: parseInt(dc.rows[0].count, 10),
      connection_count: parseInt(cc.rows[0].count, 10),
      billing_state: bs.rows[0] || null,
    };
  });
}

export async function updateTenantPlan(tenantId: string, input: {
  planTier: string;
  dashboardLimit?: number;
  connectorLimit?: number;
  paymentStatus?: string;
}) {
  return withTransaction(async (client) => {
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);

    // Check tenant exists
    const tenant = await client.query('SELECT id, name FROM platform.tenants WHERE id = $1', [tenantId]);
    if (tenant.rows.length === 0) throw new AppError(404, 'NOT_FOUND', 'Tenant not found');

    // Upsert billing state (use 0 defaults for NOT NULL integer columns)
    const result = await client.query(
      `INSERT INTO platform.billing_state (tenant_id, plan_tier, dashboard_limit, connector_limit, payment_status, updated_at)
       VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (tenant_id) DO UPDATE SET
         plan_tier = COALESCE($2, platform.billing_state.plan_tier),
         dashboard_limit = COALESCE($3, platform.billing_state.dashboard_limit),
         connector_limit = COALESCE($4, platform.billing_state.connector_limit),
         payment_status = COALESCE($5, platform.billing_state.payment_status),
         updated_at = now()
       RETURNING *`,
      [tenantId, input.planTier, input.dashboardLimit ?? 0, input.connectorLimit ?? 0, input.paymentStatus ?? 'active']
    );

    auditService.log({ tenantId, action: 'tenant.plan_update', resourceType: 'tenant', resourceId: tenantId, metadata: { planTier: input.planTier, dashboardLimit: input.dashboardLimit, connectorLimit: input.connectorLimit, paymentStatus: input.paymentStatus } });
    return result.rows[0];
  });
}

// ─── Dashboards ───────────────────────────────────────────

export async function listAllDashboards(query: { page: number; limit: number }) {
  return withClient(async (client) => {
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
    const offset = (query.page - 1) * query.limit;
    const countResult = await client.query('SELECT COUNT(*) FROM platform.dashboards');
    const total = parseInt(countResult.rows[0].count, 10);
    const result = await client.query(
      `SELECT d.*, t.name AS tenant_name, o.email AS owner_email
       FROM platform.dashboards d
       LEFT JOIN platform.tenants t ON t.id = d.tenant_id
       LEFT JOIN platform.users o ON o.id = t.owner_user_id
       ORDER BY d.created_at DESC LIMIT $1 OFFSET $2`,
      [query.limit, offset]
    );
    return { data: result.rows, total, page: query.page, limit: query.limit };
  });
}

export async function getDashboardDetail(dashboardId: string) {
  return withClient(async (client) => {
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
    const result = await client.query(
      `SELECT d.*, t.name AS tenant_name, o.email AS owner_email
       FROM platform.dashboards d
       LEFT JOIN platform.tenants t ON t.id = d.tenant_id
       LEFT JOIN platform.users o ON o.id = t.owner_user_id
       WHERE d.id = $1`,
      [dashboardId]
    );
    if (result.rows.length === 0) throw new AppError(404, 'NOT_FOUND', 'Dashboard not found');
    return result.rows[0];
  });
}

export async function createDashboard(input: {
  tenantId: string; name: string; description?: string; status?: string;
  viewHtml?: string; viewCss?: string; viewJs?: string;
  fetchUrl?: string; fetchMethod?: string; fetchHeaders?: Record<string, string>; fetchBody?: unknown;
  tileImageUrl?: string;
}) {
  return withClient(async (client) => {
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
    const result = await client.query(
      `INSERT INTO platform.dashboards (tenant_id, name, description, status, view_html, view_css, view_js, fetch_url, fetch_method, fetch_headers, fetch_body, tile_image_url)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
      [
        input.tenantId, input.name, input.description || null,
        input.status || 'draft',
        input.viewHtml || null, input.viewCss || null, input.viewJs || null,
        input.fetchUrl || null, input.fetchMethod || 'GET',
        input.fetchHeaders ? JSON.stringify(input.fetchHeaders) : '{}',
        input.fetchBody ? JSON.stringify(input.fetchBody) : null,
        input.tileImageUrl || null,
      ]
    );
    const dash = result.rows[0];
    auditService.log({ tenantId: input.tenantId, action: 'dashboard.create', resourceType: 'dashboard', resourceId: dash.id, metadata: { name: input.name } });
    return dash;
  });
}

export async function updateDashboard(dashboardId: string, updates: Record<string, unknown>) {
  return withClient(async (client) => {
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
    const fields: string[] = [];
    const values: unknown[] = [];
    let idx = 1;
    const allowedKeys: Record<string, string> = {
      name: 'name', description: 'description', viewHtml: 'view_html',
      viewCss: 'view_css', viewJs: 'view_js', status: 'status',
      fetchUrl: 'fetch_url', fetchMethod: 'fetch_method',
      fetchHeaders: 'fetch_headers', fetchBody: 'fetch_body',
      tileImageUrl: 'tile_image_url',
    };
    for (const [key, value] of Object.entries(updates)) {
      const col = allowedKeys[key];
      if (col && value !== undefined) {
        fields.push(`${col} = $${idx}`);
        // JSON fields need stringification
        if (col === 'fetch_headers' || col === 'fetch_body') {
          values.push(value ? JSON.stringify(value) : null);
        } else {
          values.push(value);
        }
        idx++;
      }
    }
    if (fields.length === 0) throw new AppError(400, 'NO_UPDATES', 'No fields to update');
    fields.push('updated_at = now()');
    values.push(dashboardId);
    const result = await client.query(
      `UPDATE platform.dashboards SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
      values
    );
    if (result.rows.length === 0) throw new AppError(404, 'NOT_FOUND', 'Dashboard not found');
    const dash = result.rows[0];
    auditService.log({ tenantId: dash.tenant_id, action: 'dashboard.update', resourceType: 'dashboard', resourceId: dashboardId, metadata: { fields: Object.keys(updates) } });
    return dash;
  });
}

// ─── Connection Templates ────────────────────────────────

export async function listConnectionTemplates() {
  return withClient(async (client) => {
    const result = await client.query('SELECT * FROM platform.connection_templates ORDER BY name');
    return result.rows;
  });
}

export async function createConnectionTemplate(input: {
  name: string; description?: string; fetchMethod?: string;
  fetchUrl?: string; fetchHeaders?: Record<string, string>; fetchBody?: unknown;
}) {
  return withClient(async (client) => {
    const result = await client.query(
      `INSERT INTO platform.connection_templates (name, description, fetch_method, fetch_url, fetch_headers, fetch_body)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [
        input.name, input.description || null, input.fetchMethod || 'GET',
        input.fetchUrl || null, input.fetchHeaders ? JSON.stringify(input.fetchHeaders) : '{}',
        input.fetchBody ? JSON.stringify(input.fetchBody) : null,
      ]
    );
    const tmpl = result.rows[0];
    auditService.log({ tenantId: '00000000-0000-0000-0000-000000000000', action: 'connection_template.create', resourceType: 'connection_template', resourceId: tmpl.id, metadata: { name: input.name } });
    return tmpl;
  });
}

export async function deleteConnectionTemplate(templateId: string) {
  return withClient(async (client) => {
    const result = await client.query(
      'DELETE FROM platform.connection_templates WHERE id = $1 RETURNING id',
      [templateId]
    );
    if (result.rows.length === 0) throw new AppError(404, 'NOT_FOUND', 'Template not found');
    auditService.log({ tenantId: '00000000-0000-0000-0000-000000000000', action: 'connection_template.delete', resourceType: 'connection_template', resourceId: templateId });
    return { deleted: true };
  });
}

// ─── Dashboard Proxy (fetch from n8n) ────────────────────

export async function fetchDashboardContent(dashboardId: string) {
  return withClient(async (client) => {
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
    const result = await client.query(
      'SELECT id, fetch_url, fetch_method, fetch_headers, fetch_body, status FROM platform.dashboards WHERE id = $1',
      [dashboardId]
    );
    if (result.rows.length === 0) throw new AppError(404, 'NOT_FOUND', 'Dashboard not found');
    const dash = result.rows[0];
    if (!dash.fetch_url) throw new AppError(400, 'NO_CONNECTION', 'Dashboard has no connection URL configured');

    const headers: Record<string, string> = typeof dash.fetch_headers === 'string'
      ? JSON.parse(dash.fetch_headers) : (dash.fetch_headers || {});

    const fetchOpts: RequestInit = {
      method: dash.fetch_method || 'GET',
      headers: { 'Content-Type': 'application/json', ...headers },
    };
    if (dash.fetch_body && dash.fetch_method !== 'GET') {
      fetchOpts.body = typeof dash.fetch_body === 'string' ? dash.fetch_body : JSON.stringify(dash.fetch_body);
    }

    const response = await fetch(dash.fetch_url, fetchOpts);
    if (!response.ok) {
      throw new AppError(502, 'UPSTREAM_ERROR', `Connection returned ${response.status}: ${response.statusText}`);
    }

    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      return await response.json();
    }
    // Return raw HTML response
    const html = await response.text();
    return { html, css: '', js: '' };
  });
}

// ─── Connections ──────────────────────────────────────────

export async function listAllConnections(query: { page: number; limit: number }) {
  return withClient(async (client) => {
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
    const offset = (query.page - 1) * query.limit;
    const countResult = await client.query('SELECT COUNT(*) FROM platform.connections');
    const total = parseInt(countResult.rows[0].count, 10);
    const result = await client.query(
      `SELECT c.*, t.name AS tenant_name
       FROM platform.connections c
       LEFT JOIN platform.tenants t ON t.id = c.tenant_id
       ORDER BY c.created_at DESC LIMIT $1 OFFSET $2`,
      [query.limit, offset]
    );
    return { data: result.rows, total, page: query.page, limit: query.limit };
  });
}

export async function createConnection(input: {
  tenantId: string; name: string; sourceType: string;
  sourceDetail?: string; pipelineRef?: string;
  description?: string; connectionDetails?: string; imageUrl?: string;
}) {
  return withClient(async (client) => {
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
    const result = await client.query(
      `INSERT INTO platform.connections (tenant_id, name, source_type, source_detail, pipeline_ref, description, connection_details, image_url)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [input.tenantId, input.name, input.sourceType, input.sourceDetail || null, input.pipelineRef || null,
       input.description || null, input.connectionDetails || null, input.imageUrl || null]
    );
    const conn = result.rows[0];
    auditService.log({ tenantId: input.tenantId, action: 'connection.create', resourceType: 'connection', resourceId: conn.id, metadata: { name: input.name, sourceType: input.sourceType } });
    return conn;
  });
}

export async function updateConnection(connectionId: string, updates: Record<string, unknown>) {
  return withClient(async (client) => {
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
    const fields: string[] = [];
    const values: unknown[] = [];
    let idx = 1;
    const allowedKeys: Record<string, string> = {
      name: 'name', status: 'status', pipelineRef: 'pipeline_ref',
      description: 'description', connectionDetails: 'connection_details', imageUrl: 'image_url',
    };
    for (const [key, value] of Object.entries(updates)) {
      const col = allowedKeys[key];
      if (col && value !== undefined) {
        fields.push(`${col} = $${idx}`);
        values.push(value);
        idx++;
      }
    }
    if (fields.length === 0) throw new AppError(400, 'NO_UPDATES', 'No fields to update');
    fields.push('updated_at = now()');
    values.push(connectionId);
    const result = await client.query(
      `UPDATE platform.connections SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
      values
    );
    if (result.rows.length === 0) throw new AppError(404, 'NOT_FOUND', 'Connection not found');
    const conn = result.rows[0];
    auditService.log({ tenantId: conn.tenant_id, action: 'connection.update', resourceType: 'connection', resourceId: connectionId, metadata: { fields: Object.keys(updates) } });
    return conn;
  });
}

export async function registerTable(connectionId: string, input: { tableName: string; description?: string }) {
  return withClient(async (client) => {
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
    const conn = await client.query('SELECT tenant_id FROM platform.connections WHERE id = $1', [connectionId]);
    if (conn.rows.length === 0) throw new AppError(404, 'NOT_FOUND', 'Connection not found');
    const result = await client.query(
      `INSERT INTO platform.connection_tables (connection_id, tenant_id, table_name, description)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [connectionId, conn.rows[0].tenant_id, input.tableName, input.description || null]
    );
    return result.rows[0];
  });
}

export async function deleteConnection(connectionId: string) {
  return withClient(async (client) => {
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
    const result = await client.query(
      'DELETE FROM platform.connections WHERE id = $1 RETURNING id, tenant_id',
      [connectionId]
    );
    if (result.rows.length === 0) throw new AppError(404, 'NOT_FOUND', 'Connection not found');
    auditService.log({ tenantId: result.rows[0].tenant_id, action: 'connection.delete', resourceType: 'connection', resourceId: connectionId });
    return { deleted: true };
  });
}

// ─── Connection Comments ─────────────────────────────────

export async function listConnectionComments(connectionId: string) {
  return withClient(async (client) => {
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
    const result = await client.query(
      `SELECT c.*, u.name AS author_name, u.email AS author_email
       FROM platform.connection_comments c
       LEFT JOIN platform.users u ON u.id = c.author_id
       WHERE c.connection_id = $1
       ORDER BY c.created_at DESC`,
      [connectionId]
    );
    return result.rows;
  });
}

export async function createConnectionComment(connectionId: string, authorId: string, content: string) {
  return withClient(async (client) => {
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
    const result = await client.query(
      `INSERT INTO platform.connection_comments (connection_id, author_id, content) VALUES ($1, $2, $3) RETURNING *`,
      [connectionId, authorId, content]
    );
    const comment = result.rows[0];
    auditService.log({ tenantId: '00000000-0000-0000-0000-000000000000', action: 'connection_comment.create', resourceType: 'connection_comment', resourceId: comment.id });
    return comment;
  });
}

export async function deleteConnectionComment(commentId: string) {
  return withClient(async (client) => {
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
    const result = await client.query(
      'DELETE FROM platform.connection_comments WHERE id = $1 RETURNING id',
      [commentId]
    );
    if (result.rows.length === 0) throw new AppError(404, 'NOT_FOUND', 'Comment not found');
    auditService.log({ tenantId: '00000000-0000-0000-0000-000000000000', action: 'connection_comment.delete', resourceType: 'connection_comment', resourceId: commentId });
    return { deleted: true };
  });
}

// ─── Tenant Notes ────────────────────────────────────────

export async function listTenantNotes(tenantId: string) {
  return withClient(async (client) => {
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
    const result = await client.query(
      `SELECT n.*, u.name AS author_name, u.email AS author_email
       FROM platform.tenant_notes n
       LEFT JOIN platform.users u ON u.id = n.author_id
       WHERE n.tenant_id = $1
       ORDER BY n.created_at DESC`,
      [tenantId]
    );
    return result.rows;
  });
}

export async function createTenantNote(tenantId: string, authorId: string, content: string) {
  return withClient(async (client) => {
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
    const result = await client.query(
      `INSERT INTO platform.tenant_notes (tenant_id, author_id, content) VALUES ($1, $2, $3) RETURNING *`,
      [tenantId, authorId, content]
    );
    const note = result.rows[0];
    auditService.log({ tenantId, userId: authorId, action: 'tenant_note.create', resourceType: 'tenant_note', resourceId: note.id });
    return note;
  });
}

export async function updateTenantNote(noteId: string, content: string) {
  return withClient(async (client) => {
    const result = await client.query(
      `UPDATE platform.tenant_notes SET content = $1, updated_at = now() WHERE id = $2 RETURNING *`,
      [content, noteId]
    );
    if (result.rows.length === 0) throw new AppError(404, 'NOT_FOUND', 'Note not found');
    const note = result.rows[0];
    auditService.log({ tenantId: note.tenant_id, action: 'tenant_note.update', resourceType: 'tenant_note', resourceId: noteId });
    return note;
  });
}

export async function deleteTenantNote(noteId: string) {
  return withClient(async (client) => {
    const result = await client.query(
      'DELETE FROM platform.tenant_notes WHERE id = $1 RETURNING id',
      [noteId]
    );
    if (result.rows.length === 0) throw new AppError(404, 'NOT_FOUND', 'Note not found');
    auditService.log({ tenantId: '00000000-0000-0000-0000-000000000000', action: 'tenant_note.delete', resourceType: 'tenant_note', resourceId: noteId });
    return { deleted: true };
  });
}

// ─── Settings ─────────────────────────────────────────────

export async function getAllSettings() {
  return withClient(async (client) => {
    const result = await client.query(
      'SELECT key, value, is_secret, updated_at FROM platform.platform_settings ORDER BY key'
    );
    return result.rows.map((r: { key: string; value: string | null; is_secret: boolean; updated_at: string }) => ({
      key: r.key,
      value: r.is_secret ? '••••••••' : r.value,
      is_secret: r.is_secret,
      updated_at: r.updated_at,
    }));
  });
}

export async function updateSettings(updates: Record<string, string | null>) {
  return withClient(async (client) => {
    for (const [key, value] of Object.entries(updates)) {
      const existing = await client.query(
        'SELECT is_secret FROM platform.platform_settings WHERE key = $1', [key]
      );
      const isSecret = existing.rows.length > 0 ? existing.rows[0].is_secret : false;
      const storedValue = value !== null && isSecret ? encrypt(value) : value;
      await client.query(
        `INSERT INTO platform.platform_settings (key, value, updated_at)
         VALUES ($1, $2, now())
         ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = now()`,
        [key, storedValue]
      );
    }
    auditService.log({ tenantId: '00000000-0000-0000-0000-000000000000', action: 'settings.update', resourceType: 'settings', metadata: { keys: Object.keys(updates) } });
    return { updated: Object.keys(updates).length };
  });
  // Invalidate settings cache so getSmtpConfig etc. pick up new values immediately
  await refreshSettingsCache();
}

// ─── Email Templates ─────────────────────────────────────

export async function listEmailTemplates() {
  return withClient(async (client) => {
    const result = await client.query(
      'SELECT template_key, subject, variables, description, updated_at FROM platform.email_templates ORDER BY template_key'
    );
    return result.rows;
  });
}

export async function getEmailTemplate(templateKey: string) {
  return withClient(async (client) => {
    const result = await client.query(
      'SELECT * FROM platform.email_templates WHERE template_key = $1',
      [templateKey]
    );
    if (result.rows.length === 0) throw new AppError(404, 'NOT_FOUND', 'Template not found');
    return result.rows[0];
  });
}

export async function updateEmailTemplate(templateKey: string, updates: {
  subject?: string; bodyHtml?: string; bodyText?: string;
}) {
  return withClient(async (client) => {
    const fields: string[] = ['updated_at = now()'];
    const values: unknown[] = [];
    let idx = 1;
    if (updates.subject !== undefined) { fields.push(`subject = $${idx}`); values.push(updates.subject); idx++; }
    if (updates.bodyHtml !== undefined) { fields.push(`body_html = $${idx}`); values.push(updates.bodyHtml); idx++; }
    if (updates.bodyText !== undefined) { fields.push(`body_text = $${idx}`); values.push(updates.bodyText); idx++; }
    values.push(templateKey);
    const result = await client.query(
      `UPDATE platform.email_templates SET ${fields.join(', ')} WHERE template_key = $${idx} RETURNING *`,
      values
    );
    if (result.rows.length === 0) throw new AppError(404, 'NOT_FOUND', 'Template not found');
    auditService.log({ tenantId: '00000000-0000-0000-0000-000000000000', action: 'email_template.update', resourceType: 'email_template', resourceId: templateKey, metadata: { fields: Object.keys(updates) } });
    return result.rows[0];
  });
}

export async function sendTestEmail(templateKey: string, userId: string) {
  const { sendTemplateEmail } = await import('./email.service');
  const user = await withClient(async (client) => {
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
    const result = await client.query('SELECT email, name FROM platform.users WHERE id = $1', [userId]);
    return result.rows[0];
  });
  if (!user) throw new AppError(404, 'NOT_FOUND', 'User not found');
  await sendTemplateEmail(templateKey, user.email, {
    code: '123456', verify_url: 'https://example.com/verify',
    platform_name: 'XRay BI', name: user.name, email: user.email,
    tenant_name: 'Test Tenant', inviter_name: 'Test', invite_url: 'https://example.com/invite',
    recovery_url: 'https://example.com/recover',
  });
  return { sent: true, to: user.email };
}
