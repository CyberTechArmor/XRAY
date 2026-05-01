import { describe, it, expect, beforeAll } from 'vitest';

// Pure-logic specs: slug + cross-field validation, client_secret redaction.
// DB-backed CRUD is covered by end-to-end tests that stand up a real
// Postgres; these specs mirror the pattern of n8n-bridge.test.ts (pure
// function contracts, no DB).

beforeAll(() => {
  process.env.DATABASE_URL ||= 'postgres://stub';
  process.env.JWT_SECRET ||= 'test-jwt-secret';
  process.env.ENCRYPTION_KEY ||= 'a'.repeat(64);
});

async function importLib() {
  return await import('./integration.service');
}

describe('integration.service.validateIntegrationConfig', () => {
  const basic = {
    slug: 'housecall_pro',
    displayName: 'HouseCall Pro',
    supportsOauth: false,
    supportsApiKey: true,
    apiKeyHeaderName: 'Authorization',
  } as const;

  it('passes on API-key-only HCP-shaped config', async () => {
    const { validateIntegrationConfig } = await importLib();
    expect(() => validateIntegrationConfig({ ...basic })).not.toThrow();
  });

  it('passes on OAuth-only QBO-shaped config', async () => {
    const { validateIntegrationConfig } = await importLib();
    expect(() =>
      validateIntegrationConfig({
        slug: 'quickbooks_online',
        displayName: 'QuickBooks Online',
        supportsOauth: true,
        supportsApiKey: false,
        authUrl: 'https://appcenter.intuit.com/connect/oauth2',
        tokenUrl: 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer',
        clientId: 'cid',
        clientSecret: 'csec',
      })
    ).not.toThrow();
  });

  it('passes on both-methods config (HCP after OAuth approval lands)', async () => {
    const { validateIntegrationConfig } = await importLib();
    expect(() =>
      validateIntegrationConfig({
        slug: 'housecall_pro',
        displayName: 'HouseCall Pro',
        supportsOauth: true,
        supportsApiKey: true,
        authUrl: 'https://api.housecallpro.com/oauth/authorize',
        tokenUrl: 'https://api.housecallpro.com/oauth/token',
        clientId: 'cid',
        clientSecret: 'csec',
        apiKeyHeaderName: 'Authorization',
      })
    ).not.toThrow();
  });

  it('rejects rows where neither auth method is enabled', async () => {
    const { validateIntegrationConfig } = await importLib();
    expect(() =>
      validateIntegrationConfig({
        slug: 'x',
        displayName: 'X',
        supportsOauth: false,
        supportsApiKey: false,
      })
    ).toThrow(/at least one/i);
  });

  it('rejects OAuth-enabled rows missing auth_url/token_url/client_id', async () => {
    const { validateIntegrationConfig } = await importLib();
    // AppError carries `code` as a property; the thrown value's .code is
    // the stable identifier callers should branch on. Assert on that.
    try {
      validateIntegrationConfig({
        slug: 'x',
        displayName: 'X',
        supportsOauth: true,
        supportsApiKey: false,
        tokenUrl: 'https://provider.test/token',
        clientId: 'cid',
      });
      expect.fail('should have thrown');
    } catch (err: any) {
      expect(err.code).toBe('OAUTH_CONFIG_INCOMPLETE');
    }
  });

  it('allows OAuth-enabled rows without client_secret (update-preserves-existing)', async () => {
    // On update, an admin who leaves the client_secret field blank is
    // signaling "don't touch the stored secret." validateIntegrationConfig
    // must not reject this case — the service layer threads `undefined`
    // through as "no change."
    const { validateIntegrationConfig } = await importLib();
    expect(() =>
      validateIntegrationConfig({
        slug: 'x',
        displayName: 'X',
        supportsOauth: true,
        supportsApiKey: false,
        authUrl: 'https://provider.test/authorize',
        tokenUrl: 'https://provider.test/token',
        clientId: 'cid',
        // clientSecret intentionally absent
      })
    ).not.toThrow();
  });

  it('rejects api-key-enabled rows missing api_key_header_name', async () => {
    const { validateIntegrationConfig } = await importLib();
    try {
      validateIntegrationConfig({
        slug: 'x',
        displayName: 'X',
        supportsOauth: false,
        supportsApiKey: true,
      });
      expect.fail('should have thrown');
    } catch (err: any) {
      expect(err.code).toBe('API_KEY_CONFIG_INCOMPLETE');
    }
  });

  it('rejects invalid slug shapes', async () => {
    const { validateIntegrationConfig } = await importLib();
    for (const bad of ['Has Spaces', 'Has-Caps', 'has/slash', '']) {
      try {
        validateIntegrationConfig({
          slug: bad,
          displayName: 'X',
          supportsOauth: false,
          supportsApiKey: true,
          apiKeyHeaderName: 'Authorization',
        });
        expect.fail(`should have thrown for slug=${JSON.stringify(bad)}`);
      } catch (err: any) {
        expect(err.code).toBe('INVALID_SLUG');
      }
    }
  });

  it('requires display_name', async () => {
    const { validateIntegrationConfig } = await importLib();
    try {
      validateIntegrationConfig({
        slug: 'x',
        displayName: '',
        supportsOauth: false,
        supportsApiKey: true,
        apiKeyHeaderName: 'Authorization',
      });
      expect.fail('should have thrown');
    } catch (err: any) {
      expect(err.code).toBe('INVALID_DISPLAY_NAME');
    }
  });
});

describe('integration.service.decryptIntegrationClientSecret', () => {
  it('returns empty string when the row has no client_secret', async () => {
    const { decryptIntegrationClientSecret } = await importLib();
    const result = decryptIntegrationClientSecret({
      id: 'abc',
      slug: 'x',
      display_name: 'X',
      icon_url: null,
      status: 'active',
      supports_oauth: true,
      supports_api_key: false,
      auth_url: null,
      token_url: null,
      client_id: null,
      client_secret: null,
      scopes: null,
      extra_authorize_params: {},
      api_key_header_name: null,
      api_key_instructions: null,
      seed_url: null,
      select_table: null,
      created_at: '',
      updated_at: '',
    });
    expect(result).toBe('');
  });

  it('round-trips an encrypted client_secret', async () => {
    const { decryptIntegrationClientSecret } = await importLib();
    const { encryptSecret } = await import('../lib/encrypted-column');
    const encrypted = encryptSecret('my-oauth-client-secret');
    const result = decryptIntegrationClientSecret({
      id: 'abc',
      slug: 'x',
      display_name: 'X',
      icon_url: null,
      status: 'active',
      supports_oauth: true,
      supports_api_key: false,
      auth_url: null,
      token_url: null,
      client_id: null,
      client_secret: encrypted,
      scopes: null,
      extra_authorize_params: {},
      api_key_header_name: null,
      api_key_instructions: null,
      seed_url: null,
      select_table: null,
      created_at: '',
      updated_at: '',
    });
    expect(result).toBe('my-oauth-client-secret');
  });
});
