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

export function getJoinUrl(serverUrl: string, roomName: string, participantName?: string): string {
  const params = new URLSearchParams({ room: roomName });
  if (participantName) params.set('name', participantName);
  return `${serverUrl}/?${params.toString()}`;
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
