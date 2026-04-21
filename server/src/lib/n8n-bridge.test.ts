import { describe, it, expect, beforeAll } from 'vitest';
import jwt from 'jsonwebtoken';

// Config reads env at import time — set fixtures before importing the lib.
beforeAll(() => {
  process.env.DATABASE_URL ||= 'postgres://stub';
  process.env.JWT_SECRET ||= 'test-jwt-secret';
  process.env.ENCRYPTION_KEY ||= 'a'.repeat(64);
  process.env.N8N_BRIDGE_JWT_SECRET ||= 'b'.repeat(48);
});

async function importBridge() {
  return await import('./n8n-bridge');
}

describe('n8n-bridge', () => {
  it('mints an HS256 token with the kickoff claim set', async () => {
    const { mintBridgeJwt, verifyBridgeJwtForTest } = await importBridge();
    const { jwt: token, jti } = mintBridgeJwt({
      tenantId: '11111111-1111-1111-1111-111111111111',
      userId: '22222222-2222-2222-2222-222222222222',
      templateId: 'tmpl_technician_daily',
      integration: 'housecall_pro',
      params: { branch: 'main' },
    });

    const header = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString());
    expect(header.alg).toBe('HS256');

    const claims = verifyBridgeJwtForTest(token);
    expect(claims.iss).toBe('xray');
    expect(claims.aud).toBe('n8n');
    expect(claims.sub).toBe('11111111-1111-1111-1111-111111111111');
    expect(claims.user_id).toBe('22222222-2222-2222-2222-222222222222');
    expect(claims.template_id).toBe('tmpl_technician_daily');
    expect(claims.integration).toBe('housecall_pro');
    expect(claims.params).toEqual({ branch: 'main' });
    expect(claims.jti).toBe(jti);
    expect(typeof claims.iat).toBe('number');
    expect(typeof claims.exp).toBe('number');
    expect((claims.exp as number) - (claims.iat as number)).toBe(60);
  });

  it('omits access_token, user_id, template_id when not provided', async () => {
    const { mintBridgeJwt, verifyBridgeJwtForTest } = await importBridge();
    const { jwt: token } = mintBridgeJwt({
      tenantId: 'tenant-x',
      integration: 'housecall_pro',
    });
    const claims = verifyBridgeJwtForTest(token);
    expect(claims.access_token).toBeUndefined();
    expect(claims.user_id).toBeUndefined();
    expect(claims.template_id).toBeUndefined();
    expect(claims.params).toEqual({});
  });

  it('includes access_token when provided (step-4 forward path)', async () => {
    const { mintBridgeJwt, verifyBridgeJwtForTest } = await importBridge();
    const { jwt: token } = mintBridgeJwt({
      tenantId: 'tenant-x',
      integration: 'qbo',
      accessToken: 'oauth-access-token-value',
    });
    const claims = verifyBridgeJwtForTest(token);
    expect(claims.access_token).toBe('oauth-access-token-value');
  });

  it('generates a unique jti per call', async () => {
    const { mintBridgeJwt } = await importBridge();
    const a = mintBridgeJwt({ tenantId: 't', integration: 'i' });
    const b = mintBridgeJwt({ tenantId: 't', integration: 'i' });
    expect(a.jti).not.toBe(b.jti);
    expect(a.jti).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('throws on missing tenantId or integration', async () => {
    const { mintBridgeJwt } = await importBridge();
    expect(() => mintBridgeJwt({ tenantId: '', integration: 'x' })).toThrow();
    expect(() => mintBridgeJwt({ tenantId: 't', integration: '' })).toThrow();
  });

  it('rejects tokens signed with the wrong secret', async () => {
    const { mintBridgeJwt } = await importBridge();
    const { jwt: token } = mintBridgeJwt({ tenantId: 't', integration: 'i' });
    expect(() =>
      jwt.verify(token, 'not-the-right-secret', { algorithms: ['HS256'] })
    ).toThrow();
  });
});
