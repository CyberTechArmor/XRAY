import { describe, it, expect, beforeAll } from 'vitest';

// Pure-logic specs for auth.service helpers. Follows the pattern in
// fan-out.service.test.ts / oauth-scheduler.test.ts: lock the
// contracts that don't need Postgres. DB-backed flows (verifyCode,
// completeSignup) are covered by route-level integration tests.

beforeAll(() => {
  process.env.DATABASE_URL ||= 'postgres://stub';
  process.env.JWT_SECRET ||= 'test-jwt-secret';
  process.env.ENCRYPTION_KEY ||= 'a'.repeat(64);
});

async function importLib() {
  return await import('./auth.service');
}

describe('auth.service.normalizeSlug', () => {
  it('lowercases and replaces non-alphanumerics with hyphens', async () => {
    const { normalizeSlug } = await importLib();
    expect(normalizeSlug('Acme Corp')).toBe('acme-corp');
    expect(normalizeSlug('ACME')).toBe('acme');
  });

  it('collapses runs of non-alphanumerics into a single hyphen', async () => {
    const { normalizeSlug } = await importLib();
    expect(normalizeSlug('Acme   Corp')).toBe('acme-corp');
    expect(normalizeSlug('Acme...Corp')).toBe('acme-corp');
    expect(normalizeSlug('Acme & Co')).toBe('acme-co');
  });

  it('strips leading and trailing hyphens', async () => {
    const { normalizeSlug } = await importLib();
    expect(normalizeSlug('  Acme Corp  ')).toBe('acme-corp');
    expect(normalizeSlug('!!Acme!!')).toBe('acme');
  });

  it('collapses distinct display names to the same slug when they differ only by punctuation', async () => {
    // This is the case the SLUG_TAKEN error defends against: two
    // signups with different displayable names can hit the same slug.
    const { normalizeSlug } = await importLib();
    expect(normalizeSlug('Acme Corp')).toBe(normalizeSlug('Acme, Corp!'));
    expect(normalizeSlug('Blue Co')).toBe(normalizeSlug('Blue.Co'));
  });

  it('returns empty string for input with no alphanumerics', async () => {
    // Empty slug is the signal for INVALID_TENANT_NAME in
    // initiateSignup / completeSignup / firstBootSetup.
    const { normalizeSlug } = await importLib();
    expect(normalizeSlug('!!!')).toBe('');
    expect(normalizeSlug('   ')).toBe('');
    expect(normalizeSlug('')).toBe('');
  });

  it('preserves digits', async () => {
    const { normalizeSlug } = await importLib();
    expect(normalizeSlug('Acme 2026')).toBe('acme-2026');
    expect(normalizeSlug('24/7 Plumbing')).toBe('24-7-plumbing');
  });
});
