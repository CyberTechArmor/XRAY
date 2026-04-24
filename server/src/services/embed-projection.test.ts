import { describe, it, expect, beforeAll } from 'vitest';

// Pure-logic spec for step 7 (C1). Locks the embed endpoint's
// projected column list so it never accidentally starts surfacing
// upstream-fetch config again. An embed token is a render capability,
// not a config-disclosure one.

beforeAll(() => {
  process.env.DATABASE_URL ||= 'postgres://stub';
  process.env.JWT_SECRET ||= 'test-jwt-secret';
  process.env.ENCRYPTION_KEY ||= 'a'.repeat(64);
});

describe('dashboard.service EMBED_PROJECTED_COLUMNS', () => {
  it('excludes every upstream-fetch config column', async () => {
    const { EMBED_PROJECTED_COLUMNS } = await import('./dashboard.service');
    const forbidden = [
      'fetch_url',
      'fetch_method',
      'fetch_headers',
      'fetch_query_params',
      'fetch_body',
      'bridge_secret',
      // Legacy columns — embed has no business carrying raw params
      // payload either; the render path does server-side substitution.
      'params',
    ];
    for (const col of forbidden) {
      expect(
        EMBED_PROJECTED_COLUMNS.includes(col as never),
        `EMBED_PROJECTED_COLUMNS must not include "${col}"`
      ).toBe(false);
    }
  });

  it('includes the render-essential columns', async () => {
    const { EMBED_PROJECTED_COLUMNS } = await import('./dashboard.service');
    const required = [
      'id', 'tenant_id', 'name', 'status', 'scope',
      'view_html', 'view_css', 'view_js',
    ];
    for (const col of required) {
      expect(
        EMBED_PROJECTED_COLUMNS.includes(col as never),
        `EMBED_PROJECTED_COLUMNS must include "${col}"`
      ).toBe(true);
    }
  });
});
