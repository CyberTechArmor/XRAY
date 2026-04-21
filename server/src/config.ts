import { cleanEnv, str, port, num } from './lib/env-validator';

function getEnv(key: string, fallback?: string): string {
  return process.env[key] || fallback || '';
}

function getEnvRequired(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required environment variable: ${key}`);
  return val;
}

function getEnvInt(key: string, fallback: number): number {
  const val = process.env[key];
  return val ? parseInt(val, 10) : fallback;
}

export const config = {
  port: getEnvInt('PORT', 3000),
  nodeEnv: getEnv('NODE_ENV', 'development'),
  databaseUrl: getEnvRequired('DATABASE_URL'),
  jwtSecret: getEnvRequired('JWT_SECRET'),
  encryptionKey: (() => {
    const key = getEnvRequired('ENCRYPTION_KEY');
    if (!/^[a-f0-9]{64}$/i.test(key)) {
      throw new Error('ENCRYPTION_KEY must be a 64-character hex string (256-bit key)');
    }
    return key;
  })(),
  n8nBridge: {
    // HS256 secret shared with n8n. Must match the "JWT Auth" credential
    // configured on every webhook that accepts XRay renders. Rotating this
    // value requires updating both sides in the same window.
    jwtSecret: (() => {
      const key = getEnvRequired('N8N_BRIDGE_JWT_SECRET');
      if (key.length < 32) {
        throw new Error('N8N_BRIDGE_JWT_SECRET must be at least 32 characters');
      }
      return key;
    })(),
    issuer: 'xray',
    audience: 'n8n',
    expirySeconds: 60,
  },
  stripeWebhookSecret: getEnv('STRIPE_WEBHOOK_SECRET'),
  webauthn: {
    rpName: getEnv('WEBAUTHN_RP_NAME', 'XRay BI'),
    rpId: getEnv('WEBAUTHN_RP_ID', 'localhost'),
    origin: getEnv('WEBAUTHN_ORIGIN', 'http://localhost:3000'),
  },
  smtp: {
    host: getEnv('SMTP_HOST'),
    port: getEnvInt('SMTP_PORT', 587),
    user: getEnv('SMTP_USER'),
    pass: getEnv('SMTP_PASS'),
    from: getEnv('SMTP_FROM'),
  },
  jwt: {
    accessTokenExpiry: '15m',
    refreshTokenExpiry: 7 * 24 * 60 * 60 * 1000, // 7 days in ms
  },
  magicLink: {
    expiryMinutes: 10,
    maxAttempts: 3,
    rateLimitPerHour: 600,
  },
  vapid: {
    publicKey: getEnv('VAPID_PUBLIC_KEY'),
    privateKey: getEnv('VAPID_PRIVATE_KEY'),
    subject: getEnv('VAPID_SUBJECT', 'mailto:admin@xray.fractionate.ai'),
  },
};
