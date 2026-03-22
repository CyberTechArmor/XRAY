import { withClient } from '../db/connection';
import { AppError } from '../middleware/error-handler';
import { decrypt } from '../lib/crypto';

interface MeetConfig {
  serverUrl: string;
  apiUrl: string;
  apiKey: string;
}

/**
 * Derive the API URL from the frontend URL.
 * For subdomain-routed deployments: https://meet.example.com -> https://api.meet.example.com
 */
function deriveApiUrl(frontendUrl: string): string {
  try {
    const u = new URL(frontendUrl);
    u.hostname = `api.${u.hostname}`;
    return u.origin;
  } catch {
    return frontendUrl;
  }
}

async function getMeetConfig(): Promise<MeetConfig> {
  return withClient(async (client) => {
    const result = await client.query(
      `SELECT key, value, is_secret FROM platform.platform_settings WHERE key IN ('meet_server_url', 'meet_api_key')`
    );

    const settings: Record<string, string> = {};
    for (const row of result.rows) {
      settings[row.key] = row.is_secret && row.value ? decrypt(row.value) : row.value;
    }

    if (!settings.meet_server_url || !settings.meet_api_key) {
      throw new AppError(400, 'MEET_NOT_CONFIGURED', 'MEET integration is not configured. Please set server URL and API key in admin settings.');
    }

    return {
      serverUrl: settings.meet_server_url,
      apiUrl: deriveApiUrl(settings.meet_server_url),
      apiKey: settings.meet_api_key,
    };
  });
}

export async function getMeetSettings(): Promise<{ serverUrl: string; configured: boolean }> {
  return withClient(async (client) => {
    const result = await client.query(
      `SELECT key, value, is_secret FROM platform.platform_settings WHERE key = 'meet_server_url'`
    );
    const serverUrl = result.rows[0]?.value || '';
    return { serverUrl, configured: !!serverUrl };
  });
}

/**
 * Make a MEET API request. Tries multiple URL strategies:
 * 1. API subdomain URL (api.meet.example.com)
 * 2. Frontend URL (meet.example.com) — for single-origin deployments
 *
 * Returns detailed errors so the admin can diagnose connectivity issues.
 */
async function meetApiFetch(
  config: MeetConfig,
  path: string,
  init: RequestInit
): Promise<Response> {
  const attempts: { url: string; error: string }[] = [];

  // Strategy 1: API subdomain (api.meet.example.com)
  const apiFullUrl = `${config.apiUrl}${path}`;
  try {
    const response = await fetch(apiFullUrl, init);
    if (response.status !== 405) {
      return response; // Success or a real API error — return it
    }
    attempts.push({ url: apiFullUrl, error: '405 Not Allowed (hit frontend nginx, not API server)' });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    attempts.push({ url: apiFullUrl, error: msg });
  }

  // Strategy 2: Frontend URL directly (meet.example.com)
  const frontendFullUrl = `${config.serverUrl}${path}`;
  try {
    const response = await fetch(frontendFullUrl, init);
    if (response.status !== 405) {
      return response;
    }
    attempts.push({ url: frontendFullUrl, error: '405 Not Allowed (nginx blocks POST/PUT on frontend)' });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    attempts.push({ url: frontendFullUrl, error: msg });
  }

  // All strategies failed — build a helpful diagnostic message
  const details = attempts.map((a) => `  ${a.url} → ${a.error}`).join('\n');
  throw new AppError(502, 'MEET_API_ERROR',
    `Could not reach MEET API server. Tried:\n${details}\n\nCheck that the API subdomain (${config.apiUrl}) has DNS configured and is accessible from this server.`
  );
}

/**
 * Test connectivity to the MEET API with detailed diagnostics.
 * Tries each URL strategy and reports what happened.
 */
export async function testConnection(): Promise<{
  success: boolean;
  workingUrl: string | null;
  apiUrl: string;
  frontendUrl: string;
  attempts: { url: string; status: string; ok: boolean }[];
}> {
  const config = await getMeetConfig();
  const testPath = '/api/rooms';
  const testBody = JSON.stringify({
    roomName: `xray-test-${Date.now()}`,
    displayName: 'Connection Test',
    maxParticipants: 2,
  });
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-API-Key': config.apiKey,
  };

  const attempts: { url: string; status: string; ok: boolean }[] = [];
  let workingUrl: string | null = null;

  // Test API subdomain URL
  const apiFullUrl = `${config.apiUrl}${testPath}`;
  try {
    const resp = await fetch(apiFullUrl, { method: 'POST', headers, body: testBody });
    if (resp.ok) {
      attempts.push({ url: config.apiUrl, status: `${resp.status} OK - Room created`, ok: true });
      workingUrl = config.apiUrl;
    } else if (resp.status === 405) {
      attempts.push({ url: config.apiUrl, status: '405 Not Allowed - Hit frontend nginx, not the API server', ok: false });
    } else {
      const text = await resp.text().catch(() => '');
      attempts.push({ url: config.apiUrl, status: `${resp.status} - ${text.substring(0, 100)}`, ok: false });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    attempts.push({ url: config.apiUrl, status: `Network error: ${msg}`, ok: false });
  }

  // Test frontend URL (for non-subdomain deployments)
  if (!workingUrl) {
    const frontendFullUrl = `${config.serverUrl}${testPath}`;
    try {
      const resp = await fetch(frontendFullUrl, { method: 'POST', headers, body: testBody });
      if (resp.ok) {
        attempts.push({ url: config.serverUrl, status: `${resp.status} OK - Room created`, ok: true });
        workingUrl = config.serverUrl;
      } else if (resp.status === 405) {
        attempts.push({ url: config.serverUrl, status: '405 Not Allowed - nginx blocks POST requests on this URL', ok: false });
      } else {
        const text = await resp.text().catch(() => '');
        attempts.push({ url: config.serverUrl, status: `${resp.status} - ${text.substring(0, 100)}`, ok: false });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      attempts.push({ url: config.serverUrl, status: `Network error: ${msg}`, ok: false });
    }
  }

  return {
    success: !!workingUrl,
    workingUrl,
    apiUrl: config.apiUrl,
    frontendUrl: config.serverUrl,
    attempts,
  };
}

export async function createRoom(options: {
  roomId?: string;
  displayName?: string;
  maxParticipants?: number;
}): Promise<{ room: Record<string, unknown>; joinUrl: string }> {
  const config = await getMeetConfig();
  const roomName = options.roomId || `xray-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const response = await meetApiFetch(config, '/api/rooms', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': config.apiKey,
    },
    body: JSON.stringify({
      roomName,
      displayName: options.displayName || 'XRay Meeting',
      maxParticipants: options.maxParticipants || 100,
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => 'Unknown error');
    throw new AppError(response.status, 'MEET_API_ERROR', `Failed to create room: ${text}`);
  }

  const room = await response.json();
  const params = new URLSearchParams({ room: roomName });
  const joinUrl = `${config.serverUrl}/?${params.toString()}`;

  return { room, joinUrl };
}

export async function getUserDisplayName(userId: string): Promise<string | null> {
  return withClient(async (client) => {
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
    const result = await client.query('SELECT name, email FROM platform.users WHERE id = $1', [userId]);
    if (result.rows.length === 0) return null;
    return result.rows[0].name || result.rows[0].email;
  });
}

export async function getUserInfo(userId: string): Promise<{ name: string | null; email: string } | null> {
  return withClient(async (client) => {
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
    const result = await client.query('SELECT name, email FROM platform.users WHERE id = $1', [userId]);
    if (result.rows.length === 0) return null;
    return { name: result.rows[0].name || null, email: result.rows[0].email };
  });
}

export function getJoinUrl(serverUrl: string, roomName: string, participantName?: string): string {
  const params = new URLSearchParams({ room: roomName });
  if (participantName) params.set('name', participantName);
  return `${serverUrl}/?${params.toString()}`;
}

// ── Support call functions ──

export async function createSupportCall(callerId: string, tenantId: string, roomCode: string, joinUrl: string): Promise<Record<string, unknown>> {
  return withClient(async (client) => {
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
    // Ensure table exists (idempotent)
    await client.query(`CREATE TABLE IF NOT EXISTS platform.support_calls (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      room_code TEXT NOT NULL, join_url TEXT NOT NULL,
      caller_id UUID NOT NULL, tenant_id UUID NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      answered_at TIMESTAMPTZ, expired_at TIMESTAMPTZ
    )`);
    const result = await client.query(
      `INSERT INTO platform.support_calls (room_code, join_url, caller_id, tenant_id, status)
       VALUES ($1, $2, $3, $4, 'pending') RETURNING *`,
      [roomCode, joinUrl, callerId, tenantId]
    );
    return result.rows[0];
  });
}

export async function getPendingSupportCalls(): Promise<any[]> {
  return withClient(async (client) => {
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
    // Check if table exists
    const tableCheck = await client.query(
      `SELECT to_regclass('platform.support_calls') AS tbl`
    );
    if (!tableCheck.rows[0].tbl) return [];
    // Get configurable ring duration
    const config = await getSupportCallConfig();
    const ringDuration = config.ring_duration || 120;
    // Expire calls older than ring duration
    await client.query(
      `UPDATE platform.support_calls SET status = 'expired', expired_at = now()
       WHERE status = 'pending' AND created_at < now() - interval '1 second' * $1`,
      [ringDuration]
    );
    const result = await client.query(
      `SELECT sc.*, u.name AS caller_name, u.email AS caller_email, t.name AS tenant_name
       FROM platform.support_calls sc
       LEFT JOIN platform.users u ON u.id = sc.caller_id
       LEFT JOIN platform.tenants t ON t.id = sc.tenant_id
       WHERE sc.status = 'pending'
       ORDER BY sc.created_at DESC`
    );
    return result.rows;
  });
}

export async function answerSupportCall(callId: string): Promise<void> {
  return withClient(async (client) => {
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
    await client.query(
      `UPDATE platform.support_calls SET status = 'answered', answered_at = now() WHERE id = $1`,
      [callId]
    );
  });
}

export async function getSupportWebhookConfig(): Promise<{ enabled: boolean; url: string }> {
  return withClient(async (client) => {
    const result = await client.query(
      `SELECT key, value FROM platform.platform_settings WHERE key IN ('support_webhook_enabled', 'support_webhook_url')`
    );
    const settings: Record<string, string> = {};
    for (const row of result.rows) {
      settings[row.key] = row.value;
    }
    return {
      enabled: settings.support_webhook_enabled === 'true',
      url: settings.support_webhook_url || '',
    };
  });
}

// ── Support call configuration ──

export interface SupportCallConfig {
  enabled: boolean;
  ring_duration: number; // seconds
  active_hours_enabled: boolean;
  active_hours_start: string; // HH:MM
  active_hours_end: string; // HH:MM
  sound_enabled: boolean;
  vibration_enabled: boolean;
}

export async function getSupportCallConfig(): Promise<SupportCallConfig> {
  return withClient(async (client) => {
    const result = await client.query(
      `SELECT key, value FROM platform.platform_settings WHERE key IN (
        'support_enabled', 'support_ring_duration',
        'support_active_hours_enabled', 'support_active_hours_start', 'support_active_hours_end',
        'support_sound_enabled', 'support_vibration_enabled'
      )`
    );
    const settings: Record<string, string> = {};
    for (const row of result.rows) {
      settings[row.key] = row.value;
    }
    return {
      enabled: settings.support_enabled !== 'false', // default true
      ring_duration: parseInt(settings.support_ring_duration || '120', 10),
      active_hours_enabled: settings.support_active_hours_enabled === 'true',
      active_hours_start: settings.support_active_hours_start || '00:00',
      active_hours_end: settings.support_active_hours_end || '23:59',
      sound_enabled: settings.support_sound_enabled !== 'false', // default true
      vibration_enabled: settings.support_vibration_enabled !== 'false', // default true
    };
  });
}

export function isWithinActiveHours(config: SupportCallConfig): boolean {
  if (!config.active_hours_enabled) return true;
  const now = new Date();
  const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  return hhmm >= config.active_hours_start && hhmm <= config.active_hours_end;
}

export async function getTenantMembers(tenantId: string): Promise<{ id: string; name: string; email: string }[]> {
  return withClient(async (client) => {
    await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantId]);
    const result = await client.query(
      `SELECT id, name, email FROM tenant.users WHERE status = 'active' ORDER BY name ASC, email ASC`
    );
    return result.rows.map((r: any) => ({ id: r.id, name: r.name || '', email: r.email }));
  });
}
