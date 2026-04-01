import { getPool, closePool } from './connection';

async function seed() {
  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Seed permissions
    await client.query(`
      INSERT INTO platform.permissions (key, label, category) VALUES
        ('dashboards.view',       'View assigned dashboards',   'dashboards'),
        ('dashboards.manage',     'Manage dashboard settings',  'dashboards'),
        ('dashboards.embed',      'Create public embeds',       'dashboards'),
        ('users.view',            'View team members',          'users'),
        ('users.invite',          'Invite new users',           'users'),
        ('users.manage',          'Manage user roles/status',   'users'),
        ('billing.view',          'View billing information',   'billing'),
        ('billing.manage',        'Manage subscription',        'billing'),
        ('connections.view',      'View data connections',      'connections'),
        ('account.view',          'View own account',           'account'),
        ('account.edit',          'Edit own profile',           'account'),
        ('audit.view',            'View audit log',             'audit'),
        ('platform.admin',        'Platform admin access',      'platform'),
        ('webhook.ingest',        'Push data via webhooks',     'webhooks')
      ON CONFLICT (key) DO NOTHING;
    `);

    // Seed roles
    await client.query(`
      INSERT INTO platform.roles (name, slug, is_system, is_platform) VALUES
        ('Platform Admin', 'platform_admin', true, true),
        ('Owner',          'owner',          true, false),
        ('Member',         'member',         true, false)
      ON CONFLICT (slug) DO NOTHING;
    `);

    // Map role permissions
    // Platform admin gets all permissions
    await client.query(`
      INSERT INTO platform.role_permissions (role_id, permission_id)
      SELECT r.id, p.id
      FROM platform.roles r
      CROSS JOIN platform.permissions p
      WHERE r.slug = 'platform_admin'
      ON CONFLICT DO NOTHING;
    `);

    // Owner gets all except platform.admin
    await client.query(`
      INSERT INTO platform.role_permissions (role_id, permission_id)
      SELECT r.id, p.id
      FROM platform.roles r
      CROSS JOIN platform.permissions p
      WHERE r.slug = 'owner' AND p.key != 'platform.admin'
      ON CONFLICT DO NOTHING;
    `);

    // Member gets view permissions + account
    await client.query(`
      INSERT INTO platform.role_permissions (role_id, permission_id)
      SELECT r.id, p.id
      FROM platform.roles r
      CROSS JOIN platform.permissions p
      WHERE r.slug = 'member' AND p.key IN (
        'account.view', 'account.edit',
        'users.view',
        'dashboards.view',
        'connections.view',
        'billing.view',
        'audit.view'
      )
      ON CONFLICT DO NOTHING;
    `);

    // Seed platform settings
    await client.query(`
      INSERT INTO platform.platform_settings (key, value, is_secret) VALUES
        ('smtp.host',               NULL, false),
        ('smtp.port',               '587', false),
        ('smtp.secure',             'true', false),
        ('smtp.username',           NULL, false),
        ('smtp.password',           NULL, true),
        ('smtp.from_name',          NULL, false),
        ('smtp.from_email',         NULL, false),
        ('stripe.publishable_key',  NULL, false),
        ('stripe.pricing_table_id', NULL, false),
        ('platform.name',           'XRay BI', false),
        ('platform.support_email',  NULL, false),
        ('platform.domain',         NULL, false),
        ('platform.share_domain',   NULL, false),
        ('meet_server_url',         NULL, false),
        ('meet_api_key',            NULL, true)
      ON CONFLICT (key) DO NOTHING;
    `);

    // Seed email templates
    await client.query(`
      INSERT INTO platform.email_templates
        (template_key, subject, body_html, body_text, variables, description)
      VALUES
      (
        'auth_magic_link',
        'Your verification code: {{code}}',
        '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px; color: #1a1a1a;"><h2 style="font-size: 20px; font-weight: 600; margin-bottom: 8px;">{{platform_name}}</h2><p style="font-size: 15px; line-height: 1.5; color: #444;">Your verification code is:</p><div style="font-size: 32px; font-weight: 700; letter-spacing: 6px; text-align: center; padding: 20px; margin: 16px 0; background: #f5f5f5; border-radius: 8px;">{{code}}</div><p style="font-size: 15px; line-height: 1.5; color: #444;">This code expires in 10 minutes. You can also verify by clicking the link below:</p><a href="{{verify_url}}" style="display: inline-block; padding: 12px 24px; margin: 12px 0; background: #1a1a1a; color: #ffffff; text-decoration: none; border-radius: 6px; font-size: 14px; font-weight: 500;">Verify email</a><p style="font-size: 13px; color: #888; margin-top: 24px;">If you did not request this code, you can safely ignore this email.</p></body></html>',
        E'Your verification code is: {{code}}\n\nThis code expires in 10 minutes. You can also verify by visiting: {{verify_url}}\n\nIf you did not request this code, you can safely ignore this email.\n\n— {{platform_name}}',
        ARRAY['code', 'verify_url', 'platform_name'],
        'Sent during signup and magic link login. Contains 6-digit code and verification link.'
      ),
      (
        'invitation',
        E'You''ve been invited to {{tenant_name}}',
        '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px; color: #1a1a1a;"><h2 style="font-size: 20px; font-weight: 600; margin-bottom: 8px;">{{platform_name}}</h2><p style="font-size: 15px; line-height: 1.5; color: #444;">{{inviter_name}} has invited you to join <strong>{{tenant_name}}</strong>.</p><p style="font-size: 15px; line-height: 1.5; color: #444;">Click below to create your account and get started:</p><a href="{{invite_url}}" style="display: inline-block; padding: 12px 24px; margin: 12px 0; background: #1a1a1a; color: #ffffff; text-decoration: none; border-radius: 6px; font-size: 14px; font-weight: 500;">Accept invitation</a><p style="font-size: 13px; color: #888; margin-top: 24px;">This invitation expires in 7 days. If you were not expecting this, you can safely ignore it.</p></body></html>',
        E'{{inviter_name}} has invited you to join {{tenant_name}} on {{platform_name}}.\n\nAccept your invitation: {{invite_url}}\n\nThis invitation expires in 7 days. If you were not expecting this, you can safely ignore it.',
        ARRAY['inviter_name', 'tenant_name', 'invite_url', 'platform_name'],
        'Sent when a tenant owner or admin invites a new user.'
      ),
      (
        'account_recovery',
        'Reset your access to {{platform_name}}',
        '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px; color: #1a1a1a;"><h2 style="font-size: 20px; font-weight: 600; margin-bottom: 8px;">{{platform_name}}</h2><p style="font-size: 15px; line-height: 1.5; color: #444;">We received a request to reset access to your account ({{email}}).</p><p style="font-size: 15px; line-height: 1.5; color: #444;">Your verification code is:</p><div style="font-size: 32px; font-weight: 700; letter-spacing: 6px; text-align: center; padding: 20px; margin: 16px 0; background: #f5f5f5; border-radius: 8px;">{{code}}</div><p style="font-size: 15px; line-height: 1.5; color: #444;">Or click the link below to verify your identity and set up a new passkey:</p><a href="{{recovery_url}}" style="display: inline-block; padding: 12px 24px; margin: 12px 0; background: #1a1a1a; color: #ffffff; text-decoration: none; border-radius: 6px; font-size: 14px; font-weight: 500;">Reset access</a><p style="font-size: 13px; color: #888; margin-top: 24px;">This code expires in 10 minutes. If you did not request a reset, no action is needed — your account is secure.</p></body></html>',
        E'We received a request to reset access to your account ({{email}}).\n\nYour verification code is: {{code}}\n\nOr visit this link to verify your identity and set up a new passkey: {{recovery_url}}\n\nThis code expires in 10 minutes. If you did not request a reset, no action is needed — your account is secure.\n\n— {{platform_name}}',
        ARRAY['code', 'email', 'recovery_url', 'platform_name'],
        'Sent when a user requests account recovery. Allows re-verification and new passkey registration.'
      )
      ON CONFLICT (template_key) DO NOTHING;
    `);

    await client.query('COMMIT');
    console.log('Seed data inserted successfully');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Seed failed:', err);
    throw err;
  } finally {
    client.release();
    await closePool();
  }
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});
