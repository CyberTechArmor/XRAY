import { describe, it, expect, beforeAll } from 'vitest';
import { AppError } from '../middleware/error-handler';

// Pure-logic specs for step-4b's Global-vs-Tenant dashboard rules.
// Matches the existing pattern in integration.service.test.ts /
// oauth-scheduler.test.ts: pure-function contracts get fast unit tests;
// DB-backed render-path behavior (cache rows, bridge+pipeline JWT tenant
// binding, 409 routing) is covered at the integration-test layer once
// that stands up. This file locks the rules that can be asserted
// without a live Postgres:
//
//   - createDashboard enforces admin-only authoring of Globals
//   - createDashboard rejects scope='tenant' without a tenantId
//   - createDashboard rejects scope='global' with a tenantId leak
//   - Rendering tenant selection: dashboard.tenant_id for Tenant rows,
//     requester's tid for Globals. Admin impersonation only fires for
//     Tenant rows owned by another tenant.

beforeAll(() => {
  process.env.DATABASE_URL ||= 'postgres://stub';
  process.env.JWT_SECRET ||= 'test-jwt-secret';
  process.env.ENCRYPTION_KEY ||= 'a'.repeat(64);
});

// Reproduce the admin.service.createDashboard pre-DB validation logic
// so we can exercise it without a live Postgres. Mirror of the server
// code; keep in sync if the rules change.
function validateDashboardCreate(input: {
  tenantId?: string | null;
  scope?: 'tenant' | 'global';
  integration?: string | null;
  bridgeSecret?: string | null;
  name?: string;
}, ctx?: { isPlatformAdmin?: boolean }): { scope: 'tenant' | 'global'; effectiveTenantId: string | null } {
  const scope: 'tenant' | 'global' = input.scope === 'global' ? 'global' : 'tenant';
  if (scope === 'global' && !ctx?.isPlatformAdmin) {
    throw new AppError(403, 'GLOBAL_DASHBOARD_REQUIRES_ADMIN', 'GLOBAL_DASHBOARD_REQUIRES_ADMIN');
  }
  const effectiveTenantId: string | null = scope === 'global' ? null : (input.tenantId ?? null);
  if (scope === 'tenant' && !effectiveTenantId) {
    throw new AppError(400, 'TENANT_REQUIRED', 'TENANT_REQUIRED');
  }
  if (input.integration && !input.bridgeSecret) {
    throw new AppError(400, 'BRIDGE_SECRET_REQUIRED', 'BRIDGE_SECRET_REQUIRED');
  }
  return { scope, effectiveTenantId };
}

describe('global-dashboards.createDashboard validation', () => {
  it('accepts a plain Tenant dashboard from a tenant user', () => {
    const result = validateDashboardCreate({
      tenantId: '11111111-1111-1111-1111-111111111111',
      name: 'Invoices',
    });
    expect(result.scope).toBe('tenant');
    expect(result.effectiveTenantId).toBe('11111111-1111-1111-1111-111111111111');
  });

  it('rejects scope=global from a non-admin tenant user (403)', () => {
    expect(() =>
      validateDashboardCreate(
        { scope: 'global', name: 'Revenue' },
        { isPlatformAdmin: false }
      )
    ).toThrow(/GLOBAL_DASHBOARD_REQUIRES_ADMIN/);
  });

  it('accepts scope=global from a platform admin', () => {
    const result = validateDashboardCreate(
      { scope: 'global', name: 'Revenue' },
      { isPlatformAdmin: true }
    );
    expect(result.scope).toBe('global');
    expect(result.effectiveTenantId).toBeNull();
  });

  it('zeroes out a leaked tenantId on a Global create (scope wins)', () => {
    const result = validateDashboardCreate(
      {
        scope: 'global',
        tenantId: '22222222-2222-2222-2222-222222222222',
        name: 'Revenue',
      },
      { isPlatformAdmin: true }
    );
    expect(result.effectiveTenantId).toBeNull();
  });

  it('rejects a Tenant-scoped create without a tenantId (400)', () => {
    expect(() => validateDashboardCreate({ name: 'anything' })).toThrow(/TENANT_REQUIRED/);
  });

  it('rejects integration without bridge secret (step-2 contract unchanged)', () => {
    expect(() =>
      validateDashboardCreate({
        tenantId: '11111111-1111-1111-1111-111111111111',
        integration: 'housecall_pro',
      })
    ).toThrow(/BRIDGE_SECRET_REQUIRED/);
  });

  it('accepts integration with a bridge secret', () => {
    expect(() =>
      validateDashboardCreate({
        tenantId: '11111111-1111-1111-1111-111111111111',
        integration: 'housecall_pro',
        bridgeSecret: 'a-fresh-generated-secret-at-least-16-chars',
      })
    ).not.toThrow();
  });
});

// Mirror of the render-path's via/renderingTenantId branching rules
// so a regression to the admin-impersonation-on-Globals path is caught
// fast. Keep in sync with dashboard.routes.ts.
function computeRenderContext(
  dashboard: { scope: 'tenant' | 'global'; dashboard_tenant_id: string | null },
  requester: { tid: string | null; is_platform_admin: boolean }
): { renderingTenantId: string | null; actingVia: 'authed_render' | 'admin_impersonation' } {
  const isGlobal = dashboard.scope === 'global';
  const renderingTenantId: string | null = isGlobal
    ? requester.tid
    : dashboard.dashboard_tenant_id;
  const actingVia: 'authed_render' | 'admin_impersonation' =
    requester.is_platform_admin &&
    !isGlobal &&
    dashboard.dashboard_tenant_id !== requester.tid
      ? 'admin_impersonation'
      : 'authed_render';
  return { renderingTenantId, actingVia };
}

describe('global-dashboards.render-context selection', () => {
  it('Tenant row renders under the dashboard-owning tenant; non-admin = authed_render', () => {
    const ctx = computeRenderContext(
      { scope: 'tenant', dashboard_tenant_id: 'tenant-A' },
      { tid: 'tenant-A', is_platform_admin: false }
    );
    expect(ctx.renderingTenantId).toBe('tenant-A');
    expect(ctx.actingVia).toBe('authed_render');
  });

  it('Platform admin rendering another tenants Tenant-row = admin_impersonation', () => {
    const ctx = computeRenderContext(
      { scope: 'tenant', dashboard_tenant_id: 'tenant-A' },
      { tid: 'admin-tenant', is_platform_admin: true }
    );
    expect(ctx.renderingTenantId).toBe('tenant-A');
    expect(ctx.actingVia).toBe('admin_impersonation');
  });

  it('Global row under tenant A = authed_render with renderingTenantId=tenant-A', () => {
    const ctx = computeRenderContext(
      { scope: 'global', dashboard_tenant_id: null },
      { tid: 'tenant-A', is_platform_admin: false }
    );
    expect(ctx.renderingTenantId).toBe('tenant-A');
    expect(ctx.actingVia).toBe('authed_render');
  });

  it('Same Global under tenant B binds to tenant-B', () => {
    const ctx = computeRenderContext(
      { scope: 'global', dashboard_tenant_id: null },
      { tid: 'tenant-B', is_platform_admin: false }
    );
    expect(ctx.renderingTenantId).toBe('tenant-B');
    expect(ctx.actingVia).toBe('authed_render');
  });

  it('Platform admin rendering a Global stays authed_render (no impersonation)', () => {
    // A Global isn't "owned" by any tenant, so viewing it as an admin
    // from the admin's home tenant isn't impersonation — the admin's
    // own credentials drive the render.
    const ctx = computeRenderContext(
      { scope: 'global', dashboard_tenant_id: null },
      { tid: 'admin-tenant', is_platform_admin: true }
    );
    expect(ctx.renderingTenantId).toBe('admin-tenant');
    expect(ctx.actingVia).toBe('authed_render');
  });

  it('Tenant row rendered by its own tenant even when the user is a platform admin = authed_render', () => {
    const ctx = computeRenderContext(
      { scope: 'tenant', dashboard_tenant_id: 'admin-tenant' },
      { tid: 'admin-tenant', is_platform_admin: true }
    );
    expect(ctx.actingVia).toBe('authed_render');
  });
});
