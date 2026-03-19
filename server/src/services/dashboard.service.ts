import { withClient, withTransaction } from '../db/connection';
import { generateToken, hashToken } from '../lib/crypto';
import { AppError } from '../middleware/error-handler';

interface Dashboard {
  id: string;
  tenant_id: string;
  name: string;
  description: string | null;
  view_html: string | null;
  view_css: string | null;
  view_js: string | null;
  is_public: boolean;
  status: string;
  created_at: string;
  updated_at: string;
}

interface DashboardSource {
  id: string;
  dashboard_id: string;
  source_key: string;
  table_name: string;
  query_template: string | null;
  refresh_cadence: string;
}

// ─── Core CRUD ──────────────────────────────────────────────────────────────

export async function listDashboards(
  tenantId: string,
  userId: string,
  hasManagePermission: boolean
): Promise<Dashboard[]> {
  return withClient(async (client) => {
    await client.query(`SET LOCAL app.current_tenant = '${tenantId}'`);
    await client.query(`SET LOCAL app.is_platform_admin = 'false'`);

    if (hasManagePermission) {
      const result = await client.query(
        `SELECT * FROM platform.dashboards
         WHERE tenant_id = $1
         ORDER BY created_at DESC`,
        [tenantId]
      );
      return result.rows;
    }

    // Return only dashboards the user has access to
    const result = await client.query(
      `SELECT d.* FROM platform.dashboards d
       JOIN platform.dashboard_access da ON da.dashboard_id = d.id
       WHERE d.tenant_id = $1 AND da.user_id = $2
       ORDER BY d.created_at DESC`,
      [tenantId, userId]
    );
    return result.rows;
  });
}

export async function getDashboard(
  dashboardId: string,
  tenantId: string
): Promise<Dashboard> {
  return withClient(async (client) => {
    const result = await client.query(
      `SELECT * FROM platform.dashboards WHERE id = $1 AND tenant_id = $2`,
      [dashboardId, tenantId]
    );
    if (result.rows.length === 0) {
      throw new AppError(404, 'DASHBOARD_NOT_FOUND', 'Dashboard not found');
    }
    return result.rows[0];
  });
}

export async function createDashboard(input: {
  tenantId: string;
  name: string;
  description?: string;
  viewHtml?: string;
  viewCss?: string;
  viewJs?: string;
}): Promise<Dashboard> {
  return withTransaction(async (client) => {
    // Check dashboard limit for non-platform-admin tenants
    const billingResult = await client.query(
      'SELECT dashboard_limit FROM platform.billing_state WHERE tenant_id = $1',
      [input.tenantId]
    );

    if (billingResult.rows.length > 0) {
      const limit = billingResult.rows[0].dashboard_limit;
      // limit of 0 is treated as unlimited for platform admin tenants
      if (limit > 0) {
        const countResult = await client.query(
          'SELECT COUNT(*) FROM platform.dashboards WHERE tenant_id = $1',
          [input.tenantId]
        );
        const count = parseInt(countResult.rows[0].count, 10);
        if (count >= limit) {
          throw new AppError(
            403,
            'DASHBOARD_LIMIT_REACHED',
            'Dashboard limit reached for your plan. Please upgrade.'
          );
        }
      }
    }

    const result = await client.query(
      `INSERT INTO platform.dashboards (tenant_id, name, description, view_html, view_css, view_js)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        input.tenantId,
        input.name,
        input.description || null,
        input.viewHtml || null,
        input.viewCss || null,
        input.viewJs || null,
      ]
    );
    return result.rows[0];
  });
}

export async function updateDashboard(
  dashboardId: string,
  updates: Partial<Pick<Dashboard, 'name' | 'description' | 'view_html' | 'view_css' | 'view_js' | 'status' | 'is_public'>>
): Promise<Dashboard> {
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
    values.push(dashboardId);

    const result = await client.query(
      `UPDATE platform.dashboards SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
      values
    );

    if (result.rows.length === 0) {
      throw new AppError(404, 'DASHBOARD_NOT_FOUND', 'Dashboard not found');
    }
    return result.rows[0];
  });
}

// ─── Access control ─────────────────────────────────────────────────────────

export async function grantAccess(
  dashboardId: string,
  userId: string,
  grantedBy: string,
  tenantId: string
): Promise<void> {
  await withClient(async (client) => {
    await client.query(
      `INSERT INTO platform.dashboard_access (dashboard_id, user_id, granted_by, tenant_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (dashboard_id, user_id) DO NOTHING`,
      [dashboardId, userId, grantedBy, tenantId]
    );
  });
}

export async function revokeAccess(
  dashboardId: string,
  userId: string
): Promise<void> {
  await withClient(async (client) => {
    await client.query(
      'DELETE FROM platform.dashboard_access WHERE dashboard_id = $1 AND user_id = $2',
      [dashboardId, userId]
    );
  });
}

export async function getAccessList(
  dashboardId: string
): Promise<Array<{ user_id: string; email: string; name: string; granted_at: string }>> {
  return withClient(async (client) => {
    const result = await client.query(
      `SELECT da.user_id, u.email, u.name, da.created_at as granted_at
       FROM platform.dashboard_access da
       JOIN platform.users u ON u.id = da.user_id
       WHERE da.dashboard_id = $1
       ORDER BY da.created_at`,
      [dashboardId]
    );
    return result.rows;
  });
}

// ─── Bundle ─────────────────────────────────────────────────────────────────

export async function buildDashboardBundle(
  tenantId: string,
  userId: string,
  hasManagePermission: boolean
): Promise<Record<string, unknown>> {
  const dashboards = await listDashboards(tenantId, userId, hasManagePermission);

  const sources = await withClient(async (client) => {
    if (dashboards.length === 0) return [];
    const ids = dashboards.map((d) => d.id);
    const placeholders = ids.map((_, i) => `$${i + 1}`).join(', ');
    const result = await client.query(
      `SELECT id, dashboard_id, source_key, table_name, query_template, refresh_cadence
       FROM platform.dashboard_sources
       WHERE dashboard_id IN (${placeholders})`,
      ids
    );
    return result.rows;
  });

  return {
    version: 1,
    generated_at: new Date().toISOString(),
    dashboards: dashboards.map((d) => ({
      id: d.id,
      name: d.name,
      description: d.description,
      view_html: d.view_html,
      view_css: d.view_css,
      view_js: d.view_js,
      status: d.status,
      sources: (sources as DashboardSource[])
        .filter((s) => s.dashboard_id === d.id)
        .map((s) => ({
          key: s.source_key,
          table_name: s.table_name,
          cadence: s.refresh_cadence,
        })),
    })),
  };
}

// ─── Embeds ─────────────────────────────────────────────────────────────────

export async function createEmbed(
  dashboardId: string,
  tenantId: string,
  options: { allowedDomains?: string[]; expiresAt?: string },
  createdBy: string
): Promise<{ embedToken: string; id: string }> {
  const embedToken = generateToken(32);

  const result = await withClient(async (client) => {
    return client.query(
      `INSERT INTO platform.dashboard_embeds
         (dashboard_id, tenant_id, embed_token, allowed_domains, created_by, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [
        dashboardId,
        tenantId,
        embedToken,
        options.allowedDomains || null,
        createdBy,
        options.expiresAt || null,
      ]
    );
  });

  return { embedToken, id: result.rows[0].id };
}

export async function getEmbedDashboard(
  embedToken: string
): Promise<Dashboard> {
  return withClient(async (client) => {
    const embedResult = await client.query(
      `SELECT e.dashboard_id, e.allowed_domains, e.expires_at, e.is_active
       FROM platform.dashboard_embeds e
       WHERE e.embed_token = $1`,
      [embedToken]
    );

    if (embedResult.rows.length === 0) {
      throw new AppError(404, 'EMBED_NOT_FOUND', 'Embed not found');
    }

    const embed = embedResult.rows[0];

    if (!embed.is_active) {
      throw new AppError(403, 'EMBED_INACTIVE', 'This embed has been deactivated');
    }

    if (embed.expires_at && new Date(embed.expires_at) < new Date()) {
      throw new AppError(403, 'EMBED_EXPIRED', 'This embed has expired');
    }

    const dashResult = await client.query(
      'SELECT * FROM platform.dashboards WHERE id = $1',
      [embed.dashboard_id]
    );

    if (dashResult.rows.length === 0) {
      throw new AppError(404, 'DASHBOARD_NOT_FOUND', 'Dashboard not found');
    }

    return dashResult.rows[0];
  });
}
