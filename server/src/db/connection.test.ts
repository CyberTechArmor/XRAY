import { describe, it, expect, beforeAll, beforeEach } from 'vitest';

// Unit test for the db connection helpers. Uses a fake Pool to assert
// the set_config calls each helper emits before handing the client
// back to user code. No live Postgres required.

beforeAll(() => {
  process.env.DATABASE_URL ||= 'postgres://stub';
  process.env.JWT_SECRET ||= 'test-jwt-secret';
  process.env.ENCRYPTION_KEY ||= 'a'.repeat(64);
});

type Logged = { sql: string; params?: unknown[] };

function makeFakePool() {
  const queries: Logged[] = [];
  let releaseCount = 0;
  const client = {
    query: (sql: string, params?: unknown[]) => {
      queries.push({ sql, params });
      return Promise.resolve({ rows: [] });
    },
    release: () => {
      releaseCount++;
    },
  };
  return {
    pool: {
      connect: () => Promise.resolve(client),
      on: () => {},
      end: () => Promise.resolve(),
    } as unknown as import('pg').Pool,
    queries,
    getReleaseCount: () => releaseCount,
  };
}

async function importLib() {
  return await import('./connection');
}

describe('db/connection', () => {
  beforeEach(async () => {
    const { __setPoolForTest } = await importLib();
    __setPoolForTest(null);
  });

  it('withClient sets no context and releases the client', async () => {
    const { withClient, __setPoolForTest } = await importLib();
    const { pool, queries, getReleaseCount } = makeFakePool();
    __setPoolForTest(pool);

    await withClient(async (c) => {
      await c.query('SELECT 1');
    });

    expect(queries.map((q) => q.sql)).toEqual(['SELECT 1']);
    expect(getReleaseCount()).toBe(1);
  });

  it('withTenantContext sets current_tenant and clears is_platform_admin', async () => {
    const { withTenantContext, __setPoolForTest } = await importLib();
    const { pool, queries } = makeFakePool();
    __setPoolForTest(pool);

    await withTenantContext('11111111-1111-1111-1111-111111111111', async (c) => {
      await c.query('SELECT 1');
    });

    expect(queries).toHaveLength(3);
    expect(queries[0].sql).toMatch(/set_config\('app\.current_tenant'/);
    expect(queries[0].params).toEqual(['11111111-1111-1111-1111-111111111111']);
    expect(queries[1].sql).toMatch(/set_config\('app\.is_platform_admin', 'false'/);
    expect(queries[2].sql).toBe('SELECT 1');
  });

  it('withAdminClient sets is_platform_admin=true and nothing else', async () => {
    const { withAdminClient, __setPoolForTest } = await importLib();
    const { pool, queries } = makeFakePool();
    __setPoolForTest(pool);

    await withAdminClient(async (c) => {
      await c.query('SELECT 1');
    });

    expect(queries).toHaveLength(2);
    expect(queries[0].sql).toMatch(/set_config\('app\.is_platform_admin', 'true'/);
    expect(queries[1].sql).toBe('SELECT 1');
  });

  it('withTenantTransaction wraps in BEGIN/COMMIT with tenant context', async () => {
    const { withTenantTransaction, __setPoolForTest } = await importLib();
    const { pool, queries } = makeFakePool();
    __setPoolForTest(pool);

    await withTenantTransaction('22222222-2222-2222-2222-222222222222', async (c) => {
      await c.query('SELECT 1');
    });

    expect(queries[0].sql).toBe('BEGIN');
    expect(queries[1].sql).toMatch(/set_config\('app\.current_tenant'/);
    expect(queries[1].params).toEqual(['22222222-2222-2222-2222-222222222222']);
    expect(queries[2].sql).toMatch(/set_config\('app\.is_platform_admin', 'false'/);
    expect(queries[3].sql).toBe('SELECT 1');
    expect(queries[4].sql).toBe('COMMIT');
  });

  it('withAdminTransaction wraps in BEGIN/COMMIT with admin bypass', async () => {
    const { withAdminTransaction, __setPoolForTest } = await importLib();
    const { pool, queries } = makeFakePool();
    __setPoolForTest(pool);

    await withAdminTransaction(async (c) => {
      await c.query('SELECT 1');
    });

    expect(queries[0].sql).toBe('BEGIN');
    expect(queries[1].sql).toMatch(/set_config\('app\.is_platform_admin', 'true'/);
    expect(queries[2].sql).toBe('SELECT 1');
    expect(queries[3].sql).toBe('COMMIT');
  });

  it('withTransaction rolls back on throw', async () => {
    const { withTransaction, __setPoolForTest } = await importLib();
    const { pool, queries } = makeFakePool();
    __setPoolForTest(pool);

    await expect(
      withTransaction(async () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');

    expect(queries.map((q) => q.sql)).toEqual(['BEGIN', 'ROLLBACK']);
  });
});
