import { describe, it, expect, beforeAll } from 'vitest';
import { generateKeyPairSync } from 'crypto';

// Generate a test keypair once and inject via env before importing the lib
// so config.ts reads it at import time. Matches the pattern used by
// n8n-bridge.test.ts and encrypted-column.test.ts for env-driven config.
const { publicKey, privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

beforeAll(() => {
  process.env.DATABASE_URL ||= 'postgres://stub';
  process.env.JWT_SECRET ||= 'test-jwt-secret';
  process.env.ENCRYPTION_KEY ||= 'a'.repeat(64);
  process.env.XRAY_PIPELINE_JWT_PRIVATE_KEY = privateKey;
  process.env.XRAY_PIPELINE_JWT_PUBLIC_KEY = publicKey;
});

async function importPipelineJwt() {
  return await import('./pipeline-jwt');
}

describe('pipeline-jwt', () => {
  it('mints an RS256 token with the committed claim shape', async () => {
    const { mintPipelineJwt, verifyPipelineJwtForTest } = await importPipelineJwt();
    const { jwt: token, jti } = mintPipelineJwt({
      tenantId: '11111111-1111-1111-1111-111111111111',
      userId: '22222222-2222-2222-2222-222222222222',
      isPlatformAdmin: false,
      via: 'authed_render',
    });

    const header = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString());
    expect(header.alg).toBe('RS256');

    const claims = verifyPipelineJwtForTest(token, publicKey);
    expect(claims.iss).toBe('xray');
    expect(claims.aud).toBe('xray-pipeline');
    expect(claims.sub).toBe('11111111-1111-1111-1111-111111111111');
    expect(claims.tenant_id).toBe('11111111-1111-1111-1111-111111111111');
    expect(claims.user_id).toBe('22222222-2222-2222-2222-222222222222');
    expect(claims.is_platform_admin).toBe(false);
    expect(claims.via).toBe('authed_render');
    expect(claims.jti).toBe(jti);
    expect(typeof claims.iat).toBe('number');
    expect(typeof claims.exp).toBe('number');
    expect((claims.exp as number) - (claims.iat as number)).toBe(60);
  });

  it('omits user_id and is_platform_admin on public_share', async () => {
    const { mintPipelineJwt, verifyPipelineJwtForTest } = await importPipelineJwt();
    const { jwt: token } = mintPipelineJwt({
      tenantId: 'tenant-x',
      // Caller passes user info but public_share path must drop it — matches
      // the pipeline-hardening commitment of nullable acting_user_id.
      userId: 'should-be-dropped',
      isPlatformAdmin: true,
      via: 'public_share',
    });
    const claims = verifyPipelineJwtForTest(token, publicKey);
    expect(claims.via).toBe('public_share');
    expect(claims.tenant_id).toBe('tenant-x');
    expect(claims.user_id).toBeUndefined();
    expect(claims.is_platform_admin).toBeUndefined();
  });

  it('admin_impersonation keeps user_id + is_platform_admin=true', async () => {
    const { mintPipelineJwt, verifyPipelineJwtForTest } = await importPipelineJwt();
    const { jwt: token } = mintPipelineJwt({
      tenantId: 'target-tenant',
      userId: 'platform-admin-uuid',
      isPlatformAdmin: true,
      via: 'admin_impersonation',
    });
    const claims = verifyPipelineJwtForTest(token, publicKey);
    expect(claims.sub).toBe('target-tenant');
    expect(claims.tenant_id).toBe('target-tenant');
    expect(claims.user_id).toBe('platform-admin-uuid');
    expect(claims.is_platform_admin).toBe(true);
    expect(claims.via).toBe('admin_impersonation');
  });

  it('generates a unique jti per call', async () => {
    const { mintPipelineJwt } = await importPipelineJwt();
    const a = mintPipelineJwt({ tenantId: 't', via: 'authed_render' });
    const b = mintPipelineJwt({ tenantId: 't', via: 'authed_render' });
    expect(a.jti).not.toBe(b.jti);
    expect(a.jti).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('claim set deliberately narrow — no integration/params/labels', async () => {
    // Negative assertion: the pipeline JWT must NOT carry bridge-JWT-style
    // labels. Those belong on n8n-bridge.ts. This test is a guardrail
    // against someone adding a label here "for convenience" later.
    const { mintPipelineJwt, verifyPipelineJwtForTest } = await importPipelineJwt();
    const { jwt: token } = mintPipelineJwt({
      tenantId: 't',
      userId: 'u',
      isPlatformAdmin: false,
      via: 'authed_render',
    });
    const claims = verifyPipelineJwtForTest(token, publicKey) as Record<string, unknown>;
    expect(claims.integration).toBeUndefined();
    expect(claims.params).toBeUndefined();
    expect(claims.tenant_slug).toBeUndefined();
    expect(claims.tenant_name).toBeUndefined();
    expect(claims.dashboard_id).toBeUndefined();
    expect(claims.dashboard_name).toBeUndefined();
    expect(claims.access_token).toBeUndefined();
    expect(claims.auth_method).toBeUndefined();
  });

  it('throws on missing tenantId or via', async () => {
    const { mintPipelineJwt } = await importPipelineJwt();
    expect(() => mintPipelineJwt({ tenantId: '', via: 'authed_render' })).toThrow();
    expect(() => mintPipelineJwt({ tenantId: 't', via: '' as any })).toThrow();
  });

  it('isPipelineJwtConfigured reflects the keypair state', async () => {
    const { isPipelineJwtConfigured } = await importPipelineJwt();
    // Private key was set before config import — should be true throughout
    // this suite.
    expect(isPipelineJwtConfigured()).toBe(true);
  });

  it('RS256 signature verifies against the corresponding public key only', async () => {
    const { mintPipelineJwt, verifyPipelineJwtForTest } = await importPipelineJwt();
    const { jwt: token } = mintPipelineJwt({ tenantId: 't', via: 'authed_render' });

    // Generate a second, unrelated keypair — signature should not verify.
    const { publicKey: otherPub } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    expect(() => verifyPipelineJwtForTest(token, otherPub)).toThrow();
  });
});
