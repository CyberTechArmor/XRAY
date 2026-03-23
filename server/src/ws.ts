import { Server as HttpServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import jwt from 'jsonwebtoken';
import { config } from './config';

interface AuthenticatedSocket extends WebSocket {
  userId?: string;
  tenantId?: string;
  isPlatformAdmin?: boolean;
  isAlive?: boolean;
}

// Track connected clients by userId
const clients = new Map<string, Set<AuthenticatedSocket>>();
// Track all platform admin sockets for broadcast
const adminSockets = new Set<AuthenticatedSocket>();

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

    // Handle incoming messages (for future use)
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        // Handle client-to-server messages if needed
        if (msg.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong' }));
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
