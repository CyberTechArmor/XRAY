import { withClient, withTransaction } from '../db/connection';
import { AppError } from '../middleware/error-handler';

interface Role {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  is_system: boolean;
  is_platform: boolean;
  created_at: string;
}

interface Permission {
  id: string;
  key: string;
  label: string;
  category: string;
  description: string | null;
}

export async function listRoles(): Promise<Role[]> {
  return withClient(async (client) => {
    const result = await client.query(
      'SELECT id, name, slug, description, is_system, is_platform, created_at FROM platform.roles ORDER BY name'
    );
    return result.rows;
  });
}

export async function getRolePermissions(roleId: string): Promise<Permission[]> {
  return withClient(async (client) => {
    const result = await client.query(
      `SELECT p.id, p.key, p.label, p.category, p.description
       FROM platform.permissions p
       JOIN platform.role_permissions rp ON rp.permission_id = p.id
       WHERE rp.role_id = $1
       ORDER BY p.category, p.key`,
      [roleId]
    );
    return result.rows;
  });
}

export async function createRole(input: {
  name: string;
  slug: string;
  description?: string;
  permissionIds: string[];
}): Promise<Role> {
  return withTransaction(async (client) => {
    const result = await client.query(
      `INSERT INTO platform.roles (name, slug, description, is_system, is_platform)
       VALUES ($1, $2, $3, false, false)
       RETURNING id, name, slug, description, is_system, is_platform, created_at`,
      [input.name, input.slug, input.description || null]
    );

    const role = result.rows[0];

    if (input.permissionIds.length > 0) {
      const valuesClauses = input.permissionIds.map(
        (_, i) => `($1, $${i + 2})`
      );
      await client.query(
        `INSERT INTO platform.role_permissions (role_id, permission_id)
         VALUES ${valuesClauses.join(', ')}`,
        [role.id, ...input.permissionIds]
      );
    }

    return role;
  });
}

export async function updateRolePermissions(
  roleId: string,
  permissionIds: string[]
): Promise<void> {
  return withTransaction(async (client) => {
    // Verify role exists and is not a system role
    const roleResult = await client.query(
      'SELECT is_system FROM platform.roles WHERE id = $1',
      [roleId]
    );
    if (roleResult.rows.length === 0) {
      throw new AppError(404, 'ROLE_NOT_FOUND', 'Role not found');
    }
    if (roleResult.rows[0].is_system) {
      throw new AppError(403, 'SYSTEM_ROLE', 'Cannot modify system role permissions');
    }

    // Replace all permissions
    await client.query(
      'DELETE FROM platform.role_permissions WHERE role_id = $1',
      [roleId]
    );

    if (permissionIds.length > 0) {
      const valuesClauses = permissionIds.map((_, i) => `($1, $${i + 2})`);
      await client.query(
        `INSERT INTO platform.role_permissions (role_id, permission_id)
         VALUES ${valuesClauses.join(', ')}`,
        [roleId, ...permissionIds]
      );
    }
  });
}

export async function deleteRole(roleId: string): Promise<void> {
  return withClient(async (client) => {
    const roleResult = await client.query(
      'SELECT is_system FROM platform.roles WHERE id = $1',
      [roleId]
    );
    if (roleResult.rows.length === 0) {
      throw new AppError(404, 'ROLE_NOT_FOUND', 'Role not found');
    }
    if (roleResult.rows[0].is_system) {
      throw new AppError(403, 'SYSTEM_ROLE', 'Cannot delete a system role');
    }

    // Check if any users have this role
    const usersResult = await client.query(
      'SELECT COUNT(*) FROM platform.users WHERE role_id = $1',
      [roleId]
    );
    if (parseInt(usersResult.rows[0].count, 10) > 0) {
      throw new AppError(409, 'ROLE_IN_USE', 'Cannot delete a role that is assigned to users');
    }

    await client.query('DELETE FROM platform.roles WHERE id = $1', [roleId]);
  });
}

export async function listPermissions(): Promise<Permission[]> {
  return withClient(async (client) => {
    const result = await client.query(
      'SELECT id, key, label, category, description FROM platform.permissions ORDER BY category, key'
    );
    return result.rows;
  });
}

export async function getAssignableRoles(): Promise<Role[]> {
  return withClient(async (client) => {
    const result = await client.query(
      `SELECT id, name, slug, description, is_system, is_platform, created_at
       FROM platform.roles
       WHERE is_platform = false
       ORDER BY name`
    );
    return result.rows;
  });
}
