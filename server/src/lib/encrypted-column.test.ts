import { describe, it, expect, beforeAll } from 'vitest';

// ENCRYPTION_KEY must be set before importing modules that read config.
beforeAll(() => {
  process.env.DATABASE_URL ||= 'postgres://stub';
  process.env.JWT_SECRET ||= 'test-jwt-secret';
  process.env.ENCRYPTION_KEY ||= 'a'.repeat(64);
});

async function importLib() {
  return await import('./encrypted-column');
}

describe('encrypted-column', () => {
  it('round-trips a string secret', async () => {
    const { encryptSecret, decryptSecret } = await importLib();
    const ct = encryptSecret('hunter2');
    expect(ct).toMatch(/^enc:v1:/);
    expect(decryptSecret(ct, 'test:col:row1')).toBe('hunter2');
  });

  it('re-encrypting an already-encrypted value is a no-op', async () => {
    const { encryptSecret } = await importLib();
    const once = encryptSecret('hunter2');
    const twice = encryptSecret(once);
    expect(twice).toBe(once);
  });

  it('handles null and empty for strings', async () => {
    const { encryptSecret, decryptSecret } = await importLib();
    expect(encryptSecret(null)).toBeNull();
    expect(encryptSecret(undefined)).toBeNull();
    expect(encryptSecret('')).toBe('');
    expect(decryptSecret(null, 'x')).toBeNull();
    expect(decryptSecret('', 'x')).toBe('');
  });

  it('rejects plaintext input with a loud error', async () => {
    // Step 6 (v): plaintext pass-through fallback retired. Any row
    // reaching decrypt without the enc:v1: envelope is a bug signal.
    const { decryptSecret } = await importLib();
    expect(() => decryptSecret('plain-value', 'webhooks:secret:abc'))
      .toThrow(/plaintext row detected/);
    expect(() => decryptSecret('plain-value', 'webhooks:secret:abc'))
      .toThrow(/webhooks:secret:abc/);
  });

  it('rejects string missing the prefix even if it looks encrypted', async () => {
    const { decryptSecret } = await importLib();
    expect(() => decryptSecret('enc:v0:legacy', 'x')).toThrow(/plaintext row detected/);
  });

  it('tampered ciphertext throws', async () => {
    const { encryptSecret, decryptSecret } = await importLib();
    const ct = encryptSecret('hunter2')!;
    const tampered = ct.slice(0, -4) + 'AAAA';
    expect(() => decryptSecret(tampered, 'x')).toThrow();
  });

  it('round-trips a JSON field object', async () => {
    const { encryptJsonField, decryptJsonField } = await importLib();
    const input = { Authorization: 'Bearer abc123', 'X-Foo': 'bar' };
    const stored = encryptJsonField(input);
    expect(stored).toHaveProperty('_enc');
    expect((stored as { _enc: string })._enc).toMatch(/^enc:v1:/);
    expect(decryptJsonField(stored, 'dashboards:fetch_headers:row1')).toEqual(input);
  });

  it('JSON: empty object is passed through unchanged', async () => {
    const { encryptJsonField, decryptJsonField } = await importLib();
    expect(encryptJsonField({})).toEqual({});
    expect(decryptJsonField({}, 'x')).toEqual({});
  });

  it('JSON: null input returns null/empty safely', async () => {
    const { encryptJsonField, decryptJsonField } = await importLib();
    expect(encryptJsonField(null)).toBeNull();
    expect(decryptJsonField(null, 'x')).toEqual({});
  });

  it('JSON: already-encrypted payload is not double-wrapped', async () => {
    const { encryptJsonField } = await importLib();
    const once = encryptJsonField({ token: 'xyz' });
    const twice = encryptJsonField(once as Record<string, unknown>);
    expect(twice).toEqual(once);
  });

  it('JSON: rejects non-empty plaintext object', async () => {
    // Step 6 (v): any JSON field with user keys instead of a single
    // enc:v1: envelope is a bug signal; throw instead of returning it.
    const { decryptJsonField } = await importLib();
    expect(() =>
      decryptJsonField({ Authorization: 'Bearer plain' }, 'dashboards:fetch_headers:rowX')
    ).toThrow(/plaintext JSON object detected/);
  });

  it('JSON: accepts string input (pg JSONB serialized as text)', async () => {
    const { encryptJsonField, decryptJsonField } = await importLib();
    const stored = encryptJsonField({ k: 'v' });
    const asString = JSON.stringify(stored);
    expect(decryptJsonField(asString, 'x')).toEqual({ k: 'v' });
  });
});
