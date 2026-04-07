import { Server as HttpServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import jwt from 'jsonwebtoken';
import { config } from './config';
import * as replayService from './services/replay.service';

interface AuthenticatedSocket extends WebSocket {
  userId?: string;
  tenantId?: string;
  isPlatformAdmin?: boolean;
  isAlive?: boolean;
  replaySessionId?: string;
}

// Track connected clients by userId
const clients = new Map<string, Set<AuthenticatedSocket>>();
// Track all platform admin sockets for broadcast
const adminSockets = new Set<AuthenticatedSocket>();
// Track shadow-view subscribers: sessionId -> Set of subscriber sockets
const shadowSubscribers = new Map<string, Set<AuthenticatedSocket>>();

let wss: WebSocketServer;

/**
 * Initialize WebSocket server on the existing HTTP server.
 * Clients connect to ws(s)://host/ws?token=<jwt>
 */
export function initWebSocketServer(server: HttpServer) {
  wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws: AuthenticatedSocket, req) => {
    // Extract token from query string
    const url = new URL(req.url || '', 'http://localhost');
    const token = url.searchParams.get('token');

    if (!token) {
      ws.close(4001, 'Missing token');
      return;
    }

    // Verify JWT
    try {
      const payload = jwt.verify(token, config.jwtSecret) as any;
      ws.userId = payload.sub;
      ws.tenantId = payload.tid;
      ws.isPlatformAdmin = payload.is_platform_admin === true;
      ws.isAlive = true;
    } catch {
      ws.close(4002, 'Invalid token');
      return;
    }

    // Register client
    if (!clients.has(ws.userId!)) {
      clients.set(ws.userId!, new Set());
    }
    clients.get(ws.userId!)!.add(ws);

    if (ws.isPlatformAdmin) {
      adminSockets.add(ws);
    }

    // Pong handler for keepalive
    ws.on('pong', () => { ws.isAlive = true; });

    // Handle incoming messages
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());

        if (msg.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong' }));
          return;
        }

        // ── Session Replay Messages ───────────────────────────────
        if (msg.type === 'replay:events') {
          handleReplayEvents(ws, msg);
          return;
        }

        if (msg.type === 'replay:shadow-subscribe') {
          handleShadowSubscribe(ws, msg);
          return;
        }

        if (msg.type === 'replay:shadow-unsubscribe') {
          handleShadowUnsubscribe(ws, msg);
          return;
        }
      } catch {
        // Ignore malformed messages
      }
    });

    // Cleanup on close
    ws.on('close', () => {
      const userSockets = clients.get(ws.userId!);
      if (userSockets) {
        userSockets.delete(ws);
        if (userSockets.size === 0) clients.delete(ws.userId!);
      }
      adminSockets.delete(ws);

      // Clean up shadow subscriptions
      for (const [sessionId, subs] of shadowSubscribers) {
        if (subs.has(ws)) {
          subs.delete(ws);
          // Record shadow view end if this was a subscriber
          if (ws.replaySessionId) {
            // Find segment for this session to update shadow view
            // Best-effort; errors are non-fatal
          }
          if (subs.size === 0) shadowSubscribers.delete(sessionId);
        }
      }
    });

    // Send welcome message
    ws.send(JSON.stringify({ type: 'connected', ts: Date.now() }));
  });

  // Keepalive ping every 30 seconds
  const interval = setInterval(() => {
    wss.clients.forEach((ws: AuthenticatedSocket) => {
      if (ws.isAlive === false) {
        adminSockets.delete(ws);
        const userSockets = clients.get(ws.userId!);
        if (userSockets) {
          userSockets.delete(ws);
          if (userSockets.size === 0) clients.delete(ws.userId!);
        }
        return ws.terminate();
      }
      ws.isAlive = false;
      ws.ping();
    });
  }, 30_000);

  wss.on('close', () => clearInterval(interval));

  console.log('WebSocket server initialized on /ws');
}

/**
 * Broadcast a message to all connected platform admins.
 */
export function broadcastToAdmins(event: string, data: Record<string, unknown>) {
  const message = JSON.stringify({ type: event, data, ts: Date.now() });
  for (const ws of adminSockets) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(message);
    }
  }
}

/**
 * Send a message to a specific user (all their connected tabs/devices).
 */
export function sendToUser(userId: string, event: string, data: Record<string, unknown>) {
  const userSockets = clients.get(userId);
  if (!userSockets) return;
  const message = JSON.stringify({ type: event, data, ts: Date.now() });
  for (const ws of userSockets) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(message);
    }
  }
}

/**
 * Send a message to all users in a specific tenant.
 */
export function broadcastToTenant(tenantId: string, event: string, data: Record<string, unknown>) {
  const message = JSON.stringify({ type: event, data, ts: Date.now() });
  for (const [, sockets] of clients) {
    for (const ws of sockets) {
      if ((ws as AuthenticatedSocket).tenantId === tenantId && ws.readyState === WebSocket.OPEN) {
        ws.send(message);
      }
    }
  }
}

// ── Session Replay Handlers ─────────────────────────────────────────────────

/**
 * Handle incoming rrweb events from the recording client.
 * Stores events and fans them out to any shadow-view subscribers.
 */
function handleReplayEvents(ws: AuthenticatedSocket, msg: any) {
  const { sessionId, segmentId, events } = msg.data || msg;
  if (!sessionId || !segmentId || !Array.isArray(events) || events.length === 0) return;

  // Store events (fire-and-forget, errors logged)
  replayService.storeEvents(segmentId, events).catch((err) => {
    console.error('Failed to store replay events:', err);
  });

  // Fan out to shadow subscribers watching this session
  const subs = shadowSubscribers.get(sessionId);
  if (subs && subs.size > 0) {
    const fanoutMsg = JSON.stringify({
      type: 'replay:shadow-events',
      data: { sessionId, segmentId, events },
      ts: Date.now(),
    });
    for (const sub of subs) {
      if (sub.readyState === WebSocket.OPEN) {
        sub.send(fanoutMsg);
      }
    }
  }
}

/**
 * Admin subscribes to watch a live session (shadow viewing).
 */
function handleShadowSubscribe(ws: AuthenticatedSocket, msg: any) {
  const { sessionId, segmentId } = msg.data || msg;
  if (!sessionId) return;

  if (!shadowSubscribers.has(sessionId)) {
    shadowSubscribers.set(sessionId, new Set());
  }
  shadowSubscribers.get(sessionId)!.add(ws);

  // Record shadow view in the database if segmentId provided
  if (segmentId && ws.userId) {
    replayService.recordShadowView(segmentId, ws.userId).catch((err) => {
      console.error('Failed to record shadow view:', err);
    });
  }

  ws.send(JSON.stringify({
    type: 'replay:shadow-subscribed',
    data: { sessionId },
    ts: Date.now(),
  }));
}

/**
 * Admin leaves shadow view of a session.
 */
function handleShadowUnsubscribe(ws: AuthenticatedSocket, msg: any) {
  const { sessionId, segmentId } = msg.data || msg;
  if (!sessionId) return;

  const subs = shadowSubscribers.get(sessionId);
  if (subs) {
    subs.delete(ws);
    if (subs.size === 0) shadowSubscribers.delete(sessionId);
  }

  // Update shadow view end time if segmentId provided
  if (segmentId && ws.userId) {
    replayService.updateShadowViewEnd(segmentId, ws.userId).catch((err) => {
      console.error('Failed to update shadow view end:', err);
    });
  }

  ws.send(JSON.stringify({
    type: 'replay:shadow-unsubscribed',
    data: { sessionId },
    ts: Date.now(),
  }));
}
