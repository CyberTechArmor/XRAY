import { withClient, withTransaction } from '../db/connection';
import { generateToken, hashToken } from '../lib/crypto';
import { decryptSecret } from '../lib/encrypted-column';
import { mintBridgeJwt } from '../lib/n8n-bridge';
import { mintPipelineJwt, isPipelineJwtConfigured } from '../lib/pipeline-jwt';
import * as auditService from './audit.service';
import * as integrationService from './integration.service';
import { AppError } from '../middleware/error-handler';

// Internal-only. Fetches the raw `enc:v1:` ciphertext of a dashboard's
// bridge signing secret. Never call this from an API handler; only the
// three render call sites (authed / public-share / admin-preview) need
// the secret, and they pass it straight into mintBridgeJwt.
export async function fetchBridgeSecretCiphertext(dashboardId: string): Promise<string | null> {
  return withClient(async (client) => {
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
    const result = await client.query(
      'SELECT bridge_secret FROM platform.dashboards WHERE id = $1',
      [dashboardId]
    );
    if (result.rows.length === 0) return null;
    return (result.rows[0].bridge_secret as string | null) || null;
  });
}

function decryptDashboardRow<T extends { id: string; bridge_secret?: unknown }>(row: T): T {
  // bridge_secret ciphertext (or plaintext) must never reach the API
  // response. Surface a boolean so the admin UI can show "secret set"
  // without exposing the value. Public share / render responses don't
  // include the dashboard row at all (they return rendered HTML), but
  // this keeps the contract uniform across every call site that runs
  // through the decryptor.
  if (row && 'bridge_secret' in (row as object)) {
    (row as Record<string, unknown>).bridge_secret_set =
      typeof row.bridge_secret === 'string' && row.bridge_secret !== '';
    delete (row as Record<string, unknown>).bridge_secret;
  }
  return row;
}

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
  fetch_body: unknown;
  tile_image_url: string | null;
  last_viewed_at: string | null;
  is_public: boolean;
  public_token: string | null;
  status: string;
  scope: 'tenant' | 'global';
  template_id: string | null;
  integration: string | null;
  params: Record<string, unknown> | null;
  // bridge_secret is stored on the row encrypted under `enc:v1:`.
  // The read path decrypts on demand (see renderPublicDashboard); we
  // deliberately do NOT decrypt it in the listing/detail decryptor
  // because the API response for GET /dashboards/:id must never leak
  // the plaintext secret to the client.
  bridge_secret: string | null;
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

    // Step 4b (revised after operator feedback): Global dashboards
    // are gated on the rendering tenant having an active connection
    // to d.integration. The earlier "show every Global to every
    // tenant + prompt Connect on click" model produced a 12-dashboard
    // clutter when a catalog had 4 Globals each for 3 FSM services
    // (HCP / Jobber / ServiceTitan) and a tenant only uses one. The
    // tenant-facing "My Integrations" strip on the dashboard list is
    // the proactive connect surface; once a tenant connects an
    // integration, its Globals materialize in the list. Custom
    // Globals (no integration → no render-time gate) still require
    // an explicit grant row.
    const globalEligibleWhere = `
      d.scope = 'global' AND d.status = 'active' AND (
        -- Integration-set Globals: tenant has an active connection
        EXISTS (
          SELECT 1 FROM platform.integrations i2
           JOIN platform.connections c2
             ON c2.integration_id = i2.id
            AND c2.tenant_id = $1
            AND c2.status = 'active'
           WHERE i2.slug = d.integration
        )
        -- Custom Globals (no integration): opt-in via grant row
        OR (
          (d.integration IS NULL OR d.integration = '')
          AND EXISTS (
            SELECT 1 FROM platform.dashboard_tenant_grants g
             WHERE g.dashboard_id = d.id AND g.tenant_id = $1
          )
        )
      )`;

    // Platform admin: see ALL dashboards across all tenants, including
    // every Global (regardless of rendering-tenant eligibility).
    if (isPlatformAdmin) {
      const result = await client.query(
        `SELECT d.*, t.name as tenant_name, ${viewCountSub}, ${connectorsSub}
         FROM platform.dashboards d
         LEFT JOIN platform.tenants t ON t.id = d.tenant_id
         ORDER BY d.updated_at DESC`
      );
      return result.rows.map(decryptDashboardRow);
    }

    await client.query(`SELECT set_config('app.current_tenant', $1, true)`, [tenantId]);

    if (hasManagePermission) {
      const result = await client.query(
        `SELECT d.*, ${viewCountSub}, ${connectorsSub}
         FROM platform.dashboards d
         WHERE (d.scope = 'tenant' AND d.tenant_id = $1)
            OR (${globalEligibleWhere})
         ORDER BY d.updated_at DESC`,
        [tenantId]
      );
      return result.rows.map(decryptDashboardRow);
    }

    // Regular users: only dashboards they have explicit access to,
    // plus eligible Globals (eligibility is a tenant property, so a
    // manage grant isn't required).
    const result = await client.query(
      `SELECT d.*, ${viewCountSub}, ${connectorsSub}
       FROM platform.dashboards d
       LEFT JOIN platform.dashboard_access da
         ON da.dashboard_id = d.id AND da.user_id = $2
       WHERE d.status IN ('active', 'disabled')
         AND (
           (d.scope = 'tenant' AND d.tenant_id = $1 AND da.user_id IS NOT NULL)
           OR (${globalEligibleWhere})
         )
       ORDER BY d.updated_at DESC`,
      [tenantId, userId]
    );
    return result.rows.map(decryptDashboardRow);
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
    return decryptDashboardRow(result.rows[0]);
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
    return decryptDashboardRow(result.rows[0]);
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
    return decryptDashboardRow(result.rows[0]);
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
  tenantId: string,
  actingUserId?: string | null
): Promise<{ public_token: string; is_public: boolean }> {
  return withClient(async (client) => {
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
    // Resolve dashboard scope up front. Globals use dashboard_shares;
    // Tenant rows keep using dashboards.public_token for backwards
    // compatibility with existing share links.
    const scopeRow = await client.query(
      'SELECT scope, tenant_id FROM platform.dashboards WHERE id = $1',
      [dashboardId]
    );
    if (scopeRow.rows.length === 0) {
      throw new AppError(404, 'DASHBOARD_NOT_FOUND', 'Dashboard not found');
    }
    const scope: 'tenant' | 'global' = scopeRow.rows[0].scope;

    if (scope === 'global') {
      // Per-(dashboard, sharing-tenant) row. The sharing tenant's own
      // credentials drive the public render (resolveAccessTokenForRender
      // runs with this tenant_id), so each tenant's share is isolated.
      const existing = await client.query(
        `SELECT public_token, is_public FROM platform.dashboard_shares
          WHERE dashboard_id = $1 AND tenant_id = $2`,
        [dashboardId, tenantId]
      );
      if (existing.rows.length > 0) {
        return {
          public_token: existing.rows[0].public_token,
          is_public: existing.rows[0].is_public,
        };
      }
      const token = generateToken(16);
      const inserted = await client.query(
        `INSERT INTO platform.dashboard_shares
           (dashboard_id, tenant_id, public_token, is_public, created_by)
         VALUES ($1, $2, $3, false, $4)
         RETURNING public_token, is_public`,
        [dashboardId, tenantId, token, actingUserId || null]
      );
      return {
        public_token: inserted.rows[0].public_token,
        is_public: inserted.rows[0].is_public,
      };
    }

    // Tenant-scoped: original single-token-per-row path unchanged.
    const existing = await client.query(
      'SELECT public_token, is_public FROM platform.dashboards WHERE id = $1 AND tenant_id = $2 AND public_token IS NOT NULL',
      [dashboardId, tenantId]
    );
    if (existing.rows.length > 0 && existing.rows[0].public_token) {
      return { public_token: existing.rows[0].public_token, is_public: existing.rows[0].is_public };
    }
    const token = generateToken(16); // 32 hex chars
    const result = await client.query(
      `UPDATE platform.dashboards
       SET is_public = false, public_token = $1, updated_at = now()
       WHERE id = $2 AND tenant_id = $3
       RETURNING public_token, is_public`,
      [token, dashboardId, tenantId]
    );
    if (result.rows.length === 0) {
      throw new AppError(404, 'DASHBOARD_NOT_FOUND', 'Dashboard not found');
    }
    return { public_token: result.rows[0].public_token, is_public: result.rows[0].is_public };
  });
}

export async function makePrivate(
  dashboardId: string,
  tenantId: string
): Promise<void> {
  await withClient(async (client) => {
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
    const scopeRow = await client.query(
      'SELECT scope FROM platform.dashboards WHERE id = $1',
      [dashboardId]
    );
    if (scopeRow.rows.length === 0) {
      throw new AppError(404, 'DASHBOARD_NOT_FOUND', 'Dashboard not found');
    }
    const scope: 'tenant' | 'global' = scopeRow.rows[0].scope;
    if (scope === 'global') {
      // Revoke only the SHARING tenant's share link. Other tenants'
      // shares of the same Global stay intact.
      const del = await client.query(
        `DELETE FROM platform.dashboard_shares
          WHERE dashboard_id = $1 AND tenant_id = $2
         RETURNING dashboard_id`,
        [dashboardId, tenantId]
      );
      if (del.rows.length === 0) {
        throw new AppError(404, 'DASHBOARD_NOT_FOUND', 'No share link to revoke for this tenant');
      }
      return;
    }
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
): Promise<Dashboard & { sharing_tenant_id?: string }> {
  return withClient(async (client) => {
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
    // Tenant-scoped dashboards: single-token-per-row on platform.dashboards.
    // Globals: per-(dashboard, tenant) rows in platform.dashboard_shares —
    // each sharing tenant owns their own token, and the render binds to
    // that tenant's credentials. Try tenant lookup first (hot path;
    // covers every pre-4b share link), then fall back to the Global
    // share table.
    const tenantRow = await client.query(
      `SELECT * FROM platform.dashboards
       WHERE public_token = $1 AND status = 'active' AND scope = 'tenant'`,
      [publicToken]
    );
    if (tenantRow.rows.length > 0) {
      return decryptDashboardRow(tenantRow.rows[0]);
    }
    const globalRow = await client.query(
      `SELECT d.*, s.tenant_id AS sharing_tenant_id, s.is_public AS share_is_public
         FROM platform.dashboard_shares s
         JOIN platform.dashboards d ON d.id = s.dashboard_id
        WHERE s.public_token = $1 AND d.status = 'active' AND d.scope = 'global'`,
      [publicToken]
    );
    if (globalRow.rows.length > 0) {
      const row = globalRow.rows[0];
      const decrypted = decryptDashboardRow(row) as Dashboard & {
        sharing_tenant_id: string;
        share_is_public?: boolean;
      };
      // Surface the sharing tenant to callers that need it (renderPublicDashboard).
      decrypted.sharing_tenant_id = row.sharing_tenant_id;
      // Mirror is_public from the share row so the app-visible flag
      // reflects this specific tenant's choice, not a stale value on
      // the dashboards row (which stays false for Globals).
      decrypted.is_public = !!row.share_is_public;
      return decrypted;
    }
    throw new AppError(404, 'NOT_FOUND', 'Dashboard not found or share link has been revoked');
  });
}

// Tenant labels loaded alongside a public-share render. Kept separate
// from getPublicDashboard so that function's other callers (share.routes
// issuing a plain GET) don't start joining for no reason.
async function fetchTenantLabels(tenantId: string): Promise<{
  slug: string | null;
  name: string | null;
  status: string | null;
  warehouse_host: string | null;
} | null> {
  return withClient(async (client) => {
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
    const r = await client.query(
      'SELECT slug, name, status, warehouse_host FROM platform.tenants WHERE id = $1',
      [tenantId]
    );
    return r.rows[0] || null;
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

  // Proxy fetch for dynamic dashboards through the JWT bridge. The
  // legacy fetch_headers path was dropped in step 3 (migration 020);
  // the share context has no user, so user_* claims are absent. A row
  // with a fetch_url but no integration is a config error post-cutover
  // — surface as 500.
  if (!dashboard.integration) {
    throw new AppError(
      500,
      'BRIDGE_INTEGRATION_MISSING',
      'This dashboard has a fetch_url but no integration configured.'
    );
  }
  // decryptDashboardRow redacts bridge_secret from the row — fetch
  // the ciphertext via the internal helper to keep the "never leak"
  // invariant honest.
  const bridgeCipher = await fetchBridgeSecretCiphertext(dashboard.id);
  const bridgeSecret = decryptSecret(
    bridgeCipher,
    `dashboards:bridge_secret:${dashboard.id}`
  );
  if (!bridgeSecret) {
    throw new AppError(
      500,
      'BRIDGE_SECRET_MISSING',
      'This dashboard has an integration but no bridge signing secret.'
    );
  }
  // For Globals, the rendering tenant is the SHARING tenant (whoever
  // generated this particular share link), not the dashboard-author
  // tenant (which is NULL on a Global). Tenant-scoped dashboards keep
  // using dashboard.tenant_id.
  const sharingTenantId = (dashboard as Dashboard & { sharing_tenant_id?: string })
    .sharing_tenant_id;
  const renderingTenantId: string = sharingTenantId || dashboard.tenant_id;
  const tenantLabels = await fetchTenantLabels(renderingTenantId);

  // Resolve the sharing tenant's OAuth / API-key credential. The step-4
  // resolver handles OAuth + API-key and reports needs_reconnect /
  // not_connected / unknown_integration cleanly. For public shares we
  // previously skipped the lookup (share had no end-user + no tenant
  // context to pick); 4b shares carry a definite sharing tenant, so
  // we CAN and SHOULD resolve — otherwise the shared render renders
  // against n8n without a tenant credential and silently returns
  // empty data.
  let accessToken: string | null = null;
  let authMethod: 'oauth' | 'api_key' | null = null;
  if (dashboard.integration) {
    const tokenResult = await integrationService.resolveAccessTokenForRender(
      renderingTenantId,
      dashboard.integration
    );
    if (tokenResult.kind === 'ready') {
      accessToken = tokenResult.accessToken;
      authMethod = tokenResult.authMethod;
    } else if (tokenResult.kind === 'needs_reconnect') {
      // A share link whose tenant's credentials have since expired
      // (refresh failures hit threshold → status='error'). Without a
      // UI to prompt, the best we can do is surface a clear 409 so
      // the share page can show "This link requires the owner to
      // reconnect their integration" rather than rendering empty.
      throw new AppError(
        409,
        'OAUTH_NOT_CONNECTED',
        'The tenant that created this share link needs to reconnect their integration.'
      );
    }
    // not_connected / unknown_integration: degrade gracefully —
    // render proceeds with access_token absent, same as pre-4b.
  }

  // public_share intentionally has no end-user context. access_token +
  // auth_method ARE populated when the sharing tenant has an active
  // connection (see above); the bridge JWT still carries tenant/dashboard
  // labels + params so n8n can route.
  const minted = mintBridgeJwt({
    tenantId: renderingTenantId,
    tenantSlug: tenantLabels?.slug ?? null,
    tenantName: tenantLabels?.name ?? null,
    tenantStatus: tenantLabels?.status ?? null,
    warehouseHost: tenantLabels?.warehouse_host ?? null,
    dashboardId: dashboard.id,
    dashboardName: dashboard.name,
    dashboardStatus: dashboard.status,
    isPublic: dashboard.is_public,
    // user_* intentionally absent on public_share — no end-user context.
    templateId: dashboard.template_id || null,
    integration: dashboard.integration,
    params: (dashboard.params as Record<string, unknown>) || {},
    via: 'public_share',
    secret: bridgeSecret,
    accessToken,
    authMethod,
  });
  const headers: Record<string, string> = { Authorization: `Bearer ${minted.jwt}` };

  // Pipeline JWT still minted on public_share — gives a future
  // pipeline.access_audit row with via='public_share' and user_id=null,
  // matching the model committed in pipeline-hardening-notes.md.
  let pipelineJti: string | null = null;
  if (isPipelineJwtConfigured()) {
    const pipelineMinted = mintPipelineJwt({
      tenantId: renderingTenantId,
      via: 'public_share',
    });
    pipelineJti = pipelineMinted.jti;
    headers['X-XRay-Pipeline-Token'] = `Bearer ${pipelineMinted.jwt}`;
  }

  auditService.log({
    tenantId: renderingTenantId,
    action: 'dashboard.bridge_mint',
    resourceType: 'dashboard',
    resourceId: dashboard.id,
    metadata: {
      jti: minted.jti,
      pipeline_jti: pipelineJti,
      integration: dashboard.integration,
      template_id: dashboard.template_id || null,
      via: 'public_share',
      auth_method: authMethod,
      access_token_present: !!accessToken,
      public_token_prefix: publicToken.slice(0, 8),
      scope: dashboard.scope,
      sharing_tenant_id: sharingTenantId || null,
    },
  });
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

    return decryptDashboardRow(dashResult.rows[0]);
  });
}
