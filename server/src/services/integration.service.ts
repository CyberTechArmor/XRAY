import { withClient } from '../db/connection';
import { AppError } from '../middleware/error-handler';
import { encryptSecret, decryptSecret } from '../lib/encrypted-column';
import * as auditService from './audit.service';

// CRUD for platform.integrations — the platform-admin-managed catalog of
// external systems XRay can OAuth into or connect via API key.
//
// Admin UI talks to this service through /api/admin/oauth-providers
// (legacy-friendly URL, service uses the new table name). Tenant-facing
// code uses listActiveForTenant() which filters to status='active'.
//
// Secret handling follows the step-2 contract: server responses redact
// client_secret and surface client_secret_set: boolean. Callers never get
// the plaintext back. Helpers below read raw ciphertext for internal use
// (the OAuth authorize/callback routes need the decrypted client_secret
// to exchange with the provider).

export type AuthMethod = 'oauth' | 'api_key';

export interface IntegrationRow {
  id: string;
  slug: string;
  display_name: string;
  icon_url: string | null;
  status: 'active' | 'disabled' | 'pending';
  supports_oauth: boolean;
  supports_api_key: boolean;
  auth_url: string | null;
  token_url: string | null;
  client_id: string | null;
  // Never returned to the client. See redactIntegrationRow().
  client_secret?: string | null;
  client_secret_set?: boolean;
  scopes: string | null;
  extra_authorize_params: Record<string, unknown>;
  api_key_header_name: string | null;
  api_key_instructions: string | null;
  created_at: string;
  updated_at: string;
}

function redactIntegrationRow<T extends { id: string; client_secret?: unknown }>(
  row: T
): T {
  if ('client_secret' in (row as object)) {
    (row as Record<string, unknown>).client_secret_set =
      typeof row.client_secret === 'string' && row.client_secret !== '';
    delete (row as Record<string, unknown>).client_secret;
  }
  return row;
}

// Internal-only: returns the row with the raw (still-encrypted) client_secret
// attached. Used by the authorize/callback routes which need to decrypt it
// for the token exchange.
export async function getIntegrationWithSecret(
  slug: string
): Promise<IntegrationRow | null> {
  return withClient(async (client) => {
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
    const result = await client.query(
      'SELECT * FROM platform.integrations WHERE slug = $1',
      [slug]
    );
    return (result.rows[0] as IntegrationRow) || null;
  });
}

// Decrypts client_secret for internal callers. Separate function so the
// single "I need the plaintext" code path is obvious in greps and
// reviewers can confirm it's only called from the OAuth routes.
export function decryptIntegrationClientSecret(row: IntegrationRow): string {
  return (
    decryptSecret(
      (row.client_secret as string | null | undefined) ?? null,
      `integrations:client_secret:${row.id}`
    ) || ''
  );
}

// ─── Admin CRUD ─────────────────────────────────────────────────────────────

export async function listAllIntegrations(): Promise<IntegrationRow[]> {
  return withClient(async (client) => {
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
    const result = await client.query(
      `SELECT id, slug, display_name, icon_url, status,
              supports_oauth, supports_api_key,
              auth_url, token_url, client_id, client_secret,
              scopes, extra_authorize_params,
              api_key_header_name, api_key_instructions,
              created_at, updated_at
         FROM platform.integrations
         ORDER BY display_name ASC`
    );
    return result.rows.map(redactIntegrationRow);
  });
}

export async function getIntegration(id: string): Promise<IntegrationRow> {
  return withClient(async (client) => {
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
    const result = await client.query(
      'SELECT * FROM platform.integrations WHERE id = $1',
      [id]
    );
    if (result.rows.length === 0) {
      throw new AppError(404, 'NOT_FOUND', 'Integration not found');
    }
    return redactIntegrationRow(result.rows[0]);
  });
}

export interface IntegrationCreateInput {
  slug: string;
  displayName: string;
  iconUrl?: string;
  status?: 'active' | 'disabled' | 'pending';
  supportsOauth: boolean;
  supportsApiKey: boolean;
  authUrl?: string;
  tokenUrl?: string;
  clientId?: string;
  clientSecret?: string;
  scopes?: string;
  extraAuthorizeParams?: Record<string, unknown>;
  apiKeyHeaderName?: string;
  apiKeyInstructions?: string;
}

export async function createIntegration(
  input: IntegrationCreateInput,
  actingUserId: string
): Promise<IntegrationRow> {
  validateIntegrationConfig(input);
  return withClient(async (client) => {
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
    const result = await client.query(
      `INSERT INTO platform.integrations
         (slug, display_name, icon_url, status, supports_oauth, supports_api_key,
          auth_url, token_url, client_id, client_secret, scopes, extra_authorize_params,
          api_key_header_name, api_key_instructions)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       RETURNING *`,
      [
        input.slug,
        input.displayName,
        input.iconUrl || null,
        input.status || 'pending',
        input.supportsOauth,
        input.supportsApiKey,
        input.authUrl || null,
        input.tokenUrl || null,
        input.clientId || null,
        encryptSecret(input.clientSecret || null),
        input.scopes || null,
        input.extraAuthorizeParams || {},
        input.apiKeyHeaderName || null,
        input.apiKeyInstructions || null,
      ]
    );
    const row = result.rows[0];
    auditService.log({
      tenantId: '00000000-0000-0000-0000-000000000000',
      userId: actingUserId,
      action: 'integration.create',
      resourceType: 'integration',
      resourceId: row.id,
      metadata: { slug: input.slug, display_name: input.displayName },
    });
    return redactIntegrationRow(row);
  });
}

export async function updateIntegration(
  id: string,
  updates: Partial<IntegrationCreateInput>,
  actingUserId: string
): Promise<IntegrationRow> {
  const existing = await getIntegration(id);
  // Merge + validate; the full post-update state must still satisfy the
  // "at least one auth method supported + required fields present for
  // each enabled method" contract.
  const merged: IntegrationCreateInput = {
    slug: updates.slug ?? existing.slug,
    displayName: updates.displayName ?? existing.display_name,
    iconUrl: updates.iconUrl ?? existing.icon_url ?? undefined,
    status: (updates.status as any) ?? existing.status,
    supportsOauth:
      updates.supportsOauth !== undefined
        ? updates.supportsOauth
        : existing.supports_oauth,
    supportsApiKey:
      updates.supportsApiKey !== undefined
        ? updates.supportsApiKey
        : existing.supports_api_key,
    authUrl: updates.authUrl ?? existing.auth_url ?? undefined,
    tokenUrl: updates.tokenUrl ?? existing.token_url ?? undefined,
    clientId: updates.clientId ?? existing.client_id ?? undefined,
    clientSecret: updates.clientSecret, // undefined = keep existing; empty string = clear
    scopes: updates.scopes ?? existing.scopes ?? undefined,
    extraAuthorizeParams:
      updates.extraAuthorizeParams ?? existing.extra_authorize_params,
    apiKeyHeaderName:
      updates.apiKeyHeaderName ?? existing.api_key_header_name ?? undefined,
    apiKeyInstructions:
      updates.apiKeyInstructions ?? existing.api_key_instructions ?? undefined,
  };
  validateIntegrationConfig(merged);

  return withClient(async (client) => {
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
    const fields: string[] = [];
    const values: unknown[] = [];
    let idx = 1;
    const addField = (column: string, value: unknown, encrypt = false) => {
      fields.push(`${column} = $${idx}`);
      values.push(encrypt ? encryptSecret(value as string | null | undefined) : value);
      idx++;
    };

    if (updates.slug !== undefined) addField('slug', updates.slug);
    if (updates.displayName !== undefined) addField('display_name', updates.displayName);
    if (updates.iconUrl !== undefined) addField('icon_url', updates.iconUrl || null);
    if (updates.status !== undefined) addField('status', updates.status);
    if (updates.supportsOauth !== undefined)
      addField('supports_oauth', updates.supportsOauth);
    if (updates.supportsApiKey !== undefined)
      addField('supports_api_key', updates.supportsApiKey);
    if (updates.authUrl !== undefined) addField('auth_url', updates.authUrl || null);
    if (updates.tokenUrl !== undefined) addField('token_url', updates.tokenUrl || null);
    if (updates.clientId !== undefined) addField('client_id', updates.clientId || null);
    if (updates.clientSecret !== undefined) {
      // Explicit empty string clears the secret; undefined (the default
      // above) leaves it untouched. Matches the step-2 admin UI contract.
      addField('client_secret', updates.clientSecret || null, true);
    }
    if (updates.scopes !== undefined) addField('scopes', updates.scopes || null);
    if (updates.extraAuthorizeParams !== undefined)
      addField('extra_authorize_params', updates.extraAuthorizeParams);
    if (updates.apiKeyHeaderName !== undefined)
      addField('api_key_header_name', updates.apiKeyHeaderName || null);
    if (updates.apiKeyInstructions !== undefined)
      addField('api_key_instructions', updates.apiKeyInstructions || null);

    if (fields.length === 0) {
      // No-op update — return current row rather than 400. Admin UI
      // submits full forms, so this handles the "saved without changes"
      // case gracefully.
      return getIntegration(id);
    }

    fields.push('updated_at = now()');
    values.push(id);
    const result = await client.query(
      `UPDATE platform.integrations SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
      values
    );
    if (result.rows.length === 0) {
      throw new AppError(404, 'NOT_FOUND', 'Integration not found');
    }
    auditService.log({
      tenantId: '00000000-0000-0000-0000-000000000000',
      userId: actingUserId,
      action: 'integration.update',
      resourceType: 'integration',
      resourceId: id,
      metadata: { fields: Object.keys(updates) },
    });
    return redactIntegrationRow(result.rows[0]);
  });
}

export async function deleteIntegration(
  id: string,
  actingUserId: string
): Promise<void> {
  await withClient(async (client) => {
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
    // Count tenant connections — FK has ON DELETE RESTRICT, but we'd
    // rather surface a clear error than a raw FK violation.
    const connRefs = await client.query(
      'SELECT COUNT(*)::int AS n FROM platform.connections WHERE integration_id = $1',
      [id]
    );
    if (connRefs.rows[0].n > 0) {
      throw new AppError(
        409,
        'INTEGRATION_IN_USE',
        `This integration has ${connRefs.rows[0].n} tenant connection(s). Disable it (status='disabled') or disconnect tenants before deleting.`
      );
    }
    const result = await client.query(
      'DELETE FROM platform.integrations WHERE id = $1 RETURNING slug',
      [id]
    );
    if (result.rows.length === 0) {
      throw new AppError(404, 'NOT_FOUND', 'Integration not found');
    }
    auditService.log({
      tenantId: '00000000-0000-0000-0000-000000000000',
      userId: actingUserId,
      action: 'integration.delete',
      resourceType: 'integration',
      resourceId: id,
      metadata: { slug: result.rows[0].slug },
    });
  });
}

// ─── Tenant-facing reads ────────────────────────────────────────────────────

// Lists active integrations for use in the dashboard builder dropdown.
// Filters to status='active' (pending and disabled are admin-only).
// The row carries the tenant's current connection state (auth_method,
// has_connection) so the UI can render pills without a second query.
export async function listActiveForTenant(tenantId: string) {
  return withClient(async (client) => {
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
    const result = await client.query(
      `SELECT i.id, i.slug, i.display_name, i.icon_url, i.status,
              i.supports_oauth, i.supports_api_key,
              i.api_key_instructions,
              c.id AS connection_id,
              c.auth_method AS connection_auth_method,
              c.status AS connection_status,
              c.oauth_access_token_expires_at,
              c.oauth_refresh_failed_count,
              (c.id IS NOT NULL) AS has_connection
         FROM platform.integrations i
         LEFT JOIN platform.connections c
           ON c.integration_id = i.id AND c.tenant_id = $1
        WHERE i.status = 'active'
        ORDER BY i.display_name ASC`,
      [tenantId]
    );
    return result.rows;
  });
}

// ─── Render-path token resolver ─────────────────────────────────────────────

export type RenderTokenResult =
  | {
      // Tenant has an OAuth or API-key connection for this integration
      // and the credential is ready to use.
      kind: 'ready';
      accessToken: string;
      authMethod: AuthMethod;
    }
  | {
      // No matching connection row at all (tenant hasn't connected to
      // this integration yet), OR the row exists but has no credential
      // stored. Caller treats as "OAuth not needed / not connected" —
      // for non-public paths this becomes a 409 OAUTH_NOT_CONNECTED
      // with the connect modal in the UI; for public_share it just
      // leaves access_token absent on the bridge JWT.
      kind: 'not_connected';
    }
  | {
      // Connection exists and has a credential, but status='error' or
      // OAuth token has blown past the safety window.
      // Caller treats identically to 'not_connected' but with a
      // different error code so the UI can say "Needs reconnect" vs
      // "Connect to continue."
      kind: 'needs_reconnect';
      reason: string;
    }
  | {
      // Dashboard's integration slug has no matching row in
      // platform.integrations (admin deleted the row, or the slug was
      // typed in before step 4). Render degrades gracefully — caller
      // leaves access_token absent and proceeds. Logged once.
      kind: 'unknown_integration';
    };

const warnedUnknownIntegration = new Set<string>();

export async function resolveAccessTokenForRender(
  tenantId: string,
  integrationSlug: string | null
): Promise<RenderTokenResult> {
  if (!integrationSlug) return { kind: 'not_connected' };
  return withClient(async (client) => {
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
    const result = await client.query(
      `SELECT i.id AS integration_id, i.status AS integration_status,
              c.id AS connection_id,
              c.auth_method, c.status AS connection_status,
              c.api_key, c.oauth_access_token, c.oauth_access_token_expires_at,
              c.oauth_refresh_failed_count
         FROM platform.integrations i
         LEFT JOIN platform.connections c
           ON c.integration_id = i.id AND c.tenant_id = $1
        WHERE i.slug = $2
        LIMIT 1`,
      [tenantId, integrationSlug]
    );
    if (result.rows.length === 0) {
      // Dashboard references a slug that has no integration row. Warn
      // once so config drift is visible, then degrade.
      const key = `${integrationSlug}`;
      if (!warnedUnknownIntegration.has(key)) {
        warnedUnknownIntegration.add(key);
        console.warn(
          `[integration.service] dashboard references unknown integration slug='${integrationSlug}' — treating as non-OAuth`
        );
      }
      return { kind: 'unknown_integration' };
    }
    const row = result.rows[0];
    if (!row.connection_id) return { kind: 'not_connected' };
    if (row.connection_status === 'error') {
      return { kind: 'needs_reconnect', reason: 'connection.status=error' };
    }
    if (row.auth_method === 'api_key') {
      const apiKey = decryptSecret(row.api_key, `connections:api_key:${row.connection_id}`);
      if (!apiKey) return { kind: 'not_connected' };
      return { kind: 'ready', accessToken: apiKey, authMethod: 'api_key' };
    }
    // OAuth path. If the scheduler hasn't yet stored a token, or it's
    // already expired, the render should prompt reconnect rather than
    // succeed with a stale-or-missing value.
    const expiresAt = row.oauth_access_token_expires_at
      ? new Date(row.oauth_access_token_expires_at).getTime()
      : 0;
    if (!row.oauth_access_token || expiresAt <= Date.now()) {
      return { kind: 'needs_reconnect', reason: 'oauth_access_token expired or missing' };
    }
    const oauthAccess = decryptSecret(
      row.oauth_access_token,
      `connections:oauth_access_token:${row.connection_id}`
    );
    if (!oauthAccess) return { kind: 'needs_reconnect', reason: 'decrypt failed' };
    return { kind: 'ready', accessToken: oauthAccess, authMethod: 'oauth' };
  });
}

// ─── Validation ─────────────────────────────────────────────────────────────

// Validates that the input satisfies the cross-field contract:
//   - at least one auth method enabled
//   - when supports_oauth=true, OAuth fields are present
//   - when supports_api_key=true, api_key_header_name is present
// DB CHECKs cover the first condition; this function covers the rest so
// the admin gets a clear error instead of a NOT NULL / nullable-column
// surprise at exchange time.
export function validateIntegrationConfig(input: IntegrationCreateInput): void {
  if (!input.slug || !/^[a-z0-9_-]+$/.test(input.slug)) {
    throw new AppError(400, 'INVALID_SLUG', 'slug must be lowercase alphanumeric with _ or -');
  }
  if (!input.displayName) {
    throw new AppError(400, 'INVALID_DISPLAY_NAME', 'display_name is required');
  }
  if (!input.supportsOauth && !input.supportsApiKey) {
    throw new AppError(
      400,
      'NO_AUTH_METHOD',
      'At least one of supports_oauth or supports_api_key must be enabled'
    );
  }
  if (input.supportsOauth) {
    if (!input.authUrl || !input.tokenUrl || !input.clientId) {
      throw new AppError(
        400,
        'OAUTH_CONFIG_INCOMPLETE',
        'OAuth requires auth_url, token_url, and client_id. client_secret may be left unchanged on update if previously set.'
      );
    }
  }
  if (input.supportsApiKey) {
    if (!input.apiKeyHeaderName) {
      throw new AppError(
        400,
        'API_KEY_CONFIG_INCOMPLETE',
        'API key support requires api_key_header_name (commonly "Authorization")'
      );
    }
  }
}
