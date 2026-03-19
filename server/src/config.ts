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
    rateLimitPerHour: 3,
  },
};
