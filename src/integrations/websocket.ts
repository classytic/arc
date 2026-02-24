/**
 * @classytic/arc — WebSocket Integration
 *
 * Pluggable adapter that wires @fastify/websocket into Arc's resource system.
 * Provides room-based subscriptions, auto-broadcasts resource CRUD events,
 * and respects Arc's auth/org scoping.
 *
 * This is a SEPARATE subpath import — only loaded when explicitly used:
 *   import { websocketPlugin } from '@classytic/arc/integrations/websocket';
 *
 * Requires: @fastify/websocket (peer dependency)
 *
 * NOTE: WebSocket requires persistent connections. This does NOT work on
 * serverless platforms (Lambda, Vercel). Only use on persistent runtimes
 * (Docker, VPS, K8s, Cloud Run with min-instances > 0).
 *
 * @example
 * ```typescript
 * import { websocketPlugin } from '@classytic/arc/integrations/websocket';
 *
 * await fastify.register(websocketPlugin, {
 *   path: '/ws',
 *   auth: true,
 *   resources: ['product', 'order'], // Auto-broadcast CRUD events
 *   heartbeatInterval: 30000,
 * });
 *
 * // Client connects to ws://localhost:3000/ws
 * // Server pushes: { type: 'product.created', data: { ... } }
 * // Client sends:  { type: 'subscribe', resource: 'product' }
 * // Client sends:  { type: 'unsubscribe', resource: 'product' }
 * ```
 */
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';

// ============================================================================
// Types
// ============================================================================

export interface WebSocketClient {
  id: string;
  socket: { send(data: string): void; close(): void; readyState: number };
  subscriptions: Set<string>;
  userId?: string;
  organizationId?: string;
  metadata?: Record<string, unknown>;
}

export interface WebSocketMessage {
  type: string;
  resource?: string;
  channel?: string;
  data?: unknown;
}

export interface WebSocketPluginOptions {
  /** WebSocket endpoint path (default: '/ws') */
  path?: string;
  /** Require authentication for WebSocket connections (default: true) */
  auth?: boolean;
  /** Resources to auto-broadcast CRUD events for */
  resources?: string[];
  /** Heartbeat interval in ms (default: 30000). Set 0 to disable. */
  heartbeatInterval?: number;
  /** Custom authentication function for WebSocket upgrade */
  authenticate?: (request: unknown) => Promise<{ userId?: string; organizationId?: string } | null>;
  /** Max clients per resource subscription (default: 10000) */
  maxClientsPerRoom?: number;
  /** Custom message handler */
  onMessage?: (client: WebSocketClient, message: WebSocketMessage) => void | Promise<void>;
  /** Called when a client connects */
  onConnect?: (client: WebSocketClient) => void | Promise<void>;
  /** Called when a client disconnects */
  onDisconnect?: (client: WebSocketClient) => void | Promise<void>;
}

// ============================================================================
// Room Manager — manages subscriptions efficiently
// ============================================================================

export class RoomManager {
  private rooms = new Map<string, Set<string>>(); // room → clientIds
  private clients = new Map<string, WebSocketClient>(); // clientId → client
  private maxPerRoom: number;

  constructor(maxPerRoom = 10000) {
    this.maxPerRoom = maxPerRoom;
  }

  addClient(client: WebSocketClient): void {
    this.clients.set(client.id, client);
  }

  removeClient(clientId: string): void {
    const client = this.clients.get(clientId);
    if (!client) return;

    // Remove from all rooms
    for (const room of client.subscriptions) {
      const members = this.rooms.get(room);
      if (members) {
        members.delete(clientId);
        if (members.size === 0) this.rooms.delete(room);
      }
    }

    client.subscriptions.clear();
    this.clients.delete(clientId);
  }

  subscribe(clientId: string, room: string): boolean {
    const client = this.clients.get(clientId);
    if (!client) return false;

    // Check room capacity
    const members = this.rooms.get(room);
    if (members && members.size >= this.maxPerRoom) return false;

    if (!this.rooms.has(room)) this.rooms.set(room, new Set());
    this.rooms.get(room)!.add(clientId);
    client.subscriptions.add(room);
    return true;
  }

  unsubscribe(clientId: string, room: string): void {
    const client = this.clients.get(clientId);
    if (!client) return;

    const members = this.rooms.get(room);
    if (members) {
      members.delete(clientId);
      if (members.size === 0) this.rooms.delete(room);
    }
    client.subscriptions.delete(room);
  }

  broadcast(room: string, message: string, excludeClientId?: string): void {
    const members = this.rooms.get(room);
    if (!members) return;

    for (const clientId of members) {
      if (clientId === excludeClientId) continue;
      const client = this.clients.get(clientId);
      if (client && client.socket.readyState === 1) {
        try {
          client.socket.send(message);
        } catch {
          // Client disconnected, will be cleaned up
        }
      }
    }
  }

  broadcastToOrg(organizationId: string, room: string, message: string): void {
    const members = this.rooms.get(room);
    if (!members) return;

    for (const clientId of members) {
      const client = this.clients.get(clientId);
      if (
        client &&
        client.organizationId === organizationId &&
        client.socket.readyState === 1
      ) {
        try {
          client.socket.send(message);
        } catch {
          // Client disconnected
        }
      }
    }
  }

  getClient(clientId: string): WebSocketClient | undefined {
    return this.clients.get(clientId);
  }

  getStats(): { clients: number; rooms: number; subscriptions: Record<string, number> } {
    const subscriptions: Record<string, number> = {};
    for (const [room, members] of this.rooms) {
      subscriptions[room] = members.size;
    }
    return {
      clients: this.clients.size,
      rooms: this.rooms.size,
      subscriptions,
    };
  }
}

// ============================================================================
// Plugin Implementation
// ============================================================================

let clientCounter = 0;

const websocketPluginImpl: FastifyPluginAsync<WebSocketPluginOptions> = async (
  fastify: FastifyInstance,
  options: WebSocketPluginOptions
) => {
  const {
    path = '/ws',
    auth = true,
    resources = [],
    heartbeatInterval = 30000,
    authenticate: customAuth,
    maxClientsPerRoom = 10000,
    onMessage,
    onConnect,
    onDisconnect,
  } = options;

  const rooms = new RoomManager(maxClientsPerRoom);

  // Decorate fastify with room manager for external access
  if (!fastify.hasDecorator('ws')) {
    fastify.decorate('ws', {
      rooms,
      broadcast: (room: string, data: unknown) => {
        rooms.broadcast(room, JSON.stringify({ type: 'broadcast', channel: room, data }));
      },
      broadcastToOrg: (orgId: string, room: string, data: unknown) => {
        rooms.broadcastToOrg(orgId, room, JSON.stringify({ type: 'broadcast', channel: room, data }));
      },
      getStats: () => rooms.getStats(),
    });
  }

  // Wire into Arc's event bus for auto-broadcasting resource events
  if (resources.length > 0 && (fastify as any).events?.subscribe) {
    for (const resourceName of resources) {
      for (const op of ['created', 'updated', 'deleted'] as const) {
        await (fastify as any).events.subscribe(`${resourceName}.${op}`, async (event: any) => {
          const room = resourceName;
          const payload = JSON.stringify({
            type: `${resourceName}.${op}`,
            data: event.payload,
            meta: {
              timestamp: event.meta?.timestamp,
              userId: event.meta?.userId,
              organizationId: event.meta?.organizationId,
            },
          });

          // If org-scoped, only broadcast to clients in same org
          if (event.meta?.organizationId) {
            rooms.broadcastToOrg(event.meta.organizationId, room, payload);
          } else {
            rooms.broadcast(room, payload);
          }
        });
      }
    }
  }

  // Register WebSocket route
  // Requires @fastify/websocket to be registered beforehand
  fastify.get(path, { websocket: true } as any, async (socket: any, request: any) => {
    const clientId = `ws_${++clientCounter}_${Date.now()}`;

    // Authentication
    let userId: string | undefined;
    let organizationId: string | undefined;

    if (auth) {
      if (customAuth) {
        const result = await customAuth(request);
        if (!result) {
          socket.close(4001, 'Unauthorized');
          return;
        }
        userId = result.userId;
        organizationId = result.organizationId;
      } else if (request.user) {
        userId = request.user.id ?? request.user.sub;
        organizationId = request.organizationId;
      }
    }

    const client: WebSocketClient = {
      id: clientId,
      socket,
      subscriptions: new Set(),
      userId,
      organizationId,
    };

    rooms.addClient(client);
    await onConnect?.(client);

    // Send connection confirmation
    socket.send(JSON.stringify({
      type: 'connected',
      clientId,
      resources: resources,
    }));

    // Heartbeat
    let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
    if (heartbeatInterval > 0) {
      heartbeatTimer = setInterval(() => {
        if (socket.readyState === 1) {
          socket.send(JSON.stringify({ type: 'ping', timestamp: Date.now() }));
        }
      }, heartbeatInterval);
    }

    // Handle incoming messages
    socket.on('message', async (raw: Buffer | string) => {
      try {
        const msg: WebSocketMessage = JSON.parse(
          typeof raw === 'string' ? raw : raw.toString()
        );

        switch (msg.type) {
          case 'subscribe': {
            const room = msg.resource ?? msg.channel;
            if (room) {
              const ok = rooms.subscribe(clientId, room);
              socket.send(JSON.stringify({
                type: ok ? 'subscribed' : 'error',
                channel: room,
                ...(ok ? {} : { error: 'Room at capacity' }),
              }));
            }
            break;
          }

          case 'unsubscribe': {
            const room = msg.resource ?? msg.channel;
            if (room) {
              rooms.unsubscribe(clientId, room);
              socket.send(JSON.stringify({ type: 'unsubscribed', channel: room }));
            }
            break;
          }

          case 'pong':
            // Heartbeat response, ignore
            break;

          default:
            // Forward to custom handler
            await onMessage?.(client, msg);
            break;
        }
      } catch {
        socket.send(JSON.stringify({ type: 'error', error: 'Invalid message format' }));
      }
    });

    // Cleanup on disconnect
    socket.on('close', async () => {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      await onDisconnect?.(client);
      rooms.removeClient(clientId);
    });

    socket.on('error', () => {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      rooms.removeClient(clientId);
    });
  });

  // Stats endpoint
  fastify.get(`${path}/stats`, async () => {
    return { success: true, data: rooms.getStats() };
  });

  // Cleanup on server close
  fastify.addHook('onClose', async () => {
    // Room manager auto-cleans when clients disconnect
  });
};

/** Pluggable WebSocket integration for Arc */
export const websocketPlugin: FastifyPluginAsync<WebSocketPluginOptions> = websocketPluginImpl;
export default websocketPlugin;
