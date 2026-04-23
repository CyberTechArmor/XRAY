import jwt from 'jsonwebtoken';
import { randomUUID, randomBytes } from 'crypto';

// Fan-out envelope JWT. Signed HS256 with the per-integration
// fan_out_secret (see migration 023). XRay POSTs one envelope per
// connected tenant to the target URL n8n supplied; n8n verifies the
// envelope with the same fan_out_secret before consuming.
//
// Separate audience from the n8n-bridge JWT (aud='n8n') and the
// pipeline JWT (aud='xray-pipeline') — the three audiences stay
// distinct so n8n workflows (or any future downstream verifier) can
// reject tokens minted for a different contract.
//
// Why a second audience instead of reusing 'n8n'? Fan-out envelopes
// are sent to the tenant's sync-workflow URL, which is a different
// workflow from the render path. Sharing aud='n8n' would let a leaked
// bridge JWT be accepted by a sync workflow (or vice versa) — the
// audience is how n8n's JWT Auth node enforces workflow scoping.
//
// Signing key model: per-integration shared secret (different from
// bridge's per-dashboard secret). Fan-out is integration-scoped; one
// secret per integration matches n8n's credential-per-integration
// story. The same secret authenticates the inbound n8n-→-XRay call
// (Authorization: Bearer <secret>) and signs the outbound envelope.

export const FAN_OUT_AUDIENCE = 'n8n-fan-out';
export const FAN_OUT_ISSUER = 'xray';
export const FAN_OUT_EXPIRY_SECONDS = 60;

export interface FanOutJwtInput {
  // Required core.
  tenantId: string;
  tenantSlug: string;
  integrationSlug: string;
  fanOutId: string;
  secret: string;
  authMethod: 'oauth' | 'api_key';
  // Tenant's live access token (OAuth access_token or API key). Always
  // present — the whole point of fan-out is to hand n8n workflows the
  // per-tenant credential so they can query the upstream provider.
  accessToken: string;
  // Optional envelope passthrough from the fan-out caller.
  window?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
}

export interface FanOutJwtResult {
  jwt: string;
  jti: string;
  expiresAt: number;
}

export function mintFanOutJwt(input: FanOutJwtInput): FanOutJwtResult {
  if (!input.tenantId) throw new Error('mintFanOutJwt: tenantId is required');
  if (!input.integrationSlug) throw new Error('mintFanOutJwt: integrationSlug is required');
  if (!input.fanOutId) throw new Error('mintFanOutJwt: fanOutId is required');
  if (!input.secret) throw new Error('mintFanOutJwt: secret is required');
  if (!input.accessToken) throw new Error('mintFanOutJwt: accessToken is required');
  if (!input.authMethod) throw new Error('mintFanOutJwt: authMethod is required');

  const jti = randomUUID();
  const payload: Record<string, unknown> = {
    sub: input.tenantId,
    jti,
    tenant_id: input.tenantId,
    tenant_slug: input.tenantSlug,
    integration: input.integrationSlug,
    fan_out_id: input.fanOutId,
    auth_method: input.authMethod,
    access_token: input.accessToken,
  };
  if (input.window && Object.keys(input.window).length > 0) {
    payload.window = input.window;
  }
  if (input.metadata && Object.keys(input.metadata).length > 0) {
    payload.metadata = input.metadata;
  }

  const token = jwt.sign(payload, input.secret, {
    algorithm: 'HS256',
    issuer: FAN_OUT_ISSUER,
    audience: FAN_OUT_AUDIENCE,
    expiresIn: FAN_OUT_EXPIRY_SECONDS,
  });
  const expiresAt = Math.floor(Date.now() / 1000) + FAN_OUT_EXPIRY_SECONDS;
  return { jwt: token, jti, expiresAt };
}

// Strong random string suitable as a per-integration fan-out secret.
// 48 bytes → 64 base64url chars. Used by the admin UI's "Generate"
// button (server-side variant) and by op-scripts.
export function generateFanOutSecret(): string {
  return randomBytes(48).toString('base64url');
}

// Verification helper used only by specs. In production, n8n's JWT Auth
// node verifies fan-out tokens using the shared secret.
export function verifyFanOutJwtForTest(token: string, secret: string): jwt.JwtPayload {
  return jwt.verify(token, secret, {
    algorithms: ['HS256'],
    issuer: FAN_OUT_ISSUER,
    audience: FAN_OUT_AUDIENCE,
  }) as jwt.JwtPayload;
}
