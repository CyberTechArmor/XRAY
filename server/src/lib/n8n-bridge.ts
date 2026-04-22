import jwt from 'jsonwebtoken';
import { randomUUID, randomBytes } from 'crypto';
import { config } from '../config';

// Short-lived HS256 JWT XRay hands to n8n on every render call.
// Claim set is the contract n8n validates against — see the step-2
// handoff in CONTEXT.md for how n8n is expected to verify and route.
//
// The signing secret is per-dashboard (migration 019) — NOT a single
// platform-wide env var. The render call sites decrypt the dashboard
// row's `bridge_secret` and pass it in here. This caps the blast radius
// of a leaked secret to a single dashboard/integration.
export interface BridgeJwtInput {
  tenantId: string;
  integration: string;
  secret: string;
  userId?: string | null;
  templateId?: string | null;
  accessToken?: string | null;
  params?: Record<string, unknown> | null;
}

export interface BridgeJwtResult {
  jwt: string;
  jti: string;
  expiresAt: number;
}

export function mintBridgeJwt(input: BridgeJwtInput): BridgeJwtResult {
  if (!input.tenantId) throw new Error('mintBridgeJwt: tenantId is required');
  if (!input.integration) throw new Error('mintBridgeJwt: integration is required');
  if (!input.secret) throw new Error('mintBridgeJwt: secret is required');

  const jti = randomUUID();
  const payload: Record<string, unknown> = {
    sub: input.tenantId,
    jti,
    integration: input.integration,
    params: input.params ?? {},
  };
  // Absent rather than empty when unknown — keeps n8n's claim validation
  // from seeing false-signal nulls.
  if (input.userId) payload.user_id = input.userId;
  if (input.templateId) payload.template_id = input.templateId;
  if (input.accessToken) payload.access_token = input.accessToken;

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
