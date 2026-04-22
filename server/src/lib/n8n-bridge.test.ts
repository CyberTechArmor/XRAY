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
  it('mints an HS256 token with the full authed-render claim set', async () => {
    const { mintBridgeJwt, verifyBridgeJwtForTest } = await importBridge();
    const { jwt: token, jti } = mintBridgeJwt({
      tenantId: '11111111-1111-1111-1111-111111111111',
      tenantSlug: 'acme',
      tenantName: 'Acme Co',
      tenantStatus: 'active',
      warehouseHost: 'acme.db.internal',
      dashboardId: '33333333-3333-3333-3333-333333333333',
      dashboardName: 'Technician Daily',
      dashboardStatus: 'active',
      isPublic: false,
      userId: '22222222-2222-2222-2222-222222222222',
      userEmail: 'user@acme.test',
      userName: 'Jane Tech',
      userRole: 'member',
      isPlatformAdmin: false,
      templateId: 'tmpl_technician_daily',
      integration: 'housecall_pro',
      params: { branch: 'main' },
      via: 'authed_render',
      secret: SECRET,
    });

    const header = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString());
    expect(header.alg).toBe('HS256');

    const claims = verifyBridgeJwtForTest(token, SECRET);
    expect(claims.iss).toBe('xray');
    expect(claims.aud).toBe('n8n');
    expect(claims.sub).toBe('11111111-1111-1111-1111-111111111111');
    expect(claims.tenant_id).toBe('11111111-1111-1111-1111-111111111111');
    expect(claims.tenant_slug).toBe('acme');
    expect(claims.tenant_name).toBe('Acme Co');
    expect(claims.tenant_status).toBe('active');
    expect(claims.warehouse_host).toBe('acme.db.internal');
    expect(claims.dashboard_id).toBe('33333333-3333-3333-3333-333333333333');
    expect(claims.dashboard_name).toBe('Technician Daily');
    expect(claims.dashboard_status).toBe('active');
    expect(claims.is_public).toBe(false);
    expect(claims.user_id).toBe('22222222-2222-2222-2222-222222222222');
    expect(claims.user_email).toBe('user@acme.test');
    expect(claims.user_name).toBe('Jane Tech');
    expect(claims.user_role).toBe('member');
    expect(claims.is_platform_admin).toBe(false);
    expect(claims.template_id).toBe('tmpl_technician_daily');
    expect(claims.integration).toBe('housecall_pro');
    expect(claims.params).toEqual({ branch: 'main' });
    expect(claims.via).toBe('authed_render');
    expect(claims.jti).toBe(jti);
    expect(typeof claims.iat).toBe('number');
    expect(typeof claims.exp).toBe('number');
    expect((claims.exp as number) - (claims.iat as number)).toBe(60);
  });

  it('sub always equals tenant_id (JWT Auth node + explicit mirror invariant)', async () => {
    const { mintBridgeJwt, verifyBridgeJwtForTest } = await importBridge();
    const { jwt: token } = mintBridgeJwt({
      tenantId: 'tenant-xyz',
      integration: 'housecall_pro',
      via: 'authed_render',
      secret: SECRET,
    });
    const claims = verifyBridgeJwtForTest(token, SECRET);
    expect(claims.sub).toBe(claims.tenant_id);
    expect(claims.tenant_id).toBe('tenant-xyz');
  });

  it('public_share omits every user_* claim', async () => {
    const { mintBridgeJwt, verifyBridgeJwtForTest } = await importBridge();
    const { jwt: token } = mintBridgeJwt({
      tenantId: 'tenant-x',
      tenantSlug: 'acme',
      tenantName: 'Acme Co',
      tenantStatus: 'active',
      dashboardId: 'd-1',
      dashboardName: 'Public Dash',
      dashboardStatus: 'active',
      isPublic: true,
      integration: 'housecall_pro',
      via: 'public_share',
      secret: SECRET,
    });
    const claims = verifyBridgeJwtForTest(token, SECRET);
    expect(claims.via).toBe('public_share');
    expect(claims.user_id).toBeUndefined();
    expect(claims.user_email).toBeUndefined();
    expect(claims.user_name).toBeUndefined();
    expect(claims.user_role).toBeUndefined();
    expect(claims.is_platform_admin).toBeUndefined();
    // Tenant + dashboard info still present — n8n needs it server-side.
    expect(claims.tenant_slug).toBe('acme');
    expect(claims.dashboard_id).toBe('d-1');
    expect(claims.is_public).toBe(true);
  });

  it('admin_preview carries user_* from the acting admin', async () => {
    const { mintBridgeJwt, verifyBridgeJwtForTest } = await importBridge();
    const { jwt: token } = mintBridgeJwt({
      tenantId: 'tenant-x',
      dashboardId: 'd-1',
      userId: 'admin-user',
      userEmail: 'admin@xray.test',
      userRole: 'platform_admin',
      isPlatformAdmin: true,
      integration: 'housecall_pro',
      via: 'admin_preview',
      secret: SECRET,
    });
    const claims = verifyBridgeJwtForTest(token, SECRET);
    expect(claims.via).toBe('admin_preview');
    expect(claims.user_id).toBe('admin-user');
    expect(claims.is_platform_admin).toBe(true);
  });

  it('omits optional claims when not provided, keeps params default {}', async () => {
    const { mintBridgeJwt, verifyBridgeJwtForTest } = await importBridge();
    const { jwt: token } = mintBridgeJwt({
      tenantId: 'tenant-x',
      integration: 'housecall_pro',
      via: 'authed_render',
      secret: SECRET,
    });
    const claims = verifyBridgeJwtForTest(token, SECRET);
    expect(claims.access_token).toBeUndefined();
    expect(claims.user_id).toBeUndefined();
    expect(claims.template_id).toBeUndefined();
    expect(claims.warehouse_host).toBeUndefined();
    expect(claims.tenant_slug).toBeUndefined();
    expect(claims.dashboard_id).toBeUndefined();
    expect(claims.is_public).toBeUndefined();
    expect(claims.is_platform_admin).toBeUndefined();
    expect(claims.params).toEqual({});
  });

  it('empty-string optionals are treated as absent, not emitted as ""', async () => {
    const { mintBridgeJwt, verifyBridgeJwtForTest } = await importBridge();
    const { jwt: token } = mintBridgeJwt({
      tenantId: 'tenant-x',
      tenantSlug: '',
      warehouseHost: '',
      templateId: '',
      userEmail: '',
      integration: 'housecall_pro',
      via: 'authed_render',
      secret: SECRET,
    });
    const claims = verifyBridgeJwtForTest(token, SECRET);
    expect(claims.tenant_slug).toBeUndefined();
    expect(claims.warehouse_host).toBeUndefined();
    expect(claims.template_id).toBeUndefined();
    expect(claims.user_email).toBeUndefined();
  });

  it('is_public=false still lands in the payload (boolean-preserving)', async () => {
    const { mintBridgeJwt, verifyBridgeJwtForTest } = await importBridge();
    const { jwt: token } = mintBridgeJwt({
      tenantId: 'tenant-x',
      isPublic: false,
      isPlatformAdmin: false,
      integration: 'housecall_pro',
      via: 'authed_render',
      secret: SECRET,
    });
    const claims = verifyBridgeJwtForTest(token, SECRET);
    expect(claims.is_public).toBe(false);
    expect(claims.is_platform_admin).toBe(false);
  });

  it('includes access_token when provided (step-4 forward path)', async () => {
    const { mintBridgeJwt, verifyBridgeJwtForTest } = await importBridge();
    const { jwt: token } = mintBridgeJwt({
      tenantId: 'tenant-x',
      integration: 'qbo',
      accessToken: 'oauth-access-token-value',
      via: 'authed_render',
      secret: SECRET,
    });
    const claims = verifyBridgeJwtForTest(token, SECRET);
    expect(claims.access_token).toBe('oauth-access-token-value');
  });

  it('generates a unique jti per call', async () => {
    const { mintBridgeJwt } = await importBridge();
    const a = mintBridgeJwt({ tenantId: 't', integration: 'i', via: 'authed_render', secret: SECRET });
    const b = mintBridgeJwt({ tenantId: 't', integration: 'i', via: 'authed_render', secret: SECRET });
    expect(a.jti).not.toBe(b.jti);
    expect(a.jti).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('throws on missing tenantId, integration, via, or secret', async () => {
    const { mintBridgeJwt } = await importBridge();
    expect(() => mintBridgeJwt({ tenantId: '', integration: 'x', via: 'authed_render', secret: SECRET })).toThrow();
    expect(() => mintBridgeJwt({ tenantId: 't', integration: '', via: 'authed_render', secret: SECRET })).toThrow();
    expect(() => mintBridgeJwt({ tenantId: 't', integration: 'x', via: 'authed_render', secret: '' })).toThrow();
    expect(() => mintBridgeJwt({ tenantId: 't', integration: 'x', via: '' as any, secret: SECRET })).toThrow();
  });

  it('per-dashboard secrets: token A does not verify under secret B', async () => {
    const { mintBridgeJwt } = await importBridge();
    const { jwt: tokenA } = mintBridgeJwt({
      tenantId: 't', integration: 'i', via: 'authed_render',
      secret: 'secret-A-for-dashboard-A-long-enough',
    });
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
    const { jwt: token } = mintBridgeJwt({ tenantId: 't', integration: 'i', via: 'authed_render', secret: s1 });
    expect(verifyBridgeJwtForTest(token, s1).sub).toBe('t');
  });
});
