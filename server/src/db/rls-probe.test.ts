import { describe, it, expect, beforeAll, afterAll } from 'vitest';

// Integration-style probe for cross-tenant RLS isolation. Exercises the
// withTenantContext / withAdminClient helpers against a real Postgres
// instance and asserts that tenant A's context cannot see tenant B's
// rows across every RLS-enabled tenant-scoped table.
//
// Skipped by default so `npm test` stays DB-free. To run:
//
//   PROBE_RLS=1 DATABASE_URL=postgres://xray:xray@localhost:5432/xray \
//     npx vitest run src/db/rls-probe.test.ts
//
// Matches the SQL acceptance probe at migrations/probes/probe-rls-cross-tenant.sql
// but drives it through the application's helpers — so the probe also
// catches helpers that forget to clear the admin bypass on a
// withTenantContext checkout.
//
// Leaves no residue: every INSERT happens in a transaction that rolls
// back, or is explicitly DELETEd in the finally block.

const shouldRun = process.env.PROBE_RLS === '1' && !!process.env.DATABASE_URL;
const maybe = shouldRun ? describe : describe.skip;

const TENANT_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

beforeAll(() => {
  process.env.JWT_SECRET ||= 'probe-jwt-secret';
  process.env.ENCRYPTION_KEY ||= 'a'.repeat(64);
});

async function importDb() {
  return await import('./connection');
}

async function setup(): Promise<{ dashA: string; dashB: string; connA: string; connB: string }> {
  const { withAdminClient } = await importDb();
  return withAdminClient(async (client) => {
    await client.query(
      `INSERT INTO platform.tenants (id, name, slug) VALUES
         ($1, 'Probe A', 'probe-a-' || substr(md5(random()::text), 1, 6)),
         ($2, 'Probe B', 'probe-b-' || substr(md5(random()::text), 1, 6))
       ON CONFLICT (id) DO NOTHING`,
      [TENANT_A, TENANT_B]
    );
    const dashA = (await client.query(
      `INSERT INTO platform.dashboards (tenant_id, name) VALUES ($1, 'probe-dash-a') RETURNING id`,
      [TENANT_A]
    )).rows[0].id;
    const dashB = (await client.query(
      `INSERT INTO platform.dashboards (tenant_id, name) VALUES ($1, 'probe-dash-b') RETURNING id`,
      [TENANT_B]
    )).rows[0].id;
    const connA = (await client.query(
      `INSERT INTO platform.connections (tenant_id, name, source_type, pipeline_ref)
       VALUES ($1, 'probe-conn-a', 'http', 'probe.a') RETURNING id`,
      [TENANT_A]
    )).rows[0].id;
    const connB = (await client.query(
      `INSERT INTO platform.connections (tenant_id, name, source_type, pipeline_ref)
       VALUES ($1, 'probe-conn-b', 'http', 'probe.b') RETURNING id`,
      [TENANT_B]
    )).rows[0].id;
    return { dashA, dashB, connA, connB };
  });
}

async function cleanup(): Promise<void> {
  const { withAdminClient } = await importDb();
  await withAdminClient(async (client) => {
    await client.query(`DELETE FROM platform.dashboards WHERE tenant_id IN ($1, $2)`, [TENANT_A, TENANT_B]);
    await client.query(`DELETE FROM platform.connections WHERE tenant_id IN ($1, $2)`, [TENANT_A, TENANT_B]);
    await client.query(`DELETE FROM platform.users WHERE tenant_id IN ($1, $2) AND email LIKE 'probe-%'`, [TENANT_A, TENANT_B]);
    await client.query(`DELETE FROM platform.tenants WHERE id IN ($1, $2)`, [TENANT_A, TENANT_B]);
  }).then(async () => {
    const { closePool } = await importDb();
    await closePool();
  });
}

maybe('db/rls-probe — cross-tenant isolation', () => {
  let fixture: { dashA: string; dashB: string; connA: string; connB: string };

  beforeAll(async () => {
    fixture = await setup();
  });

  afterAll(async () => {
    await cleanup();
  });

  it('withTenantContext(A) sees only A dashboards', async () => {
    const { withTenantContext } = await importDb();
    const rows = await withTenantContext(TENANT_A, async (c) => {
      return (await c.query(
        `SELECT id, tenant_id FROM platform.dashboards WHERE name LIKE 'probe-dash-%'`
      )).rows;
    });
    expect(rows.length).toBe(1);
    expect(rows[0].id).toBe(fixture.dashA);
    expect(rows[0].tenant_id).toBe(TENANT_A);
  });

  it('withTenantContext(B) sees only B dashboards', async () => {
    const { withTenantContext } = await importDb();
    const rows = await withTenantContext(TENANT_B, async (c) => {
      return (await c.query(
        `SELECT id, tenant_id FROM platform.dashboards WHERE name LIKE 'probe-dash-%'`
      )).rows;
    });
    expect(rows.length).toBe(1);
    expect(rows[0].id).toBe(fixture.dashB);
  });

  it('withTenantContext(A) sees only A connections', async () => {
    const { withTenantContext } = await importDb();
    const rows = await withTenantContext(TENANT_A, async (c) => {
      return (await c.query(
        `SELECT tenant_id FROM platform.connections WHERE name LIKE 'probe-conn-%'`
      )).rows;
    });
    expect(rows.length).toBe(1);
    expect(rows[0].tenant_id).toBe(TENANT_A);
  });

  it('withTenantContext(A) sees only A render cache rows', async () => {
    const { withTenantContext, withAdminClient } = await importDb();
    await withAdminClient(async (c) => {
      await c.query(
        `INSERT INTO platform.dashboard_render_cache (dashboard_id, tenant_id, view_html)
         VALUES ($1, $2, '<a/>'), ($3, $4, '<b/>')
         ON CONFLICT (dashboard_id, tenant_id) DO UPDATE SET view_html = EXCLUDED.view_html`,
        [fixture.dashA, TENANT_A, fixture.dashB, TENANT_B]
      );
    });
    const rows = await withTenantContext(TENANT_A, async (c) => {
      return (await c.query(
        `SELECT tenant_id FROM platform.dashboard_render_cache WHERE dashboard_id IN ($1, $2)`,
        [fixture.dashA, fixture.dashB]
      )).rows;
    });
    expect(rows.length).toBe(1);
    expect(rows[0].tenant_id).toBe(TENANT_A);
  });

  it('withTenantContext(A) sees only A dashboard_shares rows', async () => {
    const { withTenantContext, withAdminClient } = await importDb();
    await withAdminClient(async (c) => {
      await c.query(
        `INSERT INTO platform.dashboard_shares (dashboard_id, tenant_id, public_token, is_public)
         VALUES ($1, $2, $3, true), ($4, $5, $6, true)
         ON CONFLICT (dashboard_id, tenant_id) DO UPDATE SET public_token = EXCLUDED.public_token`,
        [
          fixture.dashA, TENANT_A, 'probe-share-a-' + Date.now(),
          fixture.dashB, TENANT_B, 'probe-share-b-' + Date.now(),
        ]
      );
    });
    const rows = await withTenantContext(TENANT_A, async (c) => {
      return (await c.query(
        `SELECT tenant_id FROM platform.dashboard_shares WHERE dashboard_id IN ($1, $2)`,
        [fixture.dashA, fixture.dashB]
      )).rows;
    });
    expect(rows.length).toBe(1);
    expect(rows[0].tenant_id).toBe(TENANT_A);
  });

  it('withTenantContext(A) sees transitive connection_comments only for A connections', async () => {
    const { withTenantContext, withAdminClient } = await importDb();
    await withAdminClient(async (c) => {
      await c.query(
        `INSERT INTO platform.connection_comments (connection_id, content)
         VALUES ($1, 'probe-comment-a'), ($2, 'probe-comment-b')`,
        [fixture.connA, fixture.connB]
      );
    });
    const rows = await withTenantContext(TENANT_A, async (c) => {
      return (await c.query(
        `SELECT connection_id FROM platform.connection_comments WHERE content LIKE 'probe-comment-%'`
      )).rows;
    });
    expect(rows.length).toBe(1);
    expect(rows[0].connection_id).toBe(fixture.connA);
  });

  it('tenant_notes is invisible in tenant context (admin-only)', async () => {
    const { withTenantContext, withAdminClient } = await importDb();
    // Need a user to satisfy author_id FK
    const userId = (await withAdminClient(async (c) => {
      const roleId = (await c.query(`SELECT id FROM platform.roles LIMIT 1`)).rows[0].id;
      return (await c.query(
        `INSERT INTO platform.users (tenant_id, email, role_id, status)
         VALUES ($1, 'probe-note-author@example.test', $2, 'active') RETURNING id`,
        [TENANT_A, roleId]
      )).rows[0].id;
    })) as string;
    await withAdminClient(async (c) => {
      await c.query(
        `INSERT INTO platform.tenant_notes (tenant_id, author_id, content)
         VALUES ($1, $2, 'probe-note')`,
        [TENANT_A, userId]
      );
    });
    const rows = await withTenantContext(TENANT_A, async (c) => {
      return (await c.query(
        `SELECT id FROM platform.tenant_notes WHERE content = 'probe-note'`
      )).rows;
    });
    expect(rows.length).toBe(0);
  });

  it('withAdminClient sees both tenants rows', async () => {
    const { withAdminClient } = await importDb();
    const rows = await withAdminClient(async (c) => {
      return (await c.query(
        `SELECT tenant_id FROM platform.dashboards WHERE name LIKE 'probe-dash-%' ORDER BY tenant_id`
      )).rows;
    });
    expect(rows.length).toBe(2);
    expect(rows[0].tenant_id).toBe(TENANT_A);
    expect(rows[1].tenant_id).toBe(TENANT_B);
  });
});
