import { withClient } from '../db/connection';
import { encrypt, decrypt } from '../lib/crypto';
import { config } from '../config';
import { AppError } from '../middleware/error-handler';

interface CachedSettings {
  data: Map<string, { value: string | null; is_secret: boolean }>;
  loadedAt: number;
}

const CACHE_TTL_MS = 60_000; // 1 minute
let cache: CachedSettings | null = null;

async function loadSettings(): Promise<CachedSettings> {
  // platform.platform_settings is on the no-RLS carve-out (migration 029
  // header comment lists it alongside magic_links / email_templates /
  // integrations). Plain withClient is the right primitive — there's
  // no tenant concept here.
  const rows = await withClient(async (client) => {
    const result = await client.query(
      'SELECT key, value, is_secret FROM platform.platform_settings'
    );
    return result.rows;
  });

  const data = new Map<string, { value: string | null; is_secret: boolean }>();
  for (const row of rows) {
    data.set(row.key, { value: row.value, is_secret: row.is_secret });
  }

  cache = { data, loadedAt: Date.now() };
  return cache;
}

async function getCache(): Promise<CachedSettings> {
  if (!cache || Date.now() - cache.loadedAt > CACHE_TTL_MS) {
    return loadSettings();
  }
  return cache;
}

export async function refreshCache(): Promise<void> {
  await loadSettings();
}

export async function getSetting(key: string): Promise<string | null> {
  const c = await getCache();
  const entry = c.data.get(key);
  if (!entry || entry.value === null) return null;
  if (entry.is_secret) {
    return decrypt(entry.value);
  }
  return entry.value;
}

export async function getAllSettings(): Promise<Record<string, string | null>> {
  const c = await getCache();
  const result: Record<string, string | null> = {};
  for (const [key, entry] of c.data) {
    if (!entry.is_secret) {
      result[key] = entry.value;
    }
  }
  return result;
}

export async function updateSettings(
  updates: Record<string, string | null>,
  userId: string | null,
): Promise<void> {
  // Same as loadSettings — platform_settings is a global carve-out
  // with no RLS; plain withClient.
  //
  // userId is the writer's UUID and lands on platform_settings.updated_by
  // (which has FK platform.users(id), nullable). System-driven writes
  // (e.g. CSRF middleware lazy-seeding csrf_signing_secret on first use)
  // pass null — passing a non-UUID sentinel like 'system' would crash
  // the INSERT with `invalid input syntax for type uuid`.
  await withClient(async (client) => {
    for (const [key, value] of Object.entries(updates)) {
      // Determine if this key is a secret by checking existing record
      const existing = await client.query(
        'SELECT is_secret FROM platform.platform_settings WHERE key = $1',
        [key]
      );

      // Auto-detect secret keys by name pattern, or use existing DB flag
      const SECRET_KEYS = ['stripe_secret_key', 'stripe_webhook_secret', 'smtp_pass', 'smtp_password'];
      const isSecretByName = SECRET_KEYS.includes(key) || key.endsWith('_password') || key.endsWith('_secret');
      const isSecret = existing.rows.length > 0 ? existing.rows[0].is_secret : isSecretByName;
      const storedValue = value !== null && isSecret ? encrypt(value) : value;

      await client.query(
        `INSERT INTO platform.platform_settings (key, value, is_secret, updated_by, updated_at)
         VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (key) DO UPDATE SET value = $2, is_secret = $3, updated_by = $4, updated_at = now()`,
        [key, storedValue, isSecret, userId]
      );
    }
  });

  // Invalidate cache after updates
  cache = null;
}

export interface SmtpConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
  from: string;
}

export async function getSmtpConfig(): Promise<SmtpConfig> {
  const host = (await getSetting('smtp_host')) || config.smtp.host;
  const port = (await getSetting('smtp_port')) || String(config.smtp.port);
  const user = (await getSetting('smtp_user')) || config.smtp.user;
  const pass = (await getSetting('smtp_pass')) || config.smtp.pass;
  const from = (await getSetting('smtp_from')) || config.smtp.from;

  if (!host) {
    throw new AppError(500, 'SMTP_NOT_CONFIGURED', 'SMTP is not configured');
  }

  return {
    host,
    port: parseInt(port, 10),
    user,
    pass,
    from,
  };
}

export interface StripeConfig {
  publishableKey: string;
  pricingTableId: string;
  portalUrl: string;
}

export async function getStripeConfig(): Promise<StripeConfig> {
  const publishableKey = (await getSetting('stripe_publishable_key')) || '';
  const pricingTableId = (await getSetting('stripe_pricing_table_id')) || '';
  const portalUrl = (await getSetting('stripe_portal_url')) || '';
  return { publishableKey, pricingTableId, portalUrl };
}
