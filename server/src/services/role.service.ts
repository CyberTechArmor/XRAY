// Re-exports from rbac.service with the names that routes expect
import * as rbac from './rbac.service';

export const listRoles = rbac.listRoles;
export const getAssignableRoles = rbac.getAssignableRoles;
export const createRole = rbac.createRole;
export const deleteRole = rbac.deleteRole;

export async function updateRole(
  roleId: string,
  updates: { name?: string; description?: string; permissionIds?: string[] }
): Promise<Record<string, unknown>> {
  if (updates.permissionIds) {
    await rbac.updateRolePermissions(roleId, updates.permissionIds);
  }
  const permissions = await rbac.getRolePermissions(roleId);
  const roles = await rbac.listRoles();
  const role = roles.find((r) => r.id === roleId);
  return { ...role, permissions } as Record<string, unknown>;
}
