-- Cross-tenant RLS probe — step 6 acceptance check.
--
-- Run this MANUALLY in a psql session against the platform DB after
-- step 6's migrations and code changes are deployed. Creates two
-- synthetic tenants, inserts one row per RLS-enabled tenant-scoped
-- table for each, then verifies that switching into each tenant's
-- context yields ONLY that tenant's rows. Admin bypass is verified
-- last.
--
-- Lives in migrations/probes/ (not migrations/) so update.sh's
-- pre-rebuild migration pass doesn't auto-apply it. The probe has
-- real INSERT side effects that get rolled back at the end — if it
-- ever ran as part of an automated deploy it could collide with
-- prior state or leave residue on partial failure.
--
-- Every assertion uses RAISE EXCEPTION on failure so a leak hard-fails
-- the script. A clean run prints 'PROBE PASS'. All changes roll back
-- at the end — the script leaves no residue.
--
-- Usage:
--   docker exec -i <postgres-container> psql -U xray -d xray \
--     < migrations/probes/probe-rls-cross-tenant.sql
--
-- Or interactively:
--   \i migrations/probes/probe-rls-cross-tenant.sql

BEGIN;

-- ── Setup: two synthetic tenants + owner users ──────────────────
DO $$
DECLARE
  tenant_a UUID := 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  tenant_b UUID := 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  conn_a   UUID;
  conn_b   UUID;
  dash_a   UUID;
  dash_b   UUID;
  user_a   UUID;
  user_b   UUID;
  role_id  UUID;
  a_rows   INT;
  b_rows   INT;
BEGIN
  -- Admin context for setup.
  PERFORM set_config('app.is_platform_admin', 'true', true);

  INSERT INTO platform.tenants (id, name, slug)
    VALUES (tenant_a, 'Probe Tenant A', 'probe-a'),
           (tenant_b, 'Probe Tenant B', 'probe-b')
    ON CONFLICT (id) DO NOTHING;

  SELECT id INTO role_id FROM platform.roles WHERE slug = 'owner' LIMIT 1;
  IF role_id IS NULL THEN
    SELECT id INTO role_id FROM platform.roles LIMIT 1;
  END IF;

  -- platform.users.name is NOT NULL in init.sql, so every probe
  -- INSERT must supply it even though we never read it.
  INSERT INTO platform.users (tenant_id, email, name, role_id, status)
    VALUES (tenant_a, 'probe-a@example.test', 'Probe User A', role_id, 'active')
    RETURNING id INTO user_a;
  INSERT INTO platform.users (tenant_id, email, name, role_id, status)
    VALUES (tenant_b, 'probe-b@example.test', 'Probe User B', role_id, 'active')
    RETURNING id INTO user_b;

  INSERT INTO platform.dashboards (tenant_id, name)
    VALUES (tenant_a, 'Probe Dash A') RETURNING id INTO dash_a;
  INSERT INTO platform.dashboards (tenant_id, name)
    VALUES (tenant_b, 'Probe Dash B') RETURNING id INTO dash_b;

  INSERT INTO platform.connections (tenant_id, name, source_type, pipeline_ref)
    VALUES (tenant_a, 'Probe Conn A', 'http', 'probe.a') RETURNING id INTO conn_a;
  INSERT INTO platform.connections (tenant_id, name, source_type, pipeline_ref)
    VALUES (tenant_b, 'Probe Conn B', 'http', 'probe.b') RETURNING id INTO conn_b;

  INSERT INTO platform.billing_state (tenant_id, plan_tier, payment_status)
    VALUES (tenant_a, 'free', 'none'),
           (tenant_b, 'free', 'none')
    ON CONFLICT (tenant_id) DO NOTHING;

  INSERT INTO platform.audit_log (tenant_id, action)
    VALUES (tenant_a, 'probe.test_event'),
           (tenant_b, 'probe.test_event');

  INSERT INTO platform.dashboard_render_cache (dashboard_id, tenant_id, view_html)
    VALUES (dash_a, tenant_a, '<a/>'),
           (dash_b, tenant_b, '<b/>');

  INSERT INTO platform.dashboard_tenant_grants (dashboard_id, tenant_id)
    VALUES (dash_a, tenant_a),
           (dash_b, tenant_b);

  INSERT INTO platform.dashboard_shares (dashboard_id, tenant_id, public_token, is_public)
    VALUES (dash_a, tenant_a, 'probe-token-a', true),
           (dash_b, tenant_b, 'probe-token-b', true);

  INSERT INTO platform.connection_comments (connection_id, content, author_id)
    VALUES (conn_a, 'Probe comment A', user_a),
           (conn_b, 'Probe comment B', user_b);

  -- ── Probe: tenant A's context only sees A's rows ─────────────
  PERFORM set_config('app.is_platform_admin', 'false', true);
  PERFORM set_config('app.current_tenant', tenant_a::text, true);

  FOR a_rows, b_rows IN
    SELECT
      (SELECT COUNT(*) FROM platform.users WHERE email LIKE 'probe-%'),
      NULL
  LOOP
    IF a_rows <> 1 THEN
      RAISE EXCEPTION 'LEAK: platform.users in tenant A saw % probe rows (want 1)', a_rows;
    END IF;
  END LOOP;

  SELECT COUNT(*) INTO a_rows FROM platform.dashboards WHERE name LIKE 'Probe Dash%';
  IF a_rows <> 1 THEN RAISE EXCEPTION 'LEAK: platform.dashboards (A) = % (want 1)', a_rows; END IF;

  SELECT COUNT(*) INTO a_rows FROM platform.connections WHERE name LIKE 'Probe Conn%';
  IF a_rows <> 1 THEN RAISE EXCEPTION 'LEAK: platform.connections (A) = % (want 1)', a_rows; END IF;

  SELECT COUNT(*) INTO a_rows FROM platform.billing_state WHERE tenant_id IN (tenant_a, tenant_b);
  IF a_rows <> 1 THEN RAISE EXCEPTION 'LEAK: platform.billing_state (A) = % (want 1)', a_rows; END IF;

  SELECT COUNT(*) INTO a_rows FROM platform.audit_log WHERE action = 'probe.test_event';
  IF a_rows <> 1 THEN RAISE EXCEPTION 'LEAK: platform.audit_log (A) = % (want 1)', a_rows; END IF;

  SELECT COUNT(*) INTO a_rows FROM platform.dashboard_render_cache
    WHERE dashboard_id IN (dash_a, dash_b);
  IF a_rows <> 1 THEN RAISE EXCEPTION 'LEAK: platform.dashboard_render_cache (A) = % (want 1)', a_rows; END IF;

  SELECT COUNT(*) INTO a_rows FROM platform.dashboard_tenant_grants
    WHERE dashboard_id IN (dash_a, dash_b);
  IF a_rows <> 1 THEN RAISE EXCEPTION 'LEAK: platform.dashboard_tenant_grants (A) = % (want 1)', a_rows; END IF;

  SELECT COUNT(*) INTO a_rows FROM platform.dashboard_shares
    WHERE public_token LIKE 'probe-token-%';
  IF a_rows <> 1 THEN RAISE EXCEPTION 'LEAK: platform.dashboard_shares (A) = % (want 1)', a_rows; END IF;

  SELECT COUNT(*) INTO a_rows FROM platform.connection_comments
    WHERE content LIKE 'Probe comment%';
  IF a_rows <> 1 THEN RAISE EXCEPTION 'LEAK: platform.connection_comments (A) = % (want 1)', a_rows; END IF;

  -- tenant_notes is admin-only. In tenant context it must return zero.
  SELECT COUNT(*) INTO a_rows FROM platform.tenant_notes WHERE tenant_id IN (tenant_a, tenant_b);
  IF a_rows <> 0 THEN RAISE EXCEPTION 'LEAK: tenant_notes visible in tenant context (% rows; want 0)', a_rows; END IF;

  -- ── Probe: tenant B's context only sees B's rows ─────────────
  PERFORM set_config('app.current_tenant', tenant_b::text, true);

  SELECT COUNT(*) INTO b_rows FROM platform.users WHERE email = 'probe-a@example.test';
  IF b_rows <> 0 THEN RAISE EXCEPTION 'LEAK: tenant B saw A user (% rows; want 0)', b_rows; END IF;

  SELECT COUNT(*) INTO b_rows FROM platform.dashboards WHERE tenant_id = tenant_a;
  IF b_rows <> 0 THEN RAISE EXCEPTION 'LEAK: tenant B saw A dashboards (% rows; want 0)', b_rows; END IF;

  SELECT COUNT(*) INTO b_rows FROM platform.connections WHERE tenant_id = tenant_a;
  IF b_rows <> 0 THEN RAISE EXCEPTION 'LEAK: tenant B saw A connections (% rows; want 0)', b_rows; END IF;

  SELECT COUNT(*) INTO b_rows FROM platform.dashboard_render_cache WHERE tenant_id = tenant_a;
  IF b_rows <> 0 THEN RAISE EXCEPTION 'LEAK: tenant B saw A render cache (% rows; want 0)', b_rows; END IF;

  SELECT COUNT(*) INTO b_rows FROM platform.dashboard_tenant_grants WHERE tenant_id = tenant_a;
  IF b_rows <> 0 THEN RAISE EXCEPTION 'LEAK: tenant B saw A grants (% rows; want 0)', b_rows; END IF;

  SELECT COUNT(*) INTO b_rows FROM platform.dashboard_shares WHERE tenant_id = tenant_a;
  IF b_rows <> 0 THEN RAISE EXCEPTION 'LEAK: tenant B saw A shares (% rows; want 0)', b_rows; END IF;

  -- ── Probe: admin bypass sees all rows ────────────────────────
  PERFORM set_config('app.current_tenant', '', true);
  PERFORM set_config('app.is_platform_admin', 'true', true);

  SELECT COUNT(*) INTO a_rows FROM platform.dashboards WHERE name LIKE 'Probe Dash%';
  IF a_rows <> 2 THEN RAISE EXCEPTION 'BYPASS BROKEN: admin saw % dashboards (want 2)', a_rows; END IF;

  SELECT COUNT(*) INTO a_rows FROM platform.connection_comments WHERE content LIKE 'Probe comment%';
  IF a_rows <> 2 THEN RAISE EXCEPTION 'BYPASS BROKEN: admin saw % comments (want 2)', a_rows; END IF;

  RAISE NOTICE 'PROBE PASS — cross-tenant isolation holds, admin bypass works';
END $$;

-- Hard rollback so the probe leaves no rows behind.
ROLLBACK;
