import { describe, expect, it } from 'vitest';
import jwt from 'jsonwebtoken';
import {
  FAN_OUT_AUDIENCE,
  FAN_OUT_ISSUER,
  generateFanOutSecret,
  mintFanOutJwt,
  verifyFanOutJwtForTest,
} from './fan-out-jwt';

const SECRET = 'unit-test-shared-secret';

function baseInput() {
  return {
    tenantId: '11111111-1111-1111-1111-111111111111',
    tenantSlug: 'acme',
    integrationSlug: 'housecall_pro',
    fanOutId: '22222222-2222-2222-2222-222222222222',
    secret: SECRET,
    authMethod: 'oauth' as const,
    accessToken: 'oauth-access-token-plaintext',
  };
}

describe('mintFanOutJwt', () => {
  it('mints a HS256 token with the committed claim shape', () => {
    const result = mintFanOutJwt(baseInput());
    const payload = verifyFanOutJwtForTest(result.jwt, SECRET);
    expect(payload.iss).toBe(FAN_OUT_ISSUER);
    expect(payload.aud).toBe(FAN_OUT_AUDIENCE);
    expect(payload.sub).toBe('11111111-1111-1111-1111-111111111111');
    expect(payload.tenant_id).toBe('11111111-1111-1111-1111-111111111111');
    expect(payload.tenant_slug).toBe('acme');
    expect(payload.integration).toBe('housecall_pro');
    expect(payload.fan_out_id).toBe('22222222-2222-2222-2222-222222222222');
    expect(payload.auth_method).toBe('oauth');
    expect(payload.access_token).toBe('oauth-access-token-plaintext');
    expect(typeof payload.jti).toBe('string');
    expect(typeof payload.iat).toBe('number');
    expect(typeof payload.exp).toBe('number');
    expect(payload.exp! - payload.iat!).toBe(60);
  });

  it('keeps sub in lockstep with tenant_id', () => {
    const result = mintFanOutJwt({ ...baseInput(), tenantId: '33333333-3333-3333-3333-333333333333' });
    const payload = verifyFanOutJwtForTest(result.jwt, SECRET);
    expect(payload.sub).toBe(payload.tenant_id);
  });

  it('uses the correct audience — not n8n and not xray-pipeline', () => {
    const result = mintFanOutJwt(baseInput());
    // Reject the bridge audience.
    expect(() =>
      jwt.verify(result.jwt, SECRET, {
        algorithms: ['HS256'],
        issuer: FAN_OUT_ISSUER,
        audience: 'n8n',
      })
    ).toThrow();
    // Reject the pipeline audience.
    expect(() =>
      jwt.verify(result.jwt, SECRET, {
        algorithms: ['HS256'],
        issuer: FAN_OUT_ISSUER,
        audience: 'xray-pipeline',
      })
    ).toThrow();
    // Accept the fan-out audience.
    expect(() => verifyFanOutJwtForTest(result.jwt, SECRET)).not.toThrow();
  });

  it('rejects verification under the wrong secret', () => {
    const result = mintFanOutJwt(baseInput());
    expect(() => verifyFanOutJwtForTest(result.jwt, 'different-secret')).toThrow();
  });

  it('generates unique jti per mint', () => {
    const a = mintFanOutJwt(baseInput());
    const b = mintFanOutJwt(baseInput());
    expect(a.jti).not.toBe(b.jti);
  });

  it('omits window/metadata from the payload when unset or empty', () => {
    const result = mintFanOutJwt(baseInput());
    const payload = verifyFanOutJwtForTest(result.jwt, SECRET);
    expect(payload.window).toBeUndefined();
    expect(payload.metadata).toBeUndefined();
  });

  it('passes through window and metadata when the caller supplied them', () => {
    const result = mintFanOutJwt({
      ...baseInput(),
      window: { since: '2026-04-21T00:00:00Z' },
      metadata: { requested_by: 'n8n-cron:daily' },
    });
    const payload = verifyFanOutJwtForTest(result.jwt, SECRET);
    expect(payload.window).toEqual({ since: '2026-04-21T00:00:00Z' });
    expect(payload.metadata).toEqual({ requested_by: 'n8n-cron:daily' });
  });

  it('carries auth_method=api_key + the static key as access_token when that flavor is used', () => {
    const result = mintFanOutJwt({
      ...baseInput(),
      authMethod: 'api_key',
      accessToken: 'static-api-key-plaintext',
    });
    const payload = verifyFanOutJwtForTest(result.jwt, SECRET);
    expect(payload.auth_method).toBe('api_key');
    expect(payload.access_token).toBe('static-api-key-plaintext');
  });

  it('throws on missing required fields', () => {
    expect(() => mintFanOutJwt({ ...baseInput(), tenantId: '' })).toThrow();
    expect(() => mintFanOutJwt({ ...baseInput(), integrationSlug: '' })).toThrow();
    expect(() => mintFanOutJwt({ ...baseInput(), fanOutId: '' })).toThrow();
    expect(() => mintFanOutJwt({ ...baseInput(), secret: '' })).toThrow();
    expect(() => mintFanOutJwt({ ...baseInput(), accessToken: '' })).toThrow();
  });
});

describe('generateFanOutSecret', () => {
  it('returns a 64-char base64url string suitable as an HS256 secret', () => {
    const s = generateFanOutSecret();
    expect(s).toMatch(/^[A-Za-z0-9_-]{64}$/);
  });

  it('returns a different value each call', () => {
    expect(generateFanOutSecret()).not.toBe(generateFanOutSecret());
  });
});
