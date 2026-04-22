import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';

beforeAll(() => {
  process.env.DATABASE_URL ||= 'postgres://stub';
  process.env.JWT_SECRET ||= 'test-jwt-secret';
  process.env.ENCRYPTION_KEY ||= 'a'.repeat(64);
});

async function importLib() {
  return await import('./oauth-tokens');
}

function fakeTokenResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('oauth-tokens.exchangeWithRetry', () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const { __setFetcherForTest, __setSleeperForTest } = await importLib();
    mockFetch = vi.fn();
    __setFetcherForTest(mockFetch as any);
    // Skip real sleeps — tests shouldn't wait 7.5 min for exhaustion.
    __setSleeperForTest(async () => {});
  });

  afterEach(async () => {
    const { __setFetcherForTest, __setSleeperForTest } = await importLib();
    __setFetcherForTest(null);
    __setSleeperForTest(null);
    vi.restoreAllMocks();
  });

  it('returns a TokenPair on first-attempt success', async () => {
    const { exchangeWithRetry } = await importLib();
    mockFetch.mockResolvedValueOnce(
      fakeTokenResponse({
        access_token: 'new-access',
        refresh_token: 'rotated-refresh',
        expires_in: 3600,
        token_type: 'Bearer',
      })
    );
    const result = await exchangeWithRetry({
      tokenUrl: 'https://provider.test/token',
      clientId: 'cid',
      clientSecret: 'csec',
      refreshToken: 'old-refresh',
    });
    expect(result.accessToken).toBe('new-access');
    expect(result.refreshToken).toBe('rotated-refresh');
    expect(result.expiresIn).toBe(3600);
    expect(result.tokenType).toBe('Bearer');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('preserves existing refresh_token when provider omits it on re-exchange', async () => {
    // Older OAuth 2.0 behavior — refresh_token sent on first exchange
    // only. Provider response here has no refresh_token field; our lib
    // must return null (NOT empty string), signaling "don't touch the
    // stored refresh_token".
    const { exchangeWithRetry } = await importLib();
    mockFetch.mockResolvedValueOnce(
      fakeTokenResponse({
        access_token: 'new-access',
        expires_in: 3600,
        token_type: 'Bearer',
      })
    );
    const result = await exchangeWithRetry({
      tokenUrl: 'https://provider.test/token',
      clientId: 'cid',
      clientSecret: 'csec',
      refreshToken: 'old-refresh',
    });
    expect(result.refreshToken).toBeNull();
  });

  it('defaults expires_in to 3600 when provider omits it', async () => {
    const { exchangeWithRetry } = await importLib();
    mockFetch.mockResolvedValueOnce(
      fakeTokenResponse({ access_token: 'new-access', token_type: 'Bearer' })
    );
    const result = await exchangeWithRetry({
      tokenUrl: 'https://provider.test/token',
      clientId: 'cid',
      clientSecret: 'csec',
      refreshToken: 'old-refresh',
    });
    expect(result.expiresIn).toBe(3600);
  });

  it('carries provider extras (e.g. QBO realmId) in the extras bag', async () => {
    const { exchangeWithRetry } = await importLib();
    mockFetch.mockResolvedValueOnce(
      fakeTokenResponse({
        access_token: 'new-access',
        refresh_token: 'rotated-refresh',
        expires_in: 3600,
        token_type: 'Bearer',
        realmId: '1234567890',
        scope: 'com.intuit.quickbooks.accounting',
      })
    );
    const result = await exchangeWithRetry({
      tokenUrl: 'https://provider.test/token',
      clientId: 'cid',
      clientSecret: 'csec',
      refreshToken: 'old-refresh',
    });
    expect(result.extras.realmId).toBe('1234567890');
    expect(result.extras.scope).toBe('com.intuit.quickbooks.accounting');
    // Known fields should NOT appear in extras.
    expect(result.extras.access_token).toBeUndefined();
    expect(result.extras.refresh_token).toBeUndefined();
    expect(result.extras.expires_in).toBeUndefined();
    expect(result.extras.token_type).toBeUndefined();
  });

  it('posts form-urlencoded body with grant_type=refresh_token', async () => {
    const { exchangeWithRetry } = await importLib();
    mockFetch.mockResolvedValueOnce(
      fakeTokenResponse({ access_token: 'new-access' })
    );
    await exchangeWithRetry({
      tokenUrl: 'https://provider.test/token',
      clientId: 'cid',
      clientSecret: 'csec',
      refreshToken: 'the-refresh-token',
    });
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('https://provider.test/token');
    expect((opts as any).method).toBe('POST');
    expect((opts as any).headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect((opts as any).headers.Accept).toBe('application/json');
    const body = new URLSearchParams((opts as any).body as string);
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('refresh_token')).toBe('the-refresh-token');
    expect(body.get('client_id')).toBe('cid');
    expect(body.get('client_secret')).toBe('csec');
  });

  it('retries on transient failure, succeeds on later attempt', async () => {
    const { exchangeWithRetry } = await importLib();
    mockFetch
      .mockRejectedValueOnce(new Error('network glitch'))
      .mockResolvedValueOnce(new Response('bad gateway', { status: 502 }))
      .mockResolvedValueOnce(fakeTokenResponse({ access_token: 'finally' }));
    const result = await exchangeWithRetry({
      tokenUrl: 'https://provider.test/token',
      clientId: 'cid',
      clientSecret: 'csec',
      refreshToken: 'old-refresh',
    });
    expect(result.accessToken).toBe('finally');
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('throws OAuthExchangeError after exhausting all 5 attempts', async () => {
    const { exchangeWithRetry, OAuthExchangeError } = await importLib();
    // mockImplementation returns a FRESH Response per call — Response
    // bodies can only be consumed once, so mockResolvedValue would reuse
    // an already-read body across retries.
    mockFetch.mockImplementation(
      async () => new Response('{"error":"invalid_grant"}', { status: 400 })
    );
    await expect(
      exchangeWithRetry({
        tokenUrl: 'https://provider.test/token',
        clientId: 'cid',
        clientSecret: 'csec',
        refreshToken: 'revoked-refresh',
      })
    ).rejects.toBeInstanceOf(OAuthExchangeError);
    // 5 attempts total per the committed policy.
    expect(mockFetch).toHaveBeenCalledTimes(5);
  });

  it('throws OAuthExchangeError when provider returns 200 with no access_token', async () => {
    const { exchangeWithRetry, OAuthExchangeError } = await importLib();
    mockFetch.mockImplementation(async () =>
      fakeTokenResponse({ something_else: 'nope' })
    );
    await expect(
      exchangeWithRetry({
        tokenUrl: 'https://provider.test/token',
        clientId: 'cid',
        clientSecret: 'csec',
        refreshToken: 'old-refresh',
      })
    ).rejects.toBeInstanceOf(OAuthExchangeError);
  });

  it('REFRESH_RETRY_DELAYS_MS matches the committed [0, 30, 60, 120, 240]s policy', async () => {
    const { REFRESH_RETRY_DELAYS_MS } = await importLib();
    expect(REFRESH_RETRY_DELAYS_MS).toEqual([0, 30_000, 60_000, 120_000, 240_000]);
  });
});

describe('oauth-tokens.exchangeAuthorizationCode', () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const { __setFetcherForTest } = await importLib();
    mockFetch = vi.fn();
    __setFetcherForTest(mockFetch as any);
  });

  afterEach(async () => {
    const { __setFetcherForTest } = await importLib();
    __setFetcherForTest(null);
  });

  it('posts grant_type=authorization_code with code + redirect_uri', async () => {
    const { exchangeAuthorizationCode } = await importLib();
    mockFetch.mockResolvedValueOnce(
      fakeTokenResponse({
        access_token: 'initial-access',
        refresh_token: 'first-refresh',
        expires_in: 3600,
      })
    );
    const result = await exchangeAuthorizationCode({
      tokenUrl: 'https://provider.test/token',
      clientId: 'cid',
      clientSecret: 'csec',
      authorizationCode: 'the-code',
      redirectUri: 'https://xray.test/api/oauth/callback',
    });
    expect(result.accessToken).toBe('initial-access');
    expect(result.refreshToken).toBe('first-refresh');
    const [, opts] = mockFetch.mock.calls[0];
    const body = new URLSearchParams((opts as any).body as string);
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code')).toBe('the-code');
    expect(body.get('redirect_uri')).toBe('https://xray.test/api/oauth/callback');
  });

  it('single attempt — no retry (user is waiting interactively)', async () => {
    const { exchangeAuthorizationCode, OAuthExchangeError } = await importLib();
    mockFetch.mockResolvedValueOnce(
      new Response('invalid_grant', { status: 400 })
    );
    await expect(
      exchangeAuthorizationCode({
        tokenUrl: 'https://provider.test/token',
        clientId: 'cid',
        clientSecret: 'csec',
        authorizationCode: 'expired-code',
        redirectUri: 'https://xray.test/api/oauth/callback',
      })
    ).rejects.toBeInstanceOf(OAuthExchangeError);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
