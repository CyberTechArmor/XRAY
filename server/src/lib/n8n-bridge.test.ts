import { describe, it, expect, beforeAll } from 'vitest';
import jwt from 'jsonwebtoken';

// Config reads env at import time — set fixtures before importing the lib.
// The bridge no longer reads a platform-wide secret from env; the secret
// is an explicit arg. But ENCRYPTION_KEY etc. still come from env.
beforeAll(() => {
  process.env.DATABASE_URL ||= 'postgres://stub';
  process.env.JWT_SECRET ||= 'test-jwt-secret';
  process.env.ENCRYPTION_KEY ||= 'a'.repeat(64);
});

async function importBridge() {
  return await import('./n8n-bridge');
}

const SECRET = 'per-dashboard-signing-secret-long-enough-for-hs256';

describe('n8n-bridge', () => {
  it('mints an HS256 token with the kickoff claim set', async () => {
    const { mintBridgeJwt, verifyBridgeJwtForTest } = await importBridge();
    const { jwt: token, jti } = mintBridgeJwt({
      tenantId: '11111111-1111-1111-1111-111111111111',
      userId: '22222222-2222-2222-2222-222222222222',
      templateId: 'tmpl_technician_daily',
      integration: 'housecall_pro',
      params: { branch: 'main' },
      secret: SECRET,
    });

    const header = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString());
    expect(header.alg).toBe('HS256');

    const claims = verifyBridgeJwtForTest(token, SECRET);
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
      secret: SECRET,
    });
    const claims = verifyBridgeJwtForTest(token, SECRET);
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
      secret: SECRET,
    });
    const claims = verifyBridgeJwtForTest(token, SECRET);
    expect(claims.access_token).toBe('oauth-access-token-value');
  });

  it('generates a unique jti per call', async () => {
    const { mintBridgeJwt } = await importBridge();
    const a = mintBridgeJwt({ tenantId: 't', integration: 'i', secret: SECRET });
    const b = mintBridgeJwt({ tenantId: 't', integration: 'i', secret: SECRET });
    expect(a.jti).not.toBe(b.jti);
    expect(a.jti).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('throws on missing tenantId, integration, or secret', async () => {
    const { mintBridgeJwt } = await importBridge();
    expect(() => mintBridgeJwt({ tenantId: '', integration: 'x', secret: SECRET })).toThrow();
    expect(() => mintBridgeJwt({ tenantId: 't', integration: '', secret: SECRET })).toThrow();
    expect(() => mintBridgeJwt({ tenantId: 't', integration: 'x', secret: '' })).toThrow();
  });

  it('per-dashboard secrets: token A does not verify under secret B', async () => {
    const { mintBridgeJwt } = await importBridge();
    const { jwt: tokenA } = mintBridgeJwt({ tenantId: 't', integration: 'i', secret: 'secret-A-for-dashboard-A-long-enough' });
    expect(() =>
      jwt.verify(tokenA, 'secret-B-for-dashboard-B-long-enough', { algorithms: ['HS256'] })
    ).toThrow();
  });

  it('generateBridgeSecret returns a usably-long base64url string', async () => {
    const { generateBridgeSecret, mintBridgeJwt, verifyBridgeJwtForTest } = await importBridge();
    const s1 = generateBridgeSecret();
    const s2 = generateBridgeSecret();
    expect(s1).not.toBe(s2);
    expect(s1.length).toBeGreaterThanOrEqual(64);
    expect(s1).toMatch(/^[A-Za-z0-9_-]+$/);
    // Round-trips as a signing secret.
    const { jwt: token } = mintBridgeJwt({ tenantId: 't', integration: 'i', secret: s1 });
    expect(verifyBridgeJwtForTest(token, s1).sub).toBe('t');
  });
});
