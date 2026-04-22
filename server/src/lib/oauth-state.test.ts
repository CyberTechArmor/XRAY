import { describe, it, expect, beforeAll } from 'vitest';

beforeAll(() => {
  process.env.DATABASE_URL ||= 'postgres://stub';
  process.env.JWT_SECRET ||= 'test-jwt-secret';
  process.env.ENCRYPTION_KEY ||= 'a'.repeat(64);
});

async function importLib() {
  return await import('./oauth-state');
}

describe('oauth-state.mintOAuthState + verifyOAuthState', () => {
  it('round-trips tenantId / integrationId / userId + unique nonce', async () => {
    const { mintOAuthState, verifyOAuthState } = await importLib();
    const token = mintOAuthState({
      tenantId: 'tenant-x',
      integrationId: 'integration-y',
      userId: 'user-z',
    });
    const claims = verifyOAuthState(token);
    expect(claims.t).toBe('tenant-x');
    expect(claims.i).toBe('integration-y');
    expect(claims.u).toBe('user-z');
    expect(claims.n).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('mints a fresh nonce per call', async () => {
    const { mintOAuthState, verifyOAuthState } = await importLib();
    const a = verifyOAuthState(
      mintOAuthState({ tenantId: 't', integrationId: 'i', userId: 'u' })
    );
    const b = verifyOAuthState(
      mintOAuthState({ tenantId: 't', integrationId: 'i', userId: 'u' })
    );
    expect(a.n).not.toBe(b.n);
  });

  it('rejects a tampered token', async () => {
    const { mintOAuthState, verifyOAuthState } = await importLib();
    const token = mintOAuthState({
      tenantId: 't',
      integrationId: 'i',
      userId: 'u',
    });
    // Flip a character in the signature segment
    const [h, p, sig] = token.split('.');
    const tampered = `${h}.${p}.${sig.slice(0, -2)}xx`;
    expect(() => verifyOAuthState(tampered)).toThrow();
  });

  it('rejects a token signed with a different secret', async () => {
    const { mintOAuthState, verifyOAuthState } = await importLib();
    const jwt = await import('jsonwebtoken');
    const bogus = jwt.default.sign(
      { t: 't', i: 'i', u: 'u', n: 'abc' },
      'not-the-right-secret',
      { algorithm: 'HS256', issuer: 'xray:oauth-state', expiresIn: 60 }
    );
    expect(() => verifyOAuthState(bogus)).toThrow();
  });
});

describe('oauth-state.buildAuthorizeUrl', () => {
  it('builds a standard OAuth 2.0 authorize URL', async () => {
    const { buildAuthorizeUrl } = await importLib();
    const url = buildAuthorizeUrl({
      authUrl: 'https://provider.test/authorize',
      clientId: 'the-client-id',
      redirectUri: 'https://xray.test/api/oauth/callback',
      scopes: 'read write',
      state: 'state-jwt',
      extraParams: {},
    });
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe('https://provider.test/authorize');
    expect(parsed.searchParams.get('response_type')).toBe('code');
    expect(parsed.searchParams.get('client_id')).toBe('the-client-id');
    expect(parsed.searchParams.get('redirect_uri')).toBe(
      'https://xray.test/api/oauth/callback'
    );
    expect(parsed.searchParams.get('scope')).toBe('read write');
    expect(parsed.searchParams.get('state')).toBe('state-jwt');
  });

  it('merges extra_authorize_params (Google-style access_type/prompt)', async () => {
    const { buildAuthorizeUrl } = await importLib();
    const url = buildAuthorizeUrl({
      authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
      clientId: 'cid',
      redirectUri: 'https://xray.test/api/oauth/callback',
      scopes: 'openid email',
      state: 's',
      extraParams: { access_type: 'offline', prompt: 'consent' },
    });
    const parsed = new URL(url);
    expect(parsed.searchParams.get('access_type')).toBe('offline');
    expect(parsed.searchParams.get('prompt')).toBe('consent');
  });

  it('omits scope when integration has none configured', async () => {
    const { buildAuthorizeUrl } = await importLib();
    const url = buildAuthorizeUrl({
      authUrl: 'https://provider.test/authorize',
      clientId: 'cid',
      redirectUri: 'https://xray.test/api/oauth/callback',
      scopes: null,
      state: 's',
      extraParams: {},
    });
    expect(new URL(url).searchParams.has('scope')).toBe(false);
  });

  it('ignores null/undefined extra params', async () => {
    const { buildAuthorizeUrl } = await importLib();
    const url = buildAuthorizeUrl({
      authUrl: 'https://provider.test/authorize',
      clientId: 'cid',
      redirectUri: 'https://xray.test/api/oauth/callback',
      scopes: null,
      state: 's',
      extraParams: { skipMe: null, alsoSkipMe: undefined, keepMe: 'yes' } as any,
    });
    const parsed = new URL(url);
    expect(parsed.searchParams.has('skipMe')).toBe(false);
    expect(parsed.searchParams.has('alsoSkipMe')).toBe(false);
    expect(parsed.searchParams.get('keepMe')).toBe('yes');
  });
});
