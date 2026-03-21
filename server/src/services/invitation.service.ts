import { withClient, withTransaction } from '../db/connection';
import { generateToken, hashToken, hashRefreshToken } from '../lib/crypto';
import { AppError } from '../middleware/error-handler';
import { sendTemplateEmail } from './email.service';
import { signAccessToken, signRefreshToken } from './jwt.service';
import { config } from '../config';
import * as auditService from './audit.service';

export async function createInvitation(
  tenantId: string,
  invitedBy: string,
  input: { email: string; roleId?: string; dashboardIds?: string[] }
) {
  return withTransaction(async (client) => {
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);

    // If no roleId provided, default to 'member' role
    let roleId = input.roleId;
    if (!roleId) {
      const defaultRole = await client.query(
        `SELECT id FROM platform.roles WHERE slug = 'member' LIMIT 1`
      );
      if (defaultRole.rows.length > 0) {
        roleId = defaultRole.rows[0].id;
      } else {
        throw new AppError(400, 'NO_DEFAULT_ROLE', 'No default role found. Please specify a role.');
      }
    }

    // Check if user already exists in this tenant
    const existing = await client.query(
      'SELECT id FROM platform.users WHERE email = $1 AND tenant_id = $2',
      [input.email, tenantId]
    );
    if (existing.rows.length > 0) {
      throw new AppError(409, 'ALREADY_MEMBER', 'User is already a member of this tenant');
    }

    // Check for pending invitation
    const pendingInvite = await client.query(
      `SELECT id FROM platform.invitations
       WHERE email = $1 AND tenant_id = $2 AND status = 'pending'`,
      [input.email, tenantId]
    );
    if (pendingInvite.rows.length > 0) {
      throw new AppError(409, 'ALREADY_INVITED', 'An invitation is already pending for this email');
    }

    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days
    const result = await client.query(
      `INSERT INTO platform.invitations (tenant_id, email, role_id, invited_by, dashboard_ids, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [tenantId, input.email, roleId, invitedBy, input.dashboardIds || [], expiresAt]
    );

    const invitation = result.rows[0];

    // Get inviter info and tenant name for email
    const inviterResult = await client.query(
      'SELECT name FROM platform.users WHERE id = $1', [invitedBy]
    );
    const tenantResult = await client.query(
      'SELECT name FROM platform.tenants WHERE id = $1', [tenantId]
    );

    try {
      await sendTemplateEmail('invitation', input.email, {
        inviter_name: inviterResult.rows[0]?.name || 'A team member',
        tenant_name: tenantResult.rows[0]?.name || 'your team',
        invite_url: `${config.webauthn.origin}/invite/${invitation.id}`,
        platform_name: 'XRay BI',
      });
    } catch (err) {
      console.error('Failed to send invitation email:', err);
    }

    auditService.log({
      tenantId,
      userId: invitedBy,
      action: 'invitation.created',
      resourceType: 'invitation',
      resourceId: invitation.id,
      metadata: { email: input.email },
    });

    return invitation;
  });
}

export async function listInvitations(tenantId: string, query: { page: number; limit: number }) {
  return withClient(async (client) => {
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
    const offset = (query.page - 1) * query.limit;
    const result = await client.query(
      `SELECT i.*, r.name as role_name
       FROM platform.invitations i
       JOIN platform.roles r ON r.id = i.role_id
       WHERE i.tenant_id = $1
       ORDER BY i.created_at DESC
       LIMIT $2 OFFSET $3`,
      [tenantId, query.limit, offset]
    );
    return result.rows;
  });
}

export async function acceptInvitation(input: { token: string; name: string }) {
  // Token is the invitation ID for simplicity
  return withTransaction(async (client) => {
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
    const result = await client.query(
      `SELECT * FROM platform.invitations
       WHERE id = $1 AND status = 'pending' AND expires_at > now()`,
      [input.token]
    );
    if (result.rows.length === 0) {
      throw new AppError(400, 'INVALID_INVITATION', 'Invitation not found, expired, or already used');
    }
    const invitation = result.rows[0];

    // Create user
    const userResult = await client.query(
      `INSERT INTO platform.users (tenant_id, email, name, role_id, status)
       VALUES ($1, $2, $3, $4, 'active') RETURNING *`,
      [invitation.tenant_id, invitation.email, input.name, invitation.role_id]
    );
    const user = userResult.rows[0];

    // Grant dashboard access
    if (invitation.dashboard_ids && invitation.dashboard_ids.length > 0) {
      for (const dashId of invitation.dashboard_ids) {
        await client.query(
          `INSERT INTO platform.dashboard_access (dashboard_id, user_id, tenant_id, granted_by)
           VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
          [dashId, user.id, invitation.tenant_id, invitation.invited_by]
        );
      }
    }

    // Mark invitation as accepted
    await client.query(
      `UPDATE platform.invitations SET status = 'accepted' WHERE id = $1`,
      [invitation.id]
    );

    // Get role info for token generation
    const roleResult = await client.query(
      `SELECT slug FROM platform.roles WHERE id = $1`,
      [invitation.role_id]
    );
    const roleSlug = roleResult.rows[0]?.slug || 'member';

    // Get permissions
    const permResult = await client.query(
      `SELECT p.key FROM platform.permissions p
       JOIN platform.role_permissions rp ON rp.permission_id = p.id
       WHERE rp.role_id = $1`,
      [invitation.role_id]
    );
    const permissions = permResult.rows.map((r: { key: string }) => r.key);

    // Create session for auto-login
    const refreshToken = signRefreshToken();
    const refreshTokenHash = hashRefreshToken(refreshToken);
    const expiresAt = new Date(Date.now() + config.jwt.refreshTokenExpiry);

    const sessionResult = await client.query(
      `INSERT INTO platform.user_sessions (user_id, tenant_id, refresh_token_hash, expires_at)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [user.id, invitation.tenant_id, refreshTokenHash, expiresAt]
    );

    const accessToken = signAccessToken({
      sub: user.id,
      tid: invitation.tenant_id,
      role: roleSlug,
      permissions,
      is_owner: false,
      is_platform_admin: false,
    });

    auditService.log({
      tenantId: invitation.tenant_id,
      userId: user.id,
      action: 'invitation.accepted',
      resourceType: 'invitation',
      resourceId: invitation.id,
    });

    return {
      user,
      tenantId: invitation.tenant_id,
      accessToken,
      refreshToken,
      sessionId: sessionResult.rows[0].id,
    };
  });
}

export async function getInvitationInfo(token: string) {
  return withClient(async (client) => {
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
    const result = await client.query(
      `SELECT i.id, i.email, i.status, i.expires_at, t.name as tenant_name
       FROM platform.invitations i
       JOIN platform.tenants t ON t.id = i.tenant_id
       WHERE i.id = $1`,
      [token]
    );
    if (result.rows.length === 0) {
      throw new AppError(404, 'NOT_FOUND', 'Invitation not found');
    }
    const inv = result.rows[0];
    const expired = new Date(inv.expires_at) < new Date();
    const valid = inv.status === 'pending' && !expired;
    return {
      email: inv.email,
      tenant_name: inv.tenant_name,
      status: inv.status,
      valid,
    };
  });
}

export async function revokeInvitation(tenantId: string, invitationId: string) {
  return withClient(async (client) => {
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
    const result = await client.query(
      `UPDATE platform.invitations SET status = 'revoked'
       WHERE id = $1 AND tenant_id = $2 AND status = 'pending'
       RETURNING id`,
      [invitationId, tenantId]
    );
    if (result.rows.length === 0) {
      throw new AppError(404, 'NOT_FOUND', 'Invitation not found or already processed');
    }
  });
}
