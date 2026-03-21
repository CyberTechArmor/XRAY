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
 * Make a MEET API request with automatic URL fallback.
 * Tries the API URL (api.subdomain) first; if that fails with a network error
 * or 405, falls back to the frontend URL (in case the deployment doesn't use
 * subdomain routing).
 */
async function meetApiFetch(
  config: MeetConfig,
  path: string,
  init: RequestInit
): Promise<Response> {
  const urls = [config.apiUrl, config.serverUrl];
  let lastError: Error | null = null;
  let lastResponse: Response | null = null;

  for (const baseUrl of urls) {
    try {
      const response = await fetch(`${baseUrl}${path}`, init);
      // 405 means we hit the frontend nginx, not the API — try next URL
      if (response.status === 405 && baseUrl !== urls[urls.length - 1]) {
        lastResponse = response;
        continue;
      }
      return response;
    } catch (err) {
      lastError = err as Error;
      // Network error — try next URL
      continue;
    }
  }

  // If we got a 405 response from the last URL, return it
  if (lastResponse) return lastResponse;
  throw lastError || new Error('Failed to connect to MEET server');
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
