import { withClient, withTransaction } from '../db/connection';
import { AppError } from '../middleware/error-handler';
import { encrypt } from '../lib/crypto';
import { encryptSecret, decryptSecret } from '../lib/encrypted-column';
import { mintBridgeJwt } from '../lib/n8n-bridge';
import { refreshCache as refreshSettingsCache } from './settings.service';
import * as auditService from './audit.service';

function decryptConnectionRow<T extends { id: string; connection_details?: string | null }>(row: T): T {
  if (row.connection_details !== undefined) {
    row.connection_details = decryptSecret(row.connection_details, `connections:connection_details:${row.id}`);
  }
  return row;
}

function decryptDashboardRow<T extends { id: string; bridge_secret?: unknown }>(row: T): T {
  // Never return the signing-secret ciphertext or plaintext to the
  // client. Surface a boolean so the admin UI can show "secret is set"
  // without exposing the value.
  if ('bridge_secret' in (row as object)) {
    (row as Record<string, unknown>).bridge_secret_set =
      typeof row.bridge_secret === 'string' && row.bridge_secret !== '';
    delete (row as Record<string, unknown>).bridge_secret;
  }
  return row;
}

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
    const [uc, dc, cc, bs, ow] = await Promise.all([
      client.query('SELECT COUNT(*) FROM platform.users WHERE tenant_id = $1', [tenantId]),
      client.query('SELECT COUNT(*) FROM platform.dashboards WHERE tenant_id = $1', [tenantId]),
      client.query('SELECT COUNT(*) FROM platform.connections WHERE tenant_id = $1', [tenantId]),
      client.query('SELECT * FROM platform.billing_state WHERE tenant_id = $1', [tenantId]),
      tenant.owner_user_id ? client.query('SELECT email FROM platform.users WHERE id = $1', [tenant.owner_user_id]) : Promise.resolve({ rows: [] }),
    ]);
    return {
      ...tenant,
      owner_email: ow.rows[0]?.email || null,
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

// ─── Tenant Status & Members ──────────────────────────────

export async function updateTenantStatus(tenantId: string, status: string) {
  return withClient(async (client) => {
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
    const result = await client.query(
      `UPDATE platform.tenants SET status = $1, updated_at = now() WHERE id = $2 RETURNING *`,
      [status, tenantId]
    );
    if (result.rows.length === 0) throw new AppError(404, 'NOT_FOUND', 'Tenant not found');
    auditService.log({ tenantId, action: 'tenant.status_update', resourceType: 'tenant', resourceId: tenantId, metadata: { status } });
    return result.rows[0];
  });
}

export async function listTenantMembers(tenantId: string) {
  return withClient(async (client) => {
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
    const result = await client.query(
      `SELECT u.id, u.email, u.name, u.is_owner, u.status, u.last_login_at, u.created_at,
              r.name AS role_name, r.slug AS role_slug
       FROM platform.users u
       LEFT JOIN platform.roles r ON r.id = u.role_id
       WHERE u.tenant_id = $1
       ORDER BY u.is_owner DESC, u.created_at ASC`,
      [tenantId]
    );
    return result.rows;
  });
}

export async function addTenantMember(tenantId: string, input: { name: string; email: string; role: string }) {
  return withClient(async (client) => {
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
    // Verify tenant exists
    const tenant = await client.query('SELECT id FROM platform.tenants WHERE id = $1', [tenantId]);
    if (tenant.rows.length === 0) throw new AppError(404, 'NOT_FOUND', 'Tenant not found');
    // Check for duplicate email in this tenant
    const existing = await client.query(
      'SELECT id FROM platform.users WHERE tenant_id = $1 AND email = $2',
      [tenantId, input.email]
    );
    if (existing.rows.length > 0) throw new AppError(409, 'DUPLICATE', 'A user with this email already exists in this tenant');
    // Get role ID
    const roleResult = await client.query(
      'SELECT id FROM platform.roles WHERE slug = $1',
      [input.role]
    );
    if (roleResult.rows.length === 0) throw new AppError(400, 'INVALID_ROLE', 'Role not found: ' + input.role);
    const roleId = roleResult.rows[0].id;
    const isOwner = input.role === 'owner';
    // Create user
    const result = await client.query(
      `INSERT INTO platform.users (tenant_id, email, name, role_id, is_owner, status)
       VALUES ($1, $2, $3, $4, $5, 'active') RETURNING *`,
      [tenantId, input.email, input.name, roleId, isOwner]
    );
    // If owner, update tenant owner_user_id
    if (isOwner) {
      await client.query(
        'UPDATE platform.tenants SET owner_user_id = $1 WHERE id = $2',
        [result.rows[0].id, tenantId]
      );
    }
    auditService.log({ tenantId, action: 'user.create', resourceType: 'user', resourceId: result.rows[0].id, metadata: { name: input.name, email: input.email, role: input.role } });
    return result.rows[0];
  });
}

export async function removeTenantMember(tenantId: string, userId: string) {
  return withClient(async (client) => {
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
    // Check user exists and belongs to this tenant
    const user = await client.query(
      'SELECT id, is_owner, email, name FROM platform.users WHERE id = $1 AND tenant_id = $2',
      [userId, tenantId]
    );
    if (user.rows.length === 0) throw new AppError(404, 'NOT_FOUND', 'User not found in this tenant');
    // If this user is the tenant owner, clear the owner reference
    if (user.rows[0].is_owner) {
      await client.query('UPDATE platform.tenants SET owner_user_id = NULL WHERE id = $1 AND owner_user_id = $2', [tenantId, userId]);
    }
    // Clean up FK references that don't cascade
    await client.query('DELETE FROM platform.invitations WHERE invited_by = $1', [userId]).catch(() => {});
    await client.query('UPDATE platform.tenant_notes SET author_id = NULL WHERE author_id = $1', [userId]).catch(() => {});
    await client.query('UPDATE platform.connections SET updated_by = NULL WHERE updated_by = $1', [userId]).catch(() => {});
    await client.query('UPDATE platform.dashboards SET updated_by = NULL WHERE updated_by = $1', [userId]).catch(() => {});
    await client.query('DELETE FROM platform.support_calls WHERE caller_id = $1', [userId]).catch(() => {});
    // Delete records that reference user (sessions, magic links cascade automatically)
    await client.query('DELETE FROM platform.user_sessions WHERE user_id = $1', [userId]);
    await client.query('DELETE FROM platform.magic_links WHERE email = $1', [user.rows[0].email]);
    // Delete the user
    await client.query('DELETE FROM platform.users WHERE id = $1', [userId]);
    auditService.log({ tenantId, action: 'user.delete', resourceType: 'user', resourceId: userId, metadata: { name: user.rows[0].name, email: user.rows[0].email } });
    return { deleted: true };
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
    return { data: result.rows.map(decryptDashboardRow), total, page: query.page, limit: query.limit };
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
    return decryptDashboardRow(result.rows[0]);
  });
}

export async function createDashboard(input: {
  tenantId: string; name: string; description?: string; status?: string;
  viewHtml?: string; viewCss?: string; viewJs?: string;
  fetchUrl?: string | null; fetchMethod?: string; fetchBody?: unknown;
  fetchQueryParams?: Record<string, string> | null;
  tileImageUrl?: string | null;
  templateId?: string | null; integration?: string | null; params?: Record<string, unknown> | null;
  bridgeSecret?: string | null;
}) {
  // If the caller is attaching an integration, the row MUST carry a
  // bridge_secret — otherwise the render path has nothing to sign with.
  // The admin UI's "Generate" button fills this field client-side; the
  // server only enforces presence.
  if (input.integration && !input.bridgeSecret) {
    throw new AppError(
      400,
      'BRIDGE_SECRET_REQUIRED',
      'Bridge signing secret is required when integration is set. Use the Generate button in the builder or paste a value.'
    );
  }
  return withClient(async (client) => {
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
    const result = await client.query(
      `INSERT INTO platform.dashboards (tenant_id, name, description, status, view_html, view_css, view_js, fetch_url, fetch_method, fetch_body, fetch_query_params, tile_image_url, template_id, integration, params, bridge_secret)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16) RETURNING *`,
      [
        input.tenantId, input.name, input.description || null,
        input.status || 'draft',
        input.viewHtml || null, input.viewCss || null, input.viewJs || null,
        input.fetchUrl || null, input.fetchMethod || 'GET',
        input.fetchBody ? JSON.stringify(input.fetchBody) : null,
        input.fetchQueryParams ? JSON.stringify(input.fetchQueryParams) : null,
        input.tileImageUrl || null,
        input.templateId || null,
        input.integration || null,
        JSON.stringify(input.params || {}),
        encryptSecret(input.bridgeSecret || null),
      ]
    );
    const dash = result.rows[0];
    auditService.log({ tenantId: input.tenantId, action: 'dashboard.create', resourceType: 'dashboard', resourceId: dash.id, metadata: { name: input.name } });
    return decryptDashboardRow(dash);
  });
}

export async function updateDashboard(dashboardId: string, updates: Record<string, unknown>) {
  return withClient(async (client) => {
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);

    // Bridge-secret consistency check. Fetch current state so we can
    // reason about the resulting row: if integration will be non-empty
    // post-update, bridge_secret must also be non-empty post-update —
    // either already on the row or supplied in this patch.
    const current = await client.query(
      'SELECT integration, bridge_secret FROM platform.dashboards WHERE id = $1',
      [dashboardId]
    );
    if (current.rows.length === 0) throw new AppError(404, 'NOT_FOUND', 'Dashboard not found');
    const currentRow = current.rows[0] as { integration: string | null; bridge_secret: string | null };

    const integrationUpdate = updates.integration;
    const bridgeSecretUpdate = updates.bridgeSecret;
    const nextIntegration =
      integrationUpdate === undefined
        ? currentRow.integration
        : (integrationUpdate === '' ? null : (integrationUpdate as string | null));
    // nextBridgeSecret represents "will the row have a usable secret
    // after this update". Null/empty in the patch is a clear. Undefined
    // means "unchanged — fall back to whatever's on the row".
    const nextBridgeSecretSupplied =
      bridgeSecretUpdate !== undefined
        ? (bridgeSecretUpdate ? String(bridgeSecretUpdate) : null)
        : (currentRow.bridge_secret ? 'unchanged' : null);
    if (nextIntegration && !nextBridgeSecretSupplied) {
      throw new AppError(
        400,
        'BRIDGE_SECRET_REQUIRED',
        'Bridge signing secret is required when integration is set. Use the Generate button in the builder or paste a value.'
      );
    }

    const fields: string[] = [];
    const values: unknown[] = [];
    let idx = 1;
    const allowedKeys: Record<string, string> = {
      name: 'name', description: 'description', viewHtml: 'view_html',
      viewCss: 'view_css', viewJs: 'view_js', status: 'status',
      fetchUrl: 'fetch_url', fetchMethod: 'fetch_method',
      fetchBody: 'fetch_body',
      fetchQueryParams: 'fetch_query_params',
      tileImageUrl: 'tile_image_url',
      templateId: 'template_id', integration: 'integration', params: 'params',
      bridgeSecret: 'bridge_secret',
    };
    for (const [key, value] of Object.entries(updates)) {
      const col = allowedKeys[key];
      if (col && value !== undefined) {
        fields.push(`${col} = $${idx}`);
        if (col === 'fetch_body' || col === 'fetch_query_params') {
          values.push(value ? JSON.stringify(value) : null);
        } else if (col === 'params') {
          // JSONB column with NOT NULL DEFAULT '{}'. Coerce null/undefined
          // to '{}' so the admin can "clear" params without hitting the
          // constraint.
          values.push(JSON.stringify(value || {}));
        } else if (col === 'template_id' || col === 'integration') {
          // Empty string from the form clears the field back to NULL.
          // Post step 3 that also breaks the render path — a fetch_url
          // dashboard with no integration now errors at render — so the
          // admin UI only allows clearing integration alongside clearing
          // fetch_url/archiving the dashboard.
          values.push(value === '' ? null : value);
        } else if (col === 'bridge_secret') {
          // Encrypt under the same enc:v1: envelope the trigger enforces.
          // Empty string clears the secret (only meaningful when
          // integration is also being cleared in the same call; the
          // consistency check above guards that).
          const v = value === '' ? null : (value as string);
          values.push(encryptSecret(v));
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
    return decryptDashboardRow(dash);
  });
}

export async function deleteDashboard(dashboardId: string) {
  return withClient(async (client) => {
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
    const result = await client.query(
      'DELETE FROM platform.dashboards WHERE id = $1 RETURNING id, name, tenant_id',
      [dashboardId]
    );
    if (result.rows.length === 0) throw new AppError(404, 'NOT_FOUND', 'Dashboard not found');
    const dash = result.rows[0];
    auditService.log({ tenantId: dash.tenant_id, action: 'dashboard.delete', resourceType: 'dashboard', resourceId: dashboardId, metadata: { name: dash.name } });
    return { deleted: true };
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

export async function fetchDashboardContent(dashboardId: string, adminUserId?: string) {
  return withClient(async (client) => {
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
    // JOIN tenants for tenant_* labels. LEFT JOIN users+roles on the acting
    // admin — platform admins don't belong to the target tenant, so this
    // is decoupled from d.tenant_id. adminUserId is optional to stay
    // backwards-compatible with any internal caller that doesn't have one.
    const result = await client.query(
      `SELECT d.id, d.tenant_id, d.name AS dashboard_name, d.status AS dashboard_status,
              d.fetch_url, d.fetch_method, d.fetch_body, d.fetch_query_params,
              d.template_id, d.integration, d.params, d.bridge_secret, d.is_public,
              t.slug AS tenant_slug, t.name AS tenant_name, t.status AS tenant_status,
              t.warehouse_host,
              u.email AS user_email, u.name AS user_name,
              r.slug AS user_role
         FROM platform.dashboards d
         JOIN platform.tenants t ON t.id = d.tenant_id
         LEFT JOIN platform.users u ON u.id = $2
         LEFT JOIN platform.roles r ON r.id = u.role_id
        WHERE d.id = $1`,
      [dashboardId, adminUserId ?? null]
    );
    if (result.rows.length === 0) throw new AppError(404, 'NOT_FOUND', 'Dashboard not found');
    const dash = result.rows[0];
    if (!dash.fetch_url) throw new AppError(400, 'NO_CONNECTION', 'Dashboard has no connection URL configured');

    // JWT bridge is the only render path post step 3 (migration 020).
    // A row with fetch_url but no integration is a config error.
    if (!dash.integration) {
      throw new AppError(
        500,
        'BRIDGE_INTEGRATION_MISSING',
        'This dashboard has a fetch_url but no integration configured.'
      );
    }
    const bridgeSecret = decryptSecret(dash.bridge_secret, `dashboards:bridge_secret:${dash.id}`);
    if (!bridgeSecret) {
      throw new AppError(
        500,
        'BRIDGE_SECRET_MISSING',
        'This dashboard has an integration but no bridge signing secret.'
      );
    }
    const minted = mintBridgeJwt({
      tenantId: dash.tenant_id,
      tenantSlug: dash.tenant_slug,
      tenantName: dash.tenant_name,
      tenantStatus: dash.tenant_status,
      warehouseHost: dash.warehouse_host,
      dashboardId: dash.id,
      dashboardName: dash.dashboard_name,
      dashboardStatus: dash.dashboard_status,
      isPublic: dash.is_public,
      templateId: dash.template_id || null,
      integration: dash.integration,
      params: (dash.params as Record<string, unknown>) || {},
      userId: adminUserId || null,
      userEmail: dash.user_email,
      userName: dash.user_name,
      userRole: dash.user_role,
      // Any caller of fetchDashboardContent is gated by
      // requirePermission('platform.admin'), so the acting user IS a
      // platform admin by construction. No per-request lookup needed.
      isPlatformAdmin: adminUserId ? true : null,
      via: 'admin_preview',
      secret: bridgeSecret,
    });
    const headers: Record<string, string> = { Authorization: `Bearer ${minted.jwt}` };
    auditService.log({
      tenantId: dash.tenant_id,
      userId: adminUserId,
      action: 'dashboard.bridge_mint',
      resourceType: 'dashboard',
      resourceId: dash.id,
      metadata: {
        jti: minted.jti,
        integration: dash.integration,
        template_id: dash.template_id || null,
        via: 'admin_preview',
      },
    });

    const fetchOpts: RequestInit = {
      method: dash.fetch_method || 'GET',
      headers: { 'Content-Type': 'application/json', ...headers },
    };
    if (dash.fetch_body && dash.fetch_method !== 'GET') {
      fetchOpts.body = typeof dash.fetch_body === 'string' ? dash.fetch_body : JSON.stringify(dash.fetch_body);
    }

    // Append query params if configured
    let fetchUrl = dash.fetch_url;
    if (dash.fetch_query_params) {
      const qp = typeof dash.fetch_query_params === 'string'
        ? JSON.parse(dash.fetch_query_params) : dash.fetch_query_params;
      if (qp && typeof qp === 'object' && Object.keys(qp).length > 0) {
        const url = new URL(fetchUrl);
        for (const [k, v] of Object.entries(qp)) {
          url.searchParams.set(k, String(v));
        }
        fetchUrl = url.toString();
      }
    }

    const response = await fetch(fetchUrl, fetchOpts);
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
    return { data: result.rows.map(decryptConnectionRow), total, page: query.page, limit: query.limit };
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
       input.description || null, encryptSecret(input.connectionDetails ?? null), input.imageUrl || null]
    );
    const conn = result.rows[0];
    auditService.log({ tenantId: input.tenantId, action: 'connection.create', resourceType: 'connection', resourceId: conn.id, metadata: { name: input.name, sourceType: input.sourceType } });
    return decryptConnectionRow(conn);
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
        if (col === 'connection_details') {
          values.push(encryptSecret(value == null ? null : String(value)));
        } else {
          values.push(value);
        }
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
    return decryptConnectionRow(conn);
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
  const result = await withClient(async (client) => {
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
  // Invalidate settings cache so getSetting() picks up new values immediately
  await refreshSettingsCache();
  return result;
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
