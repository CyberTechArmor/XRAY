import { buildDashboardBundle } from './dashboard.service';

export async function getDashboardBundle(tenantId: string) {
  // Return the full dashboard bundle for the tenant
  // Pass hasManagePermission=true to get all dashboards (bundle is for rendering)
  return buildDashboardBundle(tenantId, '', true);
}

export async function getDashboardBundleVersion(tenantId: string): Promise<string> {
  // Simple version based on timestamp — could be improved with etag
  return `${tenantId}-${Date.now()}`;
}
