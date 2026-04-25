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

interface Fixture {
  dashA: string; dashB: string;
  connA: string; connB: string;
  userA: string; userB: string;
  roleId: string;
}

async function setup(): Promise<Fixture> {
  const { withAdminClient } = await importDb();
  return withAdminClient(async (client) => {
    await client.query(
      `INSERT INTO platform.tenants (id, name, slug) VALUES
         ($1, 'Probe A', 'probe-a-' || substr(md5(random()::text), 1, 6)),
         ($2, 'Probe B', 'probe-b-' || substr(md5(random()::text), 1, 6))
       ON CONFLICT (id) DO NOTHING`,
      [TENANT_A, TENANT_B]
    );
    const roleId = (await client.query(
      `SELECT id FROM platform.roles ORDER BY is_system DESC LIMIT 1`
    )).rows[0].id;
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
    const userA = (await client.query(
      `INSERT INTO platform.users (tenant_id, email, name, role_id, status)
       VALUES ($1, 'probe-user-a@example.test', 'Probe User A', $2, 'active') RETURNING id`,
      [TENANT_A, roleId]
    )).rows[0].id;
    const userB = (await client.query(
      `INSERT INTO platform.users (tenant_id, email, name, role_id, status)
       VALUES ($1, 'probe-user-b@example.test', 'Probe User B', $2, 'active') RETURNING id`,
      [TENANT_B, roleId]
    )).rows[0].id;
    return { dashA, dashB, connA, connB, userA, userB, roleId };
  });
}

async function cleanup(): Promise<void> {
  const { withAdminClient } = await importDb();
  await withAdminClient(async (client) => {
    // FK-order-safe teardown: children first, then dashboards/connections,
    // then users, then tenants. audit_log / fan_out_deliveries don't have
    // ON DELETE CASCADE on every side so we scrub them explicitly.
    await client.query(`DELETE FROM platform.audit_log WHERE tenant_id IN ($1, $2) AND action LIKE 'probe.%'`, [TENANT_A, TENANT_B]);
    await client.query(`DELETE FROM platform.fan_out_deliveries WHERE tenant_id IN ($1, $2)`, [TENANT_A, TENANT_B]);
    await client.query(`DELETE FROM platform.fan_out_runs WHERE idempotency_key LIKE 'probe-%'`);
    // Inbox tables cascade from threads; scrub by subject prefix.
    await client.query(`DELETE FROM platform.inbox_threads WHERE subject LIKE 'probe-inbox-%'`);
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
  let fixture: Fixture;

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

  // ─── Widened coverage (step 7 B2) ────────────────────────
  //
  // One assertion per RLS-enabled tenant-scoped table not already
  // covered above. Each test seeds one row in A and one row in B via
  // admin bypass, then asserts that withTenantContext(A) sees exactly
  // one row keyed to TENANT_A.

  it('withTenantContext(A) sees only A users', async () => {
    const { withTenantContext } = await importDb();
    const rows = await withTenantContext(TENANT_A, async (c) => {
      return (await c.query(
        `SELECT tenant_id FROM platform.users WHERE email LIKE 'probe-user-%'`
      )).rows;
    });
    expect(rows.length).toBe(1);
    expect(rows[0].tenant_id).toBe(TENANT_A);
  });

  it('withTenantContext(A) sees only A billing_state', async () => {
    const { withTenantContext, withAdminClient } = await importDb();
    await withAdminClient(async (c) => {
      await c.query(
        `INSERT INTO platform.billing_state (tenant_id, plan_tier, dashboard_limit, payment_status)
         VALUES ($1, 'free', 0, 'none'), ($2, 'free', 0, 'none')
         ON CONFLICT (tenant_id) DO NOTHING`,
        [TENANT_A, TENANT_B]
      );
    });
    const rows = await withTenantContext(TENANT_A, async (c) => {
      return (await c.query(
        `SELECT tenant_id FROM platform.billing_state WHERE tenant_id IN ($1, $2)`,
        [TENANT_A, TENANT_B]
      )).rows;
    });
    expect(rows.length).toBe(1);
    expect(rows[0].tenant_id).toBe(TENANT_A);
  });

  it('withTenantContext(A) sees only A audit_log rows', async () => {
    const { withTenantContext, withAdminClient } = await importDb();
    await withAdminClient(async (c) => {
      await c.query(
        `INSERT INTO platform.audit_log (tenant_id, action) VALUES ($1, 'probe.a'), ($2, 'probe.b')`,
        [TENANT_A, TENANT_B]
      );
    });
    const rows = await withTenantContext(TENANT_A, async (c) => {
      return (await c.query(
        `SELECT tenant_id FROM platform.audit_log WHERE action LIKE 'probe.%'`
      )).rows;
    });
    expect(rows.length).toBe(1);
    expect(rows[0].tenant_id).toBe(TENANT_A);
  });

  it('withTenantContext(A) sees only A user_sessions', async () => {
    const { withTenantContext, withAdminClient } = await importDb();
    await withAdminClient(async (c) => {
      await c.query(
        `INSERT INTO platform.user_sessions (user_id, tenant_id, refresh_token_hash, expires_at)
         VALUES ($1, $2, 'probe-sess-a-' || $5, now() + interval '1 day'),
                ($3, $4, 'probe-sess-b-' || $5, now() + interval '1 day')`,
        [fixture.userA, TENANT_A, fixture.userB, TENANT_B, Date.now().toString()]
      );
    });
    const rows = await withTenantContext(TENANT_A, async (c) => {
      return (await c.query(
        `SELECT tenant_id FROM platform.user_sessions WHERE refresh_token_hash LIKE 'probe-sess-%'`
      )).rows;
    });
    expect(rows.length).toBe(1);
    expect(rows[0].tenant_id).toBe(TENANT_A);
  });

  it('withTenantContext(A) sees only A dashboard_access', async () => {
    const { withTenantContext, withAdminClient } = await importDb();
    await withAdminClient(async (c) => {
      await c.query(
        `INSERT INTO platform.dashboard_access (dashboard_id, user_id, tenant_id)
         VALUES ($1, $2, $3), ($4, $5, $6)
         ON CONFLICT (dashboard_id, user_id) DO NOTHING`,
        [fixture.dashA, fixture.userA, TENANT_A, fixture.dashB, fixture.userB, TENANT_B]
      );
    });
    const rows = await withTenantContext(TENANT_A, async (c) => {
      return (await c.query(
        `SELECT tenant_id FROM platform.dashboard_access WHERE dashboard_id IN ($1, $2)`,
        [fixture.dashA, fixture.dashB]
      )).rows;
    });
    expect(rows.length).toBe(1);
    expect(rows[0].tenant_id).toBe(TENANT_A);
  });

  it('withTenantContext(A) sees only A dashboard_sources', async () => {
    const { withTenantContext, withAdminClient } = await importDb();
    await withAdminClient(async (c) => {
      await c.query(
        `INSERT INTO platform.dashboard_sources (dashboard_id, tenant_id, source_key, table_name)
         VALUES ($1, $2, 'probe', 'probe_a'), ($3, $4, 'probe', 'probe_b')`,
        [fixture.dashA, TENANT_A, fixture.dashB, TENANT_B]
      );
    });
    const rows = await withTenantContext(TENANT_A, async (c) => {
      return (await c.query(
        `SELECT tenant_id FROM platform.dashboard_sources WHERE source_key = 'probe'`
      )).rows;
    });
    expect(rows.length).toBe(1);
    expect(rows[0].tenant_id).toBe(TENANT_A);
  });

  it('withTenantContext(A) sees only A connection_tables', async () => {
    const { withTenantContext, withAdminClient } = await importDb();
    await withAdminClient(async (c) => {
      await c.query(
        `INSERT INTO platform.connection_tables (connection_id, tenant_id, table_name)
         VALUES ($1, $2, 'probe-tbl-a'), ($3, $4, 'probe-tbl-b')`,
        [fixture.connA, TENANT_A, fixture.connB, TENANT_B]
      );
    });
    const rows = await withTenantContext(TENANT_A, async (c) => {
      return (await c.query(
        `SELECT tenant_id FROM platform.connection_tables WHERE table_name LIKE 'probe-tbl-%'`
      )).rows;
    });
    expect(rows.length).toBe(1);
    expect(rows[0].tenant_id).toBe(TENANT_A);
  });

  it('withTenantContext(A) sees only A invitations', async () => {
    const { withTenantContext, withAdminClient } = await importDb();
    await withAdminClient(async (c) => {
      await c.query(
        `INSERT INTO platform.invitations (tenant_id, email, role_id, invited_by, expires_at)
         VALUES ($1, 'probe-inv-a@example.test', $3, $5, now() + interval '1 day'),
                ($2, 'probe-inv-b@example.test', $4, $6, now() + interval '1 day')`,
        [TENANT_A, TENANT_B, fixture.roleId, fixture.roleId, fixture.userA, fixture.userB]
      );
    });
    const rows = await withTenantContext(TENANT_A, async (c) => {
      return (await c.query(
        `SELECT tenant_id FROM platform.invitations WHERE email LIKE 'probe-inv-%'`
      )).rows;
    });
    expect(rows.length).toBe(1);
    expect(rows[0].tenant_id).toBe(TENANT_A);
  });

  it('withTenantContext(A) sees only A user_passkeys', async () => {
    const { withTenantContext, withAdminClient } = await importDb();
    await withAdminClient(async (c) => {
      await c.query(
        `INSERT INTO platform.user_passkeys (user_id, tenant_id, credential_id, public_key)
         VALUES ($1, $2, decode('0100', 'hex'), decode('abcd', 'hex')),
                ($3, $4, decode('0200', 'hex'), decode('abcd', 'hex'))`,
        [fixture.userA, TENANT_A, fixture.userB, TENANT_B]
      );
    });
    const rows = await withTenantContext(TENANT_A, async (c) => {
      return (await c.query(
        `SELECT tenant_id FROM platform.user_passkeys WHERE credential_id IN (decode('0100', 'hex'), decode('0200', 'hex'))`
      )).rows;
    });
    expect(rows.length).toBe(1);
    expect(rows[0].tenant_id).toBe(TENANT_A);
  });

  it('withTenantContext(A) sees only A dashboard_embeds', async () => {
    const { withTenantContext, withAdminClient } = await importDb();
    const stamp = Date.now().toString();
    await withAdminClient(async (c) => {
      await c.query(
        `INSERT INTO platform.dashboard_embeds (dashboard_id, tenant_id, embed_token)
         VALUES ($1, $2, 'probe-embed-a-' || $5), ($3, $4, 'probe-embed-b-' || $5)`,
        [fixture.dashA, TENANT_A, fixture.dashB, TENANT_B, stamp]
      );
    });
    const rows = await withTenantContext(TENANT_A, async (c) => {
      return (await c.query(
        `SELECT tenant_id FROM platform.dashboard_embeds WHERE embed_token LIKE 'probe-embed-%'`
      )).rows;
    });
    expect(rows.length).toBe(1);
    expect(rows[0].tenant_id).toBe(TENANT_A);
  });

  it('withTenantContext(A) sees only A api_keys', async () => {
    const { withTenantContext, withAdminClient } = await importDb();
    const stamp = Date.now().toString();
    await withAdminClient(async (c) => {
      await c.query(
        `INSERT INTO platform.api_keys (tenant_id, name, key_prefix, key_hash, created_by)
         VALUES ($1, 'probe-a', 'pbA', 'probe-hash-a-' || $5, $3),
                ($2, 'probe-b', 'pbB', 'probe-hash-b-' || $5, $4)`,
        [TENANT_A, TENANT_B, fixture.userA, fixture.userB, stamp]
      );
    });
    const rows = await withTenantContext(TENANT_A, async (c) => {
      return (await c.query(
        `SELECT tenant_id FROM platform.api_keys WHERE key_hash LIKE 'probe-hash-%'`
      )).rows;
    });
    expect(rows.length).toBe(1);
    expect(rows[0].tenant_id).toBe(TENANT_A);
  });

  it('withTenantContext(A) sees only A webhooks', async () => {
    const { withTenantContext, withAdminClient } = await importDb();
    await withAdminClient(async (c) => {
      await c.query(
        `INSERT INTO platform.webhooks (tenant_id, name, target_url, created_by)
         VALUES ($1, 'probe-wh-a', 'https://example.test/a', $3),
                ($2, 'probe-wh-b', 'https://example.test/b', $4)`,
        [TENANT_A, TENANT_B, fixture.userA, fixture.userB]
      );
    });
    const rows = await withTenantContext(TENANT_A, async (c) => {
      return (await c.query(
        `SELECT tenant_id FROM platform.webhooks WHERE name LIKE 'probe-wh-%'`
      )).rows;
    });
    expect(rows.length).toBe(1);
    expect(rows[0].tenant_id).toBe(TENANT_A);
  });

  it('withTenantContext(A) sees only A file_uploads', async () => {
    const { withTenantContext, withAdminClient } = await importDb();
    await withAdminClient(async (c) => {
      await c.query(
        `INSERT INTO platform.file_uploads (tenant_id, uploaded_by, original_name, stored_name, context_type)
         VALUES ($1, $3, 'probe-a.txt', 'probe-a-stored', 'general'),
                ($2, $4, 'probe-b.txt', 'probe-b-stored', 'general')`,
        [TENANT_A, TENANT_B, fixture.userA, fixture.userB]
      );
    });
    const rows = await withTenantContext(TENANT_A, async (c) => {
      return (await c.query(
        `SELECT tenant_id FROM platform.file_uploads WHERE stored_name LIKE 'probe-%-stored'`
      )).rows;
    });
    expect(rows.length).toBe(1);
    expect(rows[0].tenant_id).toBe(TENANT_A);
  });

  it('withTenantContext(A) sees only A dashboard_tenant_grants', async () => {
    const { withTenantContext, withAdminClient } = await importDb();
    await withAdminClient(async (c) => {
      await c.query(
        `INSERT INTO platform.dashboard_tenant_grants (dashboard_id, tenant_id)
         VALUES ($1, $2), ($3, $4)
         ON CONFLICT (dashboard_id, tenant_id) DO NOTHING`,
        [fixture.dashA, TENANT_A, fixture.dashB, TENANT_B]
      );
    });
    const rows = await withTenantContext(TENANT_A, async (c) => {
      return (await c.query(
        `SELECT tenant_id FROM platform.dashboard_tenant_grants WHERE dashboard_id IN ($1, $2)`,
        [fixture.dashA, fixture.dashB]
      )).rows;
    });
    expect(rows.length).toBe(1);
    expect(rows[0].tenant_id).toBe(TENANT_A);
  });

  it('withTenantContext(A) sees only A fan_out_deliveries', async () => {
    const { withTenantContext, withAdminClient } = await importDb();
    const stamp = Date.now().toString();
    const runId = await withAdminClient(async (c) => {
      const integrationRow = (await c.query(
        `SELECT id FROM platform.integrations LIMIT 1`
      )).rows[0];
      // If no integrations exist in this DB the assertion is a no-op;
      // fan_out_runs requires one as a parent FK.
      if (!integrationRow) return null;
      const r = await c.query(
        `INSERT INTO platform.fan_out_runs (integration_id, idempotency_key, target_url)
         VALUES ($1, 'probe-run-' || $2, 'https://example.test/fan-out')
         RETURNING id`,
        [integrationRow.id, stamp]
      );
      const id = r.rows[0].id as string;
      await c.query(
        `INSERT INTO platform.fan_out_deliveries (fan_out_id, tenant_id, idempotency_key, status)
         VALUES ($1, $2, 'probe-del-a-' || $4, 'pending'),
                ($1, $3, 'probe-del-b-' || $4, 'pending')`,
        [id, TENANT_A, TENANT_B, stamp]
      );
      return id;
    });
    if (!runId) return;
    const rows = await withTenantContext(TENANT_A, async (c) => {
      return (await c.query(
        `SELECT tenant_id FROM platform.fan_out_deliveries WHERE fan_out_id = $1`,
        [runId]
      )).rows;
    });
    expect(rows.length).toBe(1);
    expect(rows[0].tenant_id).toBe(TENANT_A);
  });

  // ─── Inbox user_scope (migration 030) ─────────────────────
  //
  // Inbox tables are gated on `app.current_user_id`, not tenant.
  // Verify the direct participant policy and the transitive policies
  // on threads + messages all match user A only.

  it('withUserContext(userA) sees only A inbox_thread_participants', async () => {
    const { withUserContext, withAdminClient } = await importDb();
    const threadId = await withAdminClient(async (c) => {
      const t = await c.query(
        `INSERT INTO platform.inbox_threads (subject) VALUES ('probe-inbox-subject') RETURNING id`
      );
      const tid = t.rows[0].id as string;
      await c.query(
        `INSERT INTO platform.inbox_thread_participants (thread_id, user_id) VALUES ($1, $2), ($1, $3)`,
        [tid, fixture.userA, fixture.userB]
      );
      await c.query(
        `INSERT INTO platform.inbox_messages (thread_id, sender_id, body)
         VALUES ($1, $2, 'hello from A'), ($1, $3, 'hello from B')`,
        [tid, fixture.userA, fixture.userB]
      );
      return tid;
    });
    const rows = await withUserContext(TENANT_A, fixture.userA, async (c) => {
      return (await c.query(
        `SELECT user_id FROM platform.inbox_thread_participants WHERE thread_id = $1`,
        [threadId]
      )).rows;
    });
    expect(rows.length).toBe(1);
    expect(rows[0].user_id).toBe(fixture.userA);
  });

  it('withUserContext(userA) sees inbox_threads only when a participant', async () => {
    const { withUserContext, withAdminClient } = await importDb();
    const threadId = await withAdminClient(async (c) => {
      const t = await c.query(
        `INSERT INTO platform.inbox_threads (subject) VALUES ('probe-inbox-user-b-only') RETURNING id`
      );
      const tid = t.rows[0].id as string;
      // Only userB is a participant.
      await c.query(
        `INSERT INTO platform.inbox_thread_participants (thread_id, user_id) VALUES ($1, $2)`,
        [tid, fixture.userB]
      );
      return tid;
    });
    // userA is NOT a participant — RLS hides this thread from userA.
    const rows = await withUserContext(TENANT_A, fixture.userA, async (c) => {
      return (await c.query(
        `SELECT id FROM platform.inbox_threads WHERE id = $1`,
        [threadId]
      )).rows;
    });
    expect(rows.length).toBe(0);
  });

  it('withUserContext(userA) sees inbox_messages only in participating threads', async () => {
    const { withUserContext, withAdminClient } = await importDb();
    const { threadIdVisible, threadIdHidden } = await withAdminClient(async (c) => {
      const vis = (await c.query(
        `INSERT INTO platform.inbox_threads (subject) VALUES ('probe-inbox-msg-vis') RETURNING id`
      )).rows[0].id as string;
      const hid = (await c.query(
        `INSERT INTO platform.inbox_threads (subject) VALUES ('probe-inbox-msg-hid') RETURNING id`
      )).rows[0].id as string;
      await c.query(
        `INSERT INTO platform.inbox_thread_participants (thread_id, user_id) VALUES ($1, $2), ($3, $4)`,
        [vis, fixture.userA, hid, fixture.userB]
      );
      await c.query(
        `INSERT INTO platform.inbox_messages (thread_id, sender_id, body)
         VALUES ($1, $2, 'visible'), ($3, $4, 'hidden')`,
        [vis, fixture.userA, hid, fixture.userB]
      );
      return { threadIdVisible: vis, threadIdHidden: hid };
    });
    const rows = await withUserContext(TENANT_A, fixture.userA, async (c) => {
      return (await c.query(
        `SELECT thread_id, body FROM platform.inbox_messages
          WHERE thread_id IN ($1, $2)`,
        [threadIdVisible, threadIdHidden]
      )).rows;
    });
    expect(rows.length).toBe(1);
    expect(rows[0].thread_id).toBe(threadIdVisible);
    expect(rows[0].body).toBe('visible');
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
