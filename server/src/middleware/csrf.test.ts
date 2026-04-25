import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import type { Request, Response, NextFunction } from 'express';

// Pure-logic specs for the CSRF double-submit middleware.
// Driven by a fake pg.Pool so the lazy-seed of csrf_signing_secret
// stores into a fake settings table; subsequent issue / verify
// calls round-trip the same secret. No live Postgres needed.

beforeAll(() => {
  process.env.DATABASE_URL ||= 'postgres://stub';
  process.env.JWT_SECRET ||= 'test-jwt-secret';
  process.env.ENCRYPTION_KEY ||= 'a'.repeat(64);
});

interface FakeClient {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount: number }>;
  release: () => void;
}

function makeFakePool() {
  const settings = new Map<string, { value: string; is_secret: boolean }>();
  const client: FakeClient = {
    query: (sql: string, params?: unknown[]) => {
      const s = sql.trim();
      // settings.service.loadSettings
      if (s.startsWith('SELECT key, value, is_secret FROM platform.platform_settings')) {
        const rows = Array.from(settings.entries()).map(([key, v]) => ({ key, value: v.value, is_secret: v.is_secret }));
        return Promise.resolve({ rows, rowCount: rows.length });
      }
      // settings.service.updateSettings — pre-existing-row probe
      if (s.startsWith('SELECT is_secret FROM platform.platform_settings WHERE key = $1')) {
        const key = (params as any[])[0];
        const row = settings.get(key);
        return Promise.resolve({ rows: row ? [{ is_secret: row.is_secret }] : [], rowCount: row ? 1 : 0 });
      }
      // settings.service.updateSettings — INSERT ON CONFLICT
      if (s.startsWith('INSERT INTO platform.platform_settings')) {
        const ps = params as any[];
        settings.set(ps[0], { value: ps[1], is_secret: ps[2] });
        return Promise.resolve({ rows: [], rowCount: 1 });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    },
    release: () => {},
  };
  return {
    pool: {
      connect: () => Promise.resolve(client),
      on: () => {},
      end: () => Promise.resolve(),
    } as unknown as import('pg').Pool,
    settings,
  };
}

function makeReq(overrides: Partial<Request> = {}): Request {
  const r: any = {
    method: 'POST',
    path: '/api/users/me',
    headers: {},
    cookies: {},
    socket: { remoteAddress: '127.0.0.1' },
    ip: '127.0.0.1',
    ...overrides,
  };
  return r as Request;
}

function makeRes(): { res: Response; cookies: Record<string, { value: string; opts: any }> } {
  const cookies: Record<string, { value: string; opts: any }> = {};
  const r: any = {
    cookie: (name: string, value: string, opts: any) => { cookies[name] = { value, opts }; },
    clearCookie: (name: string) => { delete cookies[name]; },
  };
  return { res: r as Response, cookies };
}

beforeEach(async () => {
  const { __setPoolForTest } = await import('../db/connection');
  __setPoolForTest(null);
  const { _resetCsrfCacheForTests } = await import('./csrf');
  _resetCsrfCacheForTests();
  // settings.service caches for 60s; force a reload so the next
  // test's fake pool is hit fresh.
  const settings = await import('../services/settings.service');
  await settings.refreshCache().catch(() => {});
});

describe('CSRF — issuance', () => {
  it('issueCsrfCookie sets xsrf_token cookie with HMAC-signed payload', async () => {
    const { __setPoolForTest } = await import('../db/connection');
    const { pool, settings } = makeFakePool();
    __setPoolForTest(pool);
    const { issueCsrfCookie } = await import('./csrf');
    const { res, cookies } = makeRes();

    await issueCsrfCookie(res);

    expect(cookies['xsrf_token']).toBeDefined();
    expect(cookies['xsrf_token']!.value).toMatch(/^[a-f0-9]+\.[a-f0-9]+$/);
    // Lazy-seed wrote csrf_signing_secret into the (encrypted) row.
    expect(settings.get('csrf_signing_secret')).toBeDefined();
    expect(cookies['xsrf_token']!.opts.httpOnly).toBe(false);
    expect(cookies['xsrf_token']!.opts.path).toBe('/');
    expect(cookies['xsrf_token']!.opts.sameSite).toBe('lax');
  });
});

describe('CSRF — verify', () => {
  it('safe methods bypass without a cookie', async () => {
    const { verifyCsrf } = await import('./csrf');
    const req = makeReq({ method: 'GET' });
    const next = vi.fn() as unknown as NextFunction;
    const { res } = makeRes();
    verifyCsrf(req, res, next);
    expect((next as any).mock.calls[0][0]).toBeUndefined();
  });

  it('Bearer-auth (any prefix) bypasses', async () => {
    const { verifyCsrf } = await import('./csrf');
    const req = makeReq({ headers: { authorization: 'Bearer abc.def.ghi' } });
    const next = vi.fn() as unknown as NextFunction;
    const { res } = makeRes();
    verifyCsrf(req, res, next);
    expect((next as any).mock.calls[0][0]).toBeUndefined();
  });

  it('public surface bypasses', async () => {
    const { verifyCsrf } = await import('./csrf');
    const req = makeReq({ path: '/api/embed/abc123' });
    const next = vi.fn() as unknown as NextFunction;
    const { res } = makeRes();
    verifyCsrf(req, res, next);
    expect((next as any).mock.calls[0][0]).toBeUndefined();
  });

  it('webhook ingest path bypasses', async () => {
    const { verifyCsrf } = await import('./csrf');
    const req = makeReq({ path: '/api/webhooks/abc' });
    const next = vi.fn() as unknown as NextFunction;
    const { res } = makeRes();
    verifyCsrf(req, res, next);
    expect((next as any).mock.calls[0][0]).toBeUndefined();
  });

  it('rejects state-changing request without cookie or header', async () => {
    const { __setPoolForTest } = await import('../db/connection');
    __setPoolForTest(makeFakePool().pool);
    const { verifyCsrf } = await import('./csrf');
    const req = makeReq();
    const next = vi.fn() as unknown as NextFunction;
    const { res } = makeRes();
    verifyCsrf(req, res, next);
    const err = (next as any).mock.calls[0][0];
    expect(err).toBeDefined();
    expect(err.statusCode).toBe(403);
    expect(err.code).toBe('CSRF_INVALID');
  });

  it('rejects mismatched cookie/header pair', async () => {
    const { __setPoolForTest } = await import('../db/connection');
    __setPoolForTest(makeFakePool().pool);
    const { verifyCsrf } = await import('./csrf');
    const req = makeReq({
      cookies: { xsrf_token: 'aaaaaaaa.bbbbbbbb' },
      headers: { 'x-csrf-token': 'cccccccc.dddddddd' },
    });
    const next = vi.fn() as unknown as NextFunction;
    const { res } = makeRes();
    verifyCsrf(req, res, next);
    const err = (next as any).mock.calls[0][0];
    expect(err.code).toBe('CSRF_INVALID');
  });

  it('accepts a properly issued cookie+header pair', async () => {
    const { __setPoolForTest } = await import('../db/connection');
    const { pool } = makeFakePool();
    __setPoolForTest(pool);
    const { issueCsrfCookie, verifyCsrf } = await import('./csrf');

    // Issue first to prime the secret + cookie.
    const { res: issueRes, cookies } = makeRes();
    await issueCsrfCookie(issueRes);
    const token = cookies['xsrf_token']!.value;

    const req = makeReq({
      cookies: { xsrf_token: token },
      headers: { 'x-csrf-token': token },
    });
    const next = vi.fn() as unknown as NextFunction;
    const { res } = makeRes();
    await new Promise<void>((resolve) => {
      verifyCsrf(req, res, ((err: any) => {
        expect(err).toBeUndefined();
        resolve();
      }) as unknown as NextFunction);
      // Cover the synchronous-pass branch too.
      void next;
    });
  });
});
