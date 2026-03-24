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
  fetch_url: string | null;
  fetch_method: string | null;
  fetch_headers: Record<string, string> | null;
  fetch_body: unknown;
  tile_image_url: string | null;
  last_viewed_at: string | null;
  is_public: boolean;
  public_token: string | null;
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
  hasManagePermission: boolean,
  isPlatformAdmin: boolean = false
): Promise<Dashboard[]> {
  return withClient(async (client) => {
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);

    // Ensure dashboard_views table exists (added in migration 007)
    await client.query(`
      CREATE TABLE IF NOT EXISTS platform.dashboard_views (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        dashboard_id UUID NOT NULL REFERENCES platform.dashboards(id) ON DELETE CASCADE,
        user_id UUID NOT NULL REFERENCES platform.users(id),
        viewed_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    // Subquery for view count (excludes platform admin role views)
    const viewCountSub = `(SELECT COUNT(*)::int FROM platform.dashboard_views dv
       JOIN platform.users vu ON vu.id = dv.user_id
       JOIN platform.roles vr ON vr.id = vu.role_id
       WHERE dv.dashboard_id = d.id AND vr.is_platform IS NOT TRUE) AS view_count`;

    // Subquery for connector names (aggregated)
    const connectorsSub = `(SELECT COALESCE(json_agg(json_build_object(
       'id', ds.id, 'connection_name', c.name, 'source_type', c.source_type, 'source_key', ds.source_key
     ) ORDER BY c.name), '[]'::json)
     FROM platform.dashboard_sources ds
     LEFT JOIN platform.connections c ON c.id = ds.connection_id
     WHERE ds.dashboard_id = d.id) AS connectors`;

    // Platform admin: see ALL dashboards across all tenants
    if (isPlatformAdmin) {
      const result = await client.query(
        `SELECT d.*, t.name as tenant_name, ${viewCountSub}, ${connectorsSub}
         FROM platform.dashboards d
         JOIN platform.tenants t ON t.id = d.tenant_id
         ORDER BY d.updated_at DESC`
      );
      return result.rows;
    }

    await client.query(`SELECT set_config('app.current_tenant', $1, true)`, [tenantId]);

    if (hasManagePermission) {
      const result = await client.query(
        `SELECT d.*, ${viewCountSub}, ${connectorsSub}
         FROM platform.dashboards d
         WHERE d.tenant_id = $1
         ORDER BY d.updated_at DESC`,
        [tenantId]
      );
      return result.rows;
    }

    // Regular users: only dashboards they have explicit access to
    const result = await client.query(
      `SELECT d.*, ${viewCountSub}, ${connectorsSub}
       FROM platform.dashboards d
       JOIN platform.dashboard_access da ON da.dashboard_id = d.id
       WHERE d.tenant_id = $1 AND da.user_id = $2
         AND d.status IN ('active', 'disabled')
       ORDER BY d.updated_at DESC`,
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
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
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
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
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
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
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
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
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
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
    await client.query(
      'DELETE FROM platform.dashboard_access WHERE dashboard_id = $1 AND user_id = $2',
      [dashboardId, userId]
    );
  });
}

export async function checkUserAccess(
  dashboardId: string,
  userId: string
): Promise<boolean> {
  return withClient(async (client) => {
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
    const result = await client.query(
      `SELECT 1 FROM platform.dashboard_access WHERE dashboard_id = $1 AND user_id = $2`,
      [dashboardId, userId]
    );
    return result.rows.length > 0;
  });
}

export async function getAccessList(
  dashboardId: string
): Promise<Array<{ user_id: string; email: string; name: string; granted_at: string }>> {
  return withClient(async (client) => {
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
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
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
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
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
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

export async function revokeEmbed(
  embedId: string,
  dashboardId: string,
  tenantId: string
): Promise<void> {
  await withClient(async (client) => {
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
    await client.query(
      'UPDATE platform.dashboard_embeds SET is_active = false WHERE id = $1 AND dashboard_id = $2 AND tenant_id = $3',
      [embedId, dashboardId, tenantId]
    );
  });
}

// ─── Public share ────────────────────────────────────────────────────────────

export async function makePublic(
  dashboardId: string,
  tenantId: string
): Promise<{ public_token: string }> {
  const token = generateToken(16); // 32 hex chars
  return withClient(async (client) => {
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
    const result = await client.query(
      `UPDATE platform.dashboards
       SET is_public = true, public_token = $1, updated_at = now()
       WHERE id = $2 AND tenant_id = $3
       RETURNING public_token`,
      [token, dashboardId, tenantId]
    );
    if (result.rows.length === 0) {
      throw new AppError(404, 'DASHBOARD_NOT_FOUND', 'Dashboard not found');
    }
    return { public_token: result.rows[0].public_token };
  });
}

export async function makePrivate(
  dashboardId: string,
  tenantId: string
): Promise<void> {
  await withClient(async (client) => {
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
    const result = await client.query(
      `UPDATE platform.dashboards
       SET is_public = false, public_token = NULL, updated_at = now()
       WHERE id = $1 AND tenant_id = $2
       RETURNING id`,
      [dashboardId, tenantId]
    );
    if (result.rows.length === 0) {
      throw new AppError(404, 'DASHBOARD_NOT_FOUND', 'Dashboard not found');
    }
  });
}

export async function getPublicDashboard(
  publicToken: string
): Promise<Dashboard> {
  return withClient(async (client) => {
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
    const result = await client.query(
      `SELECT * FROM platform.dashboards
       WHERE public_token = $1 AND is_public = true AND status = 'active'`,
      [publicToken]
    );
    if (result.rows.length === 0) {
      throw new AppError(404, 'NOT_FOUND', 'Dashboard not found or no longer public');
    }
    return result.rows[0];
  });
}

export async function renderPublicDashboard(
  publicToken: string
): Promise<{ html: string; css: string; js: string; name: string }> {
  const dashboard = await getPublicDashboard(publicToken);

  if (!dashboard.fetch_url) {
    return {
      html: dashboard.view_html || '',
      css: dashboard.view_css || '',
      js: dashboard.view_js || '',
      name: dashboard.name,
    };
  }

  // Proxy fetch for dynamic dashboards
  const headers: Record<string, string> = typeof dashboard.fetch_headers === 'string'
    ? JSON.parse(dashboard.fetch_headers) : (dashboard.fetch_headers || {});
  const fetchOpts: RequestInit = {
    method: dashboard.fetch_method || 'GET',
    headers: { 'Content-Type': 'application/json', ...headers },
  };
  if (dashboard.fetch_body && dashboard.fetch_method !== 'GET') {
    fetchOpts.body = typeof dashboard.fetch_body === 'string'
      ? dashboard.fetch_body : JSON.stringify(dashboard.fetch_body);
  }
  fetchOpts.signal = AbortSignal.timeout(90_000);

  // Append query params if configured
  let fetchUrl = dashboard.fetch_url;
  if ((dashboard as any).fetch_query_params) {
    const qp = typeof (dashboard as any).fetch_query_params === 'string'
      ? JSON.parse((dashboard as any).fetch_query_params) : (dashboard as any).fetch_query_params;
    if (qp && typeof qp === 'object' && Object.keys(qp).length > 0) {
      const url = new URL(fetchUrl);
      for (const [k, v] of Object.entries(qp)) {
        url.searchParams.set(k, String(v));
      }
      fetchUrl = url.toString();
    }
  }

  // Retry upstream fetch up to 3 times
  const MAX_ATTEMPTS = 3;
  const RETRY_DELAYS = [1500, 3000];
  let lastError = '';

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const attemptOpts: RequestInit = {
        method: fetchOpts.method,
        headers: fetchOpts.headers,
        body: fetchOpts.body,
        signal: AbortSignal.timeout(30_000),
      };
      const response = await fetch(fetchUrl, attemptOpts);
      if (!response.ok) {
        lastError = `Connection returned ${response.status}`;
        if (attempt < MAX_ATTEMPTS) {
          await new Promise(r => setTimeout(r, RETRY_DELAYS[attempt - 1]));
          continue;
        }
        break;
      }

      const contentType = response.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        const data = await response.json() as Record<string, string>;
        return { html: data.html || '', css: data.css || '', js: data.js || '', name: dashboard.name };
      }
      const html = await response.text();
      return { html, css: '', js: '', name: dashboard.name };
    } catch (fetchErr) {
      lastError = 'Connection unreachable';
      if (attempt < MAX_ATTEMPTS) {
        await new Promise(r => setTimeout(r, RETRY_DELAYS[attempt - 1]));
        continue;
      }
    }
  }

  // All attempts failed — fall back to cached content
  if (dashboard.view_html) {
    return {
      html: dashboard.view_html,
      css: dashboard.view_css || '',
      js: dashboard.view_js || '',
      name: dashboard.name,
    };
  }

  throw new AppError(502, 'UPSTREAM_ERROR', lastError || 'Connection failed');
}

// ─── View tracking ──────────────────────────────────────────────────────────

export async function recordView(
  dashboardId: string,
  userId: string
): Promise<void> {
  await withClient(async (client) => {
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
    await client.query(
      `INSERT INTO platform.dashboard_views (dashboard_id, user_id) VALUES ($1, $2)`,
      [dashboardId, userId]
    );
  });
}

export async function getViewCount(dashboardId: string): Promise<number> {
  return withClient(async (client) => {
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
    const result = await client.query(
      `SELECT COUNT(*)::int as count FROM platform.dashboard_views WHERE dashboard_id = $1`,
      [dashboardId]
    );
    return result.rows[0].count;
  });
}

export async function getViewHistory(
  dashboardId: string,
  limit: number = 50
): Promise<Array<{ user_id: string; email: string; name: string; viewed_at: string }>> {
  return withClient(async (client) => {
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
    const result = await client.query(
      `SELECT dv.user_id, u.email, u.name, dv.viewed_at
       FROM platform.dashboard_views dv
       JOIN platform.users u ON u.id = dv.user_id
       WHERE dv.dashboard_id = $1
       ORDER BY dv.viewed_at DESC
       LIMIT $2`,
      [dashboardId, limit]
    );
    return result.rows;
  });
}

// ─── Comments ───────────────────────────────────────────────────────────────

export async function listComments(
  dashboardId: string,
  limit: number = 10,
  offset: number = 0
): Promise<{ comments: any[]; total: number }> {
  return withClient(async (client) => {
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
    const countResult = await client.query(
      `SELECT COUNT(*)::int as total FROM platform.dashboard_comments WHERE dashboard_id = $1`,
      [dashboardId]
    );
    const result = await client.query(
      `SELECT c.*, u.name AS author_name, u.email AS author_email
       FROM platform.dashboard_comments c
       LEFT JOIN platform.users u ON u.id = c.author_id
       WHERE c.dashboard_id = $1
       ORDER BY c.created_at DESC
       LIMIT $2 OFFSET $3`,
      [dashboardId, limit, offset]
    );
    return { comments: result.rows, total: countResult.rows[0].total };
  });
}

export async function createComment(
  dashboardId: string,
  authorId: string,
  content: string
): Promise<any> {
  return withClient(async (client) => {
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
    const result = await client.query(
      `INSERT INTO platform.dashboard_comments (dashboard_id, author_id, content)
       VALUES ($1, $2, $3) RETURNING *`,
      [dashboardId, authorId, content]
    );
    return result.rows[0];
  });
}

export async function deleteComment(commentId: string): Promise<void> {
  await withClient(async (client) => {
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
    await client.query(`DELETE FROM platform.dashboard_comments WHERE id = $1`, [commentId]);
  });
}

// ─── Connector sources ──────────────────────────────────────────────────────

export async function listDashboardConnectors(
  dashboardId: string
): Promise<any[]> {
  return withClient(async (client) => {
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
    const result = await client.query(
      `SELECT ds.id, ds.source_key, ds.table_name, ds.refresh_cadence,
              c.id as connection_id, c.name as connection_name, c.source_type, c.status as connection_status
       FROM platform.dashboard_sources ds
       LEFT JOIN platform.connections c ON c.id = ds.connection_id
       WHERE ds.dashboard_id = $1
       ORDER BY ds.created_at`,
      [dashboardId]
    );
    return result.rows;
  });
}

export async function attachConnector(
  dashboardId: string,
  connectionId: string,
  sourceKey: string,
  tableName: string,
  tenantId: string,
  refreshCadence: string = 'hourly'
): Promise<any> {
  return withClient(async (client) => {
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
    const result = await client.query(
      `INSERT INTO platform.dashboard_sources (dashboard_id, tenant_id, connection_id, source_key, table_name, refresh_cadence)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [dashboardId, tenantId, connectionId, sourceKey, tableName, refreshCadence]
    );
    return result.rows[0];
  });
}

export async function detachConnector(sourceId: string): Promise<void> {
  await withClient(async (client) => {
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
    await client.query(`DELETE FROM platform.dashboard_sources WHERE id = $1`, [sourceId]);
  });
}

// ─── Image ──────────────────────────────────────────────────────────────────

export async function updateTileImage(
  dashboardId: string,
  imageUrl: string
): Promise<void> {
  await withClient(async (client) => {
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
    await client.query(
      `UPDATE platform.dashboards SET tile_image_url = $1, updated_at = now() WHERE id = $2`,
      [imageUrl, dashboardId]
    );
  });
}

// ─── Embed ──────────────────────────────────────────────────────────────────

export async function getEmbedDashboard(
  embedToken: string
): Promise<Dashboard> {
  return withClient(async (client) => {
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
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
