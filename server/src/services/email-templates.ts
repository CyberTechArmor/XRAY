import { withClient } from '../db/connection';

// Default email templates seeded on server boot. Admin-edited rows
// are preserved: `seedDefaultTemplates` uses ON CONFLICT DO NOTHING
// keyed on template_key, so once a template exists in the DB we
// never overwrite it. Add a new key here and re-deploy — the new
// template appears automatically on existing installs, no
// migration or init.sql re-run.

interface DefaultTemplate {
  key: string;
  subject: string;
  html: string;
  text: string;
  variables: string[];
  description: string;
}

const BRAND_WRAPPER_OPEN = `<table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="background:#0c0e14;padding:24px 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#e0e1e5;line-height:1.5"><tr><td align="center"><table width="560" cellpadding="0" cellspacing="0" role="presentation" style="max-width:560px;width:100%;background:#1a1c26;border:1px solid #2a2d3a;border-radius:12px;padding:36px 40px"><tr><td><div style="font-size:14px;letter-spacing:.12em;text-transform:uppercase;color:#3ee8b5;font-weight:600;margin-bottom:8px">XRay BI</div>`;
const BRAND_WRAPPER_CLOSE = `<div style="margin-top:28px;padding-top:20px;border-top:1px solid #2a2d3a;font-size:12px;color:#6b6f7a">You're receiving this because someone used your email with XRay BI. If that wasn't you, ignore this message — no action is taken until the link is used.</div></td></tr></table></td></tr></table>`;

function wrap(body: string): string {
  return BRAND_WRAPPER_OPEN + body + BRAND_WRAPPER_CLOSE;
}

// Keep plaintext short and scannable — most clients render HTML but
// plaintext is the fallback + spam-filter-friendly twin. Never
// include the raw token since plaintext copy/paste is the main leak
// vector; rely on the link + code for both.
export const DEFAULT_TEMPLATES: DefaultTemplate[] = [
  {
    key: 'signup_verification',
    subject: 'Verify your XRay account',
    html: wrap(
      '<h2 style="margin:0 0 16px;font-size:20px;color:#e0e1e5">Verify your email</h2>'
      + '<p style="margin:0 0 16px">Hi {{name}},</p>'
      + '<p style="margin:0 0 16px">Your verification code is:</p>'
      + '<div style="background:#0c0e14;border:1px solid #2a2d3a;border-radius:8px;padding:18px;text-align:center;margin:0 0 20px"><code style="font-size:28px;font-weight:600;letter-spacing:.3em;color:#3ee8b5">{{code}}</code></div>'
      + '<p style="margin:0 0 12px">Or click to finish signup in one step:</p>'
      + '<p style="margin:0 0 16px"><a href="{{link}}" style="display:inline-block;background:#3ee8b5;color:#0c0e14;text-decoration:none;padding:10px 20px;border-radius:8px;font-weight:600">Complete signup &rarr;</a></p>'
      + '<p style="margin:0;color:#8e91a0;font-size:13px">The code and link expire in 10 minutes.</p>'
    ),
    text:
      'Hi {{name}},\n\nYour XRay verification code is: {{code}}\n\n'
      + 'Or visit this link to finish signup: {{link}}\n\n'
      + 'Code and link expire in 10 minutes.',
    variables: ['name', 'code', 'link'],
    description: 'Sent when a new user signs up',
  },
  {
    key: 'login_code',
    subject: 'Your XRay sign-in code',
    html: wrap(
      '<h2 style="margin:0 0 16px;font-size:20px;color:#e0e1e5">Sign in to XRay</h2>'
      + '<p style="margin:0 0 16px">Hi {{name}},</p>'
      + '<p style="margin:0 0 16px">Your sign-in code is:</p>'
      + '<div style="background:#0c0e14;border:1px solid #2a2d3a;border-radius:8px;padding:18px;text-align:center;margin:0 0 20px"><code style="font-size:28px;font-weight:600;letter-spacing:.3em;color:#3ee8b5">{{code}}</code></div>'
      + '<p style="margin:0 0 12px">Or click to sign in directly:</p>'
      + '<p style="margin:0 0 16px"><a href="{{link}}" style="display:inline-block;background:#3ee8b5;color:#0c0e14;text-decoration:none;padding:10px 20px;border-radius:8px;font-weight:600">Sign in &rarr;</a></p>'
      + '<p style="margin:0;color:#8e91a0;font-size:13px">The code and link expire in 10 minutes.</p>'
    ),
    text:
      'Hi {{name}},\n\nYour XRay sign-in code is: {{code}}\n\n'
      + 'Or visit this link to sign in directly: {{link}}\n\n'
      + 'Code and link expire in 10 minutes.',
    variables: ['name', 'code', 'link'],
    description: 'Sent when a user requests a magic link login',
  },
  {
    key: 'account_recovery',
    subject: 'XRay account recovery',
    html: wrap(
      '<h2 style="margin:0 0 16px;font-size:20px;color:#e0e1e5">Account recovery</h2>'
      + '<p style="margin:0 0 16px">Hi {{name}},</p>'
      + '<p style="margin:0 0 16px">Your recovery code is:</p>'
      + '<div style="background:#0c0e14;border:1px solid #2a2d3a;border-radius:8px;padding:18px;text-align:center;margin:0 0 20px"><code style="font-size:28px;font-weight:600;letter-spacing:.3em;color:#3ee8b5">{{code}}</code></div>'
      + '<p style="margin:0 0 12px">Or click to recover directly:</p>'
      + '<p style="margin:0 0 16px"><a href="{{link}}" style="display:inline-block;background:#3ee8b5;color:#0c0e14;text-decoration:none;padding:10px 20px;border-radius:8px;font-weight:600">Recover account &rarr;</a></p>'
      + '<p style="margin:0;color:#8e91a0;font-size:13px">The code and link expire in 10 minutes.</p>'
    ),
    text:
      'Hi {{name}},\n\nYour XRay recovery code is: {{code}}\n\n'
      + 'Or visit this link to recover your account: {{link}}\n\n'
      + 'Code and link expire in 10 minutes.',
    variables: ['name', 'code', 'link'],
    description: 'Sent when a user requests account recovery',
  },
  {
    // Sent when a platform admin uses Admin → Tenants → Invite Owner.
    // Same magic-link signup flow as a normal self-signup; the recipient
    // completes provisioning by clicking the link / entering the code.
    // Distinguished from `signup_verification` because the messaging
    // ("you've been invited" vs. "verify your email") matches the
    // recipient's actual context — they didn't sign themselves up.
    key: 'tenant_invitation',
    subject: 'You have been invited to set up {{tenant_name}} on XRay',
    html: wrap(
      '<h2 style="margin:0 0 16px;font-size:20px;color:#e0e1e5">Welcome to XRay BI</h2>'
      + '<p style="margin:0 0 16px">Hi {{name}},</p>'
      + '<p style="margin:0 0 16px"><strong>{{inviter_name}}</strong> has invited you to set up <strong>{{tenant_name}}</strong> on XRay BI as the owner.</p>'
      + '<p style="margin:0 0 16px">Your invitation code is:</p>'
      + '<div style="background:#0c0e14;border:1px solid #2a2d3a;border-radius:8px;padding:18px;text-align:center;margin:0 0 20px"><code style="font-size:28px;font-weight:600;letter-spacing:.3em;color:#3ee8b5">{{code}}</code></div>'
      + '<p style="margin:0 0 12px">Or click to finish setting up your account in one step:</p>'
      + '<p style="margin:0 0 16px"><a href="{{link}}" style="display:inline-block;background:#3ee8b5;color:#0c0e14;text-decoration:none;padding:10px 20px;border-radius:8px;font-weight:600">Accept invitation &rarr;</a></p>'
      + '<p style="margin:0;color:#8e91a0;font-size:13px">The code and link expire in 10 minutes.</p>'
    ),
    text:
      'Hi {{name}},\n\n{{inviter_name}} has invited you to set up {{tenant_name}} on XRay BI as the owner.\n\n'
      + 'Your invitation code is: {{code}}\n\n'
      + 'Or visit this link to accept: {{link}}\n\n'
      + 'Code and link expire in 10 minutes.',
    variables: ['name', 'inviter_name', 'tenant_name', 'code', 'link'],
    description: 'Sent when a platform admin invites a tenant owner via Admin → Tenants',
  },
  {
    key: 'invitation',
    subject: "You're invited to join {{tenant_name}} on XRay",
    html: wrap(
      '<h2 style="margin:0 0 16px;font-size:20px;color:#e0e1e5">You&rsquo;re invited to join {{tenant_name}}</h2>'
      + '<p style="margin:0 0 16px"><strong>{{inviter_name}}</strong> has invited you to join the <strong>{{tenant_name}}</strong> team on XRay BI.</p>'
      + '<p style="margin:0 0 16px"><a href="{{link}}" style="display:inline-block;background:#3ee8b5;color:#0c0e14;text-decoration:none;padding:10px 20px;border-radius:8px;font-weight:600">Accept invitation &rarr;</a></p>'
      + '<p style="margin:0;color:#8e91a0;font-size:13px">This invitation expires in 7 days.</p>'
    ),
    text:
      '{{inviter_name}} has invited you to join {{tenant_name}} on XRay BI.\n\n'
      + 'Accept: {{link}}\n\n'
      + 'Invitation expires in 7 days.',
    variables: ['inviter_name', 'tenant_name', 'link'],
    description: 'Sent when a team member is invited',
  },
  {
    key: 'passkey_registered',
    subject: 'A new passkey was registered on your XRay account',
    html: wrap(
      '<h2 style="margin:0 0 16px;font-size:20px;color:#e0e1e5">New passkey registered</h2>'
      + '<p style="margin:0 0 16px">Hi {{name}},</p>'
      + '<p style="margin:0 0 16px">A new passkey was just registered on your XRay account.</p>'
      + '<div style="background:#0c0e14;border:1px solid #2a2d3a;border-radius:8px;padding:16px;margin:0 0 16px;font-size:13px;color:#a0a3ae">'
      + '<div><strong style="color:#e0e1e5">Device:</strong> {{device_name}}</div>'
      + '<div><strong style="color:#e0e1e5">When:</strong> {{registered_at}}</div>'
      + '</div>'
      + '<p style="margin:0 0 16px">If this was you, no action is needed.</p>'
      + '<p style="margin:0 0 16px">If you don&rsquo;t recognize this, open XRay and remove the passkey from <em>Account &rarr; Passkeys</em>, then sign out other devices.</p>'
    ),
    text:
      'Hi {{name}},\n\nA new passkey was just registered on your XRay account.\n\n'
      + 'Device: {{device_name}}\n'
      + 'When: {{registered_at}}\n\n'
      + 'If this was you, no action is needed. Otherwise open XRay, remove the passkey from Account > Passkeys, and sign out other devices.',
    variables: ['name', 'device_name', 'registered_at'],
    description: 'Security notification when a new passkey is registered',
  },
  {
    key: 'billing_locked',
    subject: 'Your XRay dashboard access is paused',
    html: wrap(
      '<h2 style="margin:0 0 16px;font-size:20px;color:#e0e1e5">Dashboard access paused</h2>'
      + '<p style="margin:0 0 16px">Hi {{name}},</p>'
      + '<p style="margin:0 0 16px">{{reason}}</p>'
      + '<p style="margin:0 0 16px">Dashboards will remain unavailable for your team until the subscription is reactivated. Your data and dashboards are not deleted.</p>'
      + '<p style="margin:0 0 16px"><a href="{{billing_url}}" style="display:inline-block;background:#3ee8b5;color:#0c0e14;text-decoration:none;padding:10px 20px;border-radius:8px;font-weight:600">Open billing &rarr;</a></p>'
      + '<p style="margin:0;color:#8e91a0;font-size:13px">If you think this is a mistake, contact the person who set up your account.</p>'
    ),
    text:
      'Hi {{name}},\n\n{{reason}}\n\n'
      + 'Dashboards remain unavailable for your team until the subscription is reactivated. Your data and dashboards are not deleted.\n\n'
      + 'Open billing: {{billing_url}}',
    variables: ['name', 'reason', 'billing_url'],
    description: 'Sent when a tenant is billing-locked (subscription lapsed or canceled)',
  },
];

// Idempotent upsert: INSERT only when the key is missing. Admin-edited
// templates are preserved. Safe to call on every boot.
export async function seedDefaultTemplates(): Promise<{ inserted: number; skipped: number }> {
  // platform.email_templates is on the no-RLS carve-out per migration
  // 029. Boot-time seed runs before any tenant exists; plain withClient.
  return withClient(async (client) => {
    let inserted = 0;
    let skipped = 0;
    for (const tpl of DEFAULT_TEMPLATES) {
      const result = await client.query(
        `INSERT INTO platform.email_templates
           (template_key, subject, body_html, body_text, variables, description)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (template_key) DO NOTHING
         RETURNING template_key`,
        [tpl.key, tpl.subject, tpl.html, tpl.text, tpl.variables, tpl.description]
      );
      if (result.rows.length > 0) inserted++;
      else skipped++;
    }
    return { inserted, skipped };
  });
}
