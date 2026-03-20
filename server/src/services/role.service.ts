// Re-exports from rbac.service with the names that routes expect
import * as rbac from './rbac.service';
import { withClient } from '../db/connection';

export const listRoles = rbac.listRoles;
export const getAssignableRoles = rbac.getAssignableRoles;
export const deleteRole = rbac.deleteRole;

async function resolvePermissionKeys(keys: string[]): Promise<string[]> {
  if (keys.length === 0) return [];
  return withClient(async (client) => {
    const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
    const result = await client.query(
      `SELECT id FROM platform.permissions WHERE key IN (${placeholders})`,
      keys
    );
    return result.rows.map((r: { id: string }) => r.id);
  });
}

export async function createRole(input: {
  name: string;
  slug: string;
  description?: string;
  permissionIds?: string[];
  permissions?: string[];
}): Promise<Record<string, unknown>> {
  let permIds = input.permissionIds || [];
  if (input.permissions && input.permissions.length > 0) {
    permIds = await resolvePermissionKeys(input.permissions);
  }
  return rbac.createRole({ name: input.name, slug: input.slug, description: input.description, permissionIds: permIds });
}

export async function updateRole(
  roleId: string,
  updates: { name?: string; description?: string; permissionIds?: string[]; permissions?: string[] }
): Promise<Record<string, unknown>> {
  let permIds = updates.permissionIds;
  if (updates.permissions) {
    permIds = await resolvePermissionKeys(updates.permissions);
  }
  if (permIds) {
    await rbac.updateRolePermissions(roleId, permIds);
  }
  const roles = await rbac.listRoles();
  const role = roles.find((r) => r.id === roleId);
  return { ...role } as Record<string, unknown>;
}
