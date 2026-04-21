import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';
import { config } from '../config';

// Short-lived HS256 JWT XRay hands to n8n on every render call.
// Claim set is the contract n8n validates against — see the step-2
// handoff in CONTEXT.md for how n8n is expected to verify and route.
export interface BridgeJwtInput {
  tenantId: string;
  userId?: string | null;
  templateId?: string | null;
  integration: string;
  accessToken?: string | null;
  params?: Record<string, unknown> | null;
}

export interface BridgeJwtResult {
  jwt: string;
  jti: string;
  expiresAt: number;
}

// Mint the bridge token. The caller is responsible for deciding whether
// a given dashboard is on the JWT path (integration non-empty) — this
// function only signs; it does not enforce routing.
export function mintBridgeJwt(input: BridgeJwtInput): BridgeJwtResult {
  if (!input.tenantId) throw new Error('mintBridgeJwt: tenantId is required');
  if (!input.integration) throw new Error('mintBridgeJwt: integration is required');

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

  const token = jwt.sign(payload, config.n8nBridge.jwtSecret, {
    algorithm: 'HS256',
    issuer: config.n8nBridge.issuer,
    audience: config.n8nBridge.audience,
    expiresIn: config.n8nBridge.expirySeconds,
  });
  const expiresAt = Math.floor(Date.now() / 1000) + config.n8nBridge.expirySeconds;
  return { jwt: token, jti, expiresAt };
}

// Decode helper used only by specs. Production code on the n8n side does
// its own verification; XRay itself never re-verifies tokens it just minted.
export function verifyBridgeJwtForTest(token: string): jwt.JwtPayload {
  return jwt.verify(token, config.n8nBridge.jwtSecret, {
    algorithms: ['HS256'],
    issuer: config.n8nBridge.issuer,
    audience: config.n8nBridge.audience,
  }) as jwt.JwtPayload;
}
