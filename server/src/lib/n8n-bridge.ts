import jwt from 'jsonwebtoken';
import { randomUUID, randomBytes } from 'crypto';
import { config } from '../config';

// Short-lived HS256 JWT XRay hands to n8n on every render call.
// Claim set is the contract n8n validates against — see CONTEXT.md for
// how n8n is expected to verify and route.
//
// The signing secret is per-dashboard (migration 019) — NOT a single
// platform-wide env var. The render call sites decrypt the dashboard
// row's `bridge_secret` and pass it in here. This caps the blast radius
// of a leaked secret to a single dashboard/integration.
//
// Naming convention: claims are flat and domain-prefixed
// (`tenant_id`, `dashboard_id`, `user_id`) so n8n workflows can read
// `$json.tenant_slug` etc. without nested traversal. `sub` is kept
// populated with the tenant id so n8n's native JWT Auth node (which
// looks at `sub`) continues to work unchanged.
//
// Absent vs null: unset optional fields are omitted from the payload
// entirely. Keeps n8n-side validation from seeing false-signal nulls.
export type BridgeVia =
  | 'authed_render'
  | 'admin_impersonation'
  | 'public_share'
  | 'admin_preview';

export interface BridgeJwtInput {
  // Required core.
  tenantId: string;
  integration: string;
  secret: string;
  via: BridgeVia;

  // Tenant labels. tenantSlug / tenantName / tenantStatus are always
  // known when the render path loads the dashboard row (join on
  // platform.tenants). warehouseHost is nullable — omitted when null.
  tenantSlug?: string | null;
  tenantName?: string | null;
  tenantStatus?: string | null;
  warehouseHost?: string | null;

  // Dashboard labels. dashboardId / dashboardName / dashboardStatus /
  // isPublic are always known. templateId is nullable.
  dashboardId?: string | null;
  dashboardName?: string | null;
  dashboardStatus?: string | null;
  isPublic?: boolean | null;
  templateId?: string | null;
  params?: Record<string, unknown> | null;

  // User labels. Present on authed_render / admin_preview, absent on
  // public_share (no end-user context in the share path).
  userId?: string | null;
  userEmail?: string | null;
  userName?: string | null;
  userRole?: string | null;
  isPlatformAdmin?: boolean | null;

  // Step-4 (OAuth / API-key). access_token carries whichever credential
  // the tenant has connected with: OAuth access token (refreshed by the
  // scheduler) or a static API key. auth_method tells n8n which flavor
  // it is so workflows can present it with the right header scheme
  // (Bearer vs X-API-Key vs provider-specific). Both are absent on
  // public_share and on dashboards whose integration has no OAuth / API
  // key support configured.
  accessToken?: string | null;
  authMethod?: 'oauth' | 'api_key' | null;
}

export interface BridgeJwtResult {
  jwt: string;
  jti: string;
  expiresAt: number;
}

function setIfPresent<T>(
  payload: Record<string, unknown>,
  key: string,
  value: T | null | undefined
): void {
  // Booleans pass through even when false; strings/ids are omitted when
  // empty string or null. This keeps `is_public: false` visible while
  // dropping unset `template_id`.
  if (value === null || value === undefined) return;
  if (typeof value === 'string' && value === '') return;
  payload[key] = value;
}

export function mintBridgeJwt(input: BridgeJwtInput): BridgeJwtResult {
  if (!input.tenantId) throw new Error('mintBridgeJwt: tenantId is required');
  if (!input.integration) throw new Error('mintBridgeJwt: integration is required');
  if (!input.secret) throw new Error('mintBridgeJwt: secret is required');
  if (!input.via) throw new Error('mintBridgeJwt: via is required');

  const jti = randomUUID();
  const payload: Record<string, unknown> = {
    sub: input.tenantId,
    jti,
    // Tenant identity (explicit, domain-prefixed mirror of sub).
    tenant_id: input.tenantId,
    // Dashboard/integration routing.
    integration: input.integration,
    params: input.params ?? {},
    // Call-site context — lets n8n branch on authed vs. share vs. preview.
    via: input.via,
  };

  setIfPresent(payload, 'tenant_slug', input.tenantSlug);
  setIfPresent(payload, 'tenant_name', input.tenantName);
  setIfPresent(payload, 'tenant_status', input.tenantStatus);
  setIfPresent(payload, 'warehouse_host', input.warehouseHost);

  setIfPresent(payload, 'dashboard_id', input.dashboardId);
  setIfPresent(payload, 'dashboard_name', input.dashboardName);
  setIfPresent(payload, 'dashboard_status', input.dashboardStatus);
  if (typeof input.isPublic === 'boolean') payload.is_public = input.isPublic;
  setIfPresent(payload, 'template_id', input.templateId);

  setIfPresent(payload, 'user_id', input.userId);
  setIfPresent(payload, 'user_email', input.userEmail);
  setIfPresent(payload, 'user_name', input.userName);
  setIfPresent(payload, 'user_role', input.userRole);
  if (typeof input.isPlatformAdmin === 'boolean') payload.is_platform_admin = input.isPlatformAdmin;

  setIfPresent(payload, 'access_token', input.accessToken);
  setIfPresent(payload, 'auth_method', input.authMethod);

  const token = jwt.sign(payload, input.secret, {
    algorithm: 'HS256',
    issuer: config.n8nBridge.issuer,
    audience: config.n8nBridge.audience,
    expiresIn: config.n8nBridge.expirySeconds,
  });
  const expiresAt = Math.floor(Date.now() / 1000) + config.n8nBridge.expirySeconds;
  return { jwt: token, jti, expiresAt };
}

// Strong random string suitable as a per-dashboard bridge secret.
// Used by the admin UI's "Generate" button on the server side and by
// any op-scripts that want to seed a row. 48 bytes → 64 base64url chars.
export function generateBridgeSecret(): string {
  return randomBytes(48).toString('base64url');
}

// Decode helper used only by specs. Production code on the n8n side does
// its own verification; XRay itself never re-verifies tokens it just minted.
export function verifyBridgeJwtForTest(token: string, secret: string): jwt.JwtPayload {
  return jwt.verify(token, secret, {
    algorithms: ['HS256'],
    issuer: config.n8nBridge.issuer,
    audience: config.n8nBridge.audience,
  }) as jwt.JwtPayload;
}
