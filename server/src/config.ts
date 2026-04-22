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

// Accepts PEM either as raw multi-line (actual newlines in the env var —
// works with docker-compose env_file) or as base64-encoded single-line
// (simpler to put on a single shell line). We normalize to raw PEM so
// jsonwebtoken / node:crypto ingest it directly.
function normalizePem(raw: string): string {
  if (!raw) return '';
  if (raw.includes('-----BEGIN')) return raw;
  try {
    const decoded = Buffer.from(raw, 'base64').toString('utf8');
    if (decoded.includes('-----BEGIN')) return decoded;
  } catch {}
  return raw;
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
    // Per-dashboard signing secret model — no platform-wide env var.
    // The secret is stored on platform.dashboards.bridge_secret
    // (encrypted at rest) and passed explicitly to mintBridgeJwt().
    // iss/aud/exp are platform-wide contract; no reason to make them
    // per-dashboard configurable.
    issuer: 'xray',
    audience: 'n8n',
    expirySeconds: 60,
  },
  pipelineJwt: {
    // Second JWT XRay mints on every render, signed RS256 with a
    // platform-wide keypair. Audience is the future pipeline DB whose
    // pipeline.authorize(token) SECURITY DEFINER function will verify
    // signatures with the public key. Private key lives only here.
    // Absent key = graceful skip (logged once at startup); render sites
    // don't mint this JWT until the key is provisioned.
    // See .claude/pipeline-hardening-notes.md Model J for the full design.
    issuer: 'xray',
    audience: 'xray-pipeline',
    expirySeconds: 60,
    privateKey: normalizePem(getEnv('XRAY_PIPELINE_JWT_PRIVATE_KEY')),
    publicKey: normalizePem(getEnv('XRAY_PIPELINE_JWT_PUBLIC_KEY')),
  },
  oauth: {
    // Platform-wide callback URL. One URL handles every provider;
    // per-flow state travels in a signed state JWT. Admins paste this
    // same URL into each provider's developer console when registering
    // XRay as an OAuth app.
    // Resolution order:
    //   1. XRAY_OAUTH_REDIRECT_URI (explicit override)
    //   2. ORIGIN / APP_URL + '/api/oauth/callback'
    //   3. WebAuthn origin + '/api/oauth/callback' (dev fallback)
    redirectUri: (() => {
      const explicit = getEnv('XRAY_OAUTH_REDIRECT_URI');
      if (explicit) return explicit;
      const origin =
        getEnv('ORIGIN') ||
        getEnv('APP_URL') ||
        getEnv('WEBAUTHN_ORIGIN', 'http://localhost:3000');
      return origin.replace(/\/+$/, '') + '/api/oauth/callback';
    })(),
    // State JWT lifetime. Ten minutes gives the user time to complete
    // provider consent without the window being abusably long.
    stateExpirySeconds: 600,
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
