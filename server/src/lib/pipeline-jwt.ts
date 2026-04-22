import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';
import { config } from '../config';

// Pipeline data-access JWT. Signed RS256 with the platform-wide private
// key; verified by the future pipeline DB's pipeline.authorize() function
// using the corresponding public key. Model J in
// .claude/pipeline-hardening-notes.md.
//
// This token is separate from the n8n-bridge JWT (see n8n-bridge.ts) —
// different algorithm (RS256 vs HS256), different audience ('xray-pipeline'
// vs 'n8n'), different verifier (pipeline DB vs n8n JWT Auth node),
// different key model (platform-wide keypair vs per-dashboard secret).
// Platform mints both in parallel on every render.
//
// Claim set is deliberately narrow — authentication + attribution, not
// labels. Tenant/dashboard/user display labels stay on the bridge JWT.
// The pipeline DB verifier only needs to know who's rendering and in what
// context; everything else is noise from its perspective.
//
// Graceful-absent: if the private key isn't provisioned (fresh install
// or upgrade before install/update scripts generated the keypair),
// isPipelineJwtConfigured() returns false and mintPipelineJwt throws.
// Render call sites check isPipelineJwtConfigured() before minting and
// skip silently when it's false; the pipeline DB consumer doesn't exist
// yet so this has no user-visible impact.

export type PipelineVia =
  | 'authed_render'
  | 'admin_impersonation'
  | 'public_share'
  | 'admin_preview';

export interface PipelineJwtInput {
  tenantId: string;
  via: PipelineVia;
  userId?: string | null;
  isPlatformAdmin?: boolean | null;
  expirySeconds?: number;
}

export interface PipelineJwtResult {
  jwt: string;
  jti: string;
  expiresAt: number;
}

export function isPipelineJwtConfigured(): boolean {
  return !!config.pipelineJwt.privateKey;
}

let warnedUnconfiguredOnce = false;
export function warnIfUnconfigured(): void {
  if (!isPipelineJwtConfigured() && !warnedUnconfiguredOnce) {
    warnedUnconfiguredOnce = true;
    console.warn(
      '[pipeline-jwt] XRAY_PIPELINE_JWT_PRIVATE_KEY not set — skipping pipeline JWT mint. ' +
        'Run install.sh/update.sh to provision a keypair.'
    );
  }
}

export function mintPipelineJwt(input: PipelineJwtInput): PipelineJwtResult {
  if (!input.tenantId) throw new Error('mintPipelineJwt: tenantId is required');
  if (!input.via) throw new Error('mintPipelineJwt: via is required');
  if (!config.pipelineJwt.privateKey) {
    throw new Error('mintPipelineJwt: pipeline JWT private key not configured');
  }

  const jti = randomUUID();
  const payload: Record<string, unknown> = {
    sub: input.tenantId,
    jti,
    tenant_id: input.tenantId,
    via: input.via,
  };

  // user_id + is_platform_admin absent on public_share — there's no acting
  // user on a share link, so attribution is tenant-only. Pipeline-hardening
  // notes commit acting_user_id as nullable for exactly this reason.
  if (input.via !== 'public_share') {
    if (input.userId) payload.user_id = input.userId;
    if (typeof input.isPlatformAdmin === 'boolean') {
      payload.is_platform_admin = input.isPlatformAdmin;
    }
  }

  const expirySeconds = input.expirySeconds ?? config.pipelineJwt.expirySeconds;
  const token = jwt.sign(payload, config.pipelineJwt.privateKey, {
    algorithm: 'RS256',
    issuer: config.pipelineJwt.issuer,
    audience: config.pipelineJwt.audience,
    expiresIn: expirySeconds,
  });
  const expiresAt = Math.floor(Date.now() / 1000) + expirySeconds;
  return { jwt: token, jti, expiresAt };
}

// Verification helper used only by specs. Production code runs inside the
// pipeline DB's pipeline.authorize() function, not here.
export function verifyPipelineJwtForTest(
  token: string,
  publicKey: string
): jwt.JwtPayload {
  return jwt.verify(token, publicKey, {
    algorithms: ['RS256'],
    issuer: config.pipelineJwt.issuer,
    audience: config.pipelineJwt.audience,
  }) as jwt.JwtPayload;
}
