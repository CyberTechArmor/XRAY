-- Migration 009: Role Restructure
-- Merge admin, member, and viewer roles into a single "Member" role.
-- After this migration, tenant-assignable roles are: Owner, Member
-- (platform_admin remains unchanged as a platform-level role)

BEGIN;

-- Step 1: Reassign all users on 'admin' role to the 'viewer' role (by role_id)
UPDATE platform.users
   SET role_id = (SELECT id FROM platform.roles WHERE slug = 'viewer'),
       updated_at = now()
 WHERE role_id = (SELECT id FROM platform.roles WHERE slug = 'admin');

-- Step 2: Reassign all users on old 'member' role to the 'viewer' role (by role_id)
UPDATE platform.users
   SET role_id = (SELECT id FROM platform.roles WHERE slug = 'viewer'),
       updated_at = now()
 WHERE role_id = (SELECT id FROM platform.roles WHERE slug = 'member');

-- Step 3: Reassign any pending invitations on 'admin' or old 'member' roles
UPDATE platform.invitations
   SET role_id = (SELECT id FROM platform.roles WHERE slug = 'viewer')
 WHERE role_id IN (
   SELECT id FROM platform.roles WHERE slug IN ('admin', 'member')
 );

-- Step 4: Delete role_permissions for 'admin' and old 'member' roles
DELETE FROM platform.role_permissions
 WHERE role_id IN (
   SELECT id FROM platform.roles WHERE slug IN ('admin', 'member')
 );

-- Step 5: Delete the 'admin' and old 'member' role rows
DELETE FROM platform.roles WHERE slug IN ('admin', 'member');

-- Step 6: Rename 'viewer' role to 'Member' with slug 'member'
UPDATE platform.roles
   SET name = 'Member',
       slug = 'member',
       description = 'Standard member — views dashboards, manages account'
 WHERE slug = 'viewer';

-- Step 7: Ensure the new 'member' role has the right permissions.
-- Grant: account.view, account.edit, users.view, dashboards.view,
--        connections.view, billing.view, audit.view
-- (This matches what the old 'member' role had, which is more than old 'viewer')
INSERT INTO platform.role_permissions (role_id, permission_id)
  SELECT r.id, p.id
    FROM platform.roles r
    CROSS JOIN platform.permissions p
   WHERE r.slug = 'member'
     AND p.key IN (
       'account.view', 'account.edit',
       'users.view',
       'dashboards.view',
       'connections.view',
       'billing.view',
       'audit.view'
     )
ON CONFLICT (role_id, permission_id) DO NOTHING;

COMMIT;
