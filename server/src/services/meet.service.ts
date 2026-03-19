import { withClient } from '../db/connection';
import { AppError } from '../middleware/error-handler';
import { decrypt } from '../lib/crypto';

interface MeetConfig {
  serverUrl: string;
  apiKey: string;
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

export async function createRoom(options: {
  roomId?: string;
  displayName?: string;
  maxParticipants?: number;
}): Promise<{ room: Record<string, unknown>; joinUrl: string }> {
  const config = await getMeetConfig();
  const roomName = options.roomId || `xray-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const response = await fetch(`${config.serverUrl}/api/rooms`, {
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

export function getJoinUrl(serverUrl: string, roomName: string, participantName?: string): string {
  const params = new URLSearchParams({ room: roomName });
  if (participantName) params.set('name', participantName);
  return `${serverUrl}/?${params.toString()}`;
}
