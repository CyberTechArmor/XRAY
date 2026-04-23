import webpush from 'web-push';
import { config } from '../config';
import { withAdminClient } from '../db/connection';

// Initialize VAPID keys if configured
let pushConfigured = false;
try {
  if (config.vapid.publicKey && config.vapid.privateKey) {
    webpush.setVapidDetails(
      config.vapid.subject,
      config.vapid.publicKey,
      config.vapid.privateKey
    );
    pushConfigured = true;
  }
} catch {
  console.warn('Web Push VAPID keys not configured - push notifications disabled');
}

/**
 * Ensure push_subscriptions table exists.
 */
async function ensureTable(client: any): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS platform.push_subscriptions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES platform.users(id) ON DELETE CASCADE,
      endpoint TEXT NOT NULL,
      keys_p256dh TEXT NOT NULL,
      keys_auth TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(user_id, endpoint)
    )
  `);
}

/**
 * Save a push subscription for a user.
 */
export async function saveSubscription(
  userId: string,
  subscription: { endpoint: string; keys: { p256dh: string; auth: string } }
): Promise<void> {
  await withAdminClient(async (client) => {
    await ensureTable(client);
    await client.query(
      `INSERT INTO platform.push_subscriptions (user_id, endpoint, keys_p256dh, keys_auth)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, endpoint) DO UPDATE SET
         keys_p256dh = EXCLUDED.keys_p256dh,
         keys_auth = EXCLUDED.keys_auth`,
      [userId, subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth]
    );
  });
}

/**
 * Remove a push subscription.
 */
export async function removeSubscription(userId: string, endpoint: string): Promise<void> {
  await withAdminClient(async (client) => {
    await client.query(
      'DELETE FROM platform.push_subscriptions WHERE user_id = $1 AND endpoint = $2',
      [userId, endpoint]
    );
  });
}

/**
 * Send a push notification to a specific user (all their subscriptions).
 */
export async function sendPushToUser(
  userId: string,
  payload: Record<string, unknown>
): Promise<void> {
  if (!pushConfigured) return;
  await withAdminClient(async (client) => {
    await ensureTable(client);
    const result = await client.query(
      'SELECT endpoint, keys_p256dh, keys_auth FROM platform.push_subscriptions WHERE user_id = $1',
      [userId]
    );
    const message = JSON.stringify(payload);
    for (const row of result.rows) {
      const sub = {
        endpoint: row.endpoint,
        keys: { p256dh: row.keys_p256dh, auth: row.keys_auth },
      };
      try {
        await webpush.sendNotification(sub, message);
      } catch (err: any) {
        // Remove expired/invalid subscriptions (410 Gone, 404)
        if (err.statusCode === 410 || err.statusCode === 404) {
          await client.query(
            'DELETE FROM platform.push_subscriptions WHERE endpoint = $1',
            [row.endpoint]
          );
        }
      }
    }
  });
}

/**
 * Send a push notification to all platform admins.
 */
export async function sendPushToAdmins(payload: Record<string, unknown>): Promise<void> {
  if (!pushConfigured) return;
  await withAdminClient(async (client) => {
    await ensureTable(client);
    // Try to include preferences if column exists, fallback to without
    let result;
    try {
      result = await client.query(
        `SELECT ps.endpoint, ps.keys_p256dh, ps.keys_auth, u.preferences
         FROM platform.push_subscriptions ps
         JOIN platform.users u ON u.id = ps.user_id
         JOIN platform.roles r ON r.id = u.role_id
         WHERE r.is_platform = true`
      );
    } catch {
      result = await client.query(
        `SELECT ps.endpoint, ps.keys_p256dh, ps.keys_auth
         FROM platform.push_subscriptions ps
         JOIN platform.users u ON u.id = ps.user_id
         JOIN platform.roles r ON r.id = u.role_id
         WHERE r.is_platform = true`
      );
    }
    // Filter by notification preference (notify_calls defaults to true)
    const filteredRows = result.rows.filter((row: any) => {
      const prefs = row.preferences || {};
      return prefs.notify_calls !== false;
    });
    const message = JSON.stringify(payload);
    for (const row of filteredRows) {
      const sub = {
        endpoint: row.endpoint,
        keys: { p256dh: row.keys_p256dh, auth: row.keys_auth },
      };
      try {
        await webpush.sendNotification(sub, message);
      } catch (err: any) {
        if (err.statusCode === 410 || err.statusCode === 404) {
          await client.query(
            'DELETE FROM platform.push_subscriptions WHERE endpoint = $1',
            [row.endpoint]
          );
        }
      }
    }
  });
}

/**
 * Get the VAPID public key for client subscription.
 */
export function getVapidPublicKey(): string | null {
  return pushConfigured ? config.vapid.publicKey : null;
}
