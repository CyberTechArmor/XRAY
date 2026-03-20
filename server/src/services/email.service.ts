import nodemailer from 'nodemailer';
import { withClient } from '../db/connection';
import { getSmtpConfig } from './settings.service';
import { AppError } from '../middleware/error-handler';

interface SendEmailOptions {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function renderTemplate(
  template: string,
  vars: Record<string, string>
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_match, key) => {
    const value = vars[key];
    return value !== undefined ? escapeHtml(value) : '';
  });
}

export async function sendEmail(options: SendEmailOptions): Promise<void> {
  const smtp = await getSmtpConfig();

  const transporter = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.port === 465,
    auth:
      smtp.user && smtp.pass
        ? { user: smtp.user, pass: smtp.pass }
        : undefined,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
  });

  await transporter.sendMail({
    from: smtp.from,
    to: options.to,
    subject: options.subject,
    html: options.html,
    text: options.text,
  });
}

export async function sendTemplateEmail(
  templateKey: string,
  to: string,
  variables: Record<string, string>
): Promise<void> {
  const template = await withClient(async (client) => {
    const result = await client.query(
      'SELECT subject, body_html, body_text FROM platform.email_templates WHERE template_key = $1',
      [templateKey]
    );
    return result.rows[0] || null;
  });

  if (!template) {
    throw new AppError(500, 'TEMPLATE_NOT_FOUND', `Email template '${templateKey}' not found`);
  }

  const subject = renderTemplate(template.subject, variables);
  const html = renderTemplate(template.body_html, variables);
  const text = renderTemplate(template.body_text, variables);

  await sendEmail({ to, subject, html, text });
}
