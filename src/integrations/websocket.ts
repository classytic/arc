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
import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";

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
  authenticate?: (
    request: unknown,
  ) => Promise<{ userId?: string; organizationId?: string } | null>;
  /** Max clients per resource subscription (default: 10000) */
  maxClientsPerRoom?: number;
  /**
   * Expose a stats endpoint at `{path}/stats`.
   * - `false` (default): stats endpoint is not registered
   * - `true`: registered without auth
   * - `'authenticated'`: guarded by `fastify.authenticate` if available
   */
  exposeStats?: boolean | "authenticated";
  /**
   * Authorize room subscriptions. Return true to allow, false to deny.
   * Called before every subscribe. If not provided, all rooms are allowed.
   */
  roomPolicy?: (
    client: WebSocketClient,
    room: string,
  ) => boolean | Promise<boolean>;
  /** Maximum message size in bytes from client (default: 16384 = 16KB). Messages exceeding this are dropped. */
  maxMessageBytes?: number;
  /** Maximum subscriptions per client (default: 100). Prevents resource exhaustion. */
  maxSubscriptionsPerClient?: number;
  /** Custom message handler */
  onMessage?: (
    client: WebSocketClient,
    message: WebSocketMessage,
  ) => void | Promise<void>;
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

  getStats(): {
    clients: number;
    rooms: number;
    subscriptions: Record<string, number>;
  } {
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

const websocketPluginImpl: FastifyPluginAsync<WebSocketPluginOptions> = async (
  fastify: FastifyInstance,
  options: WebSocketPluginOptions,
) => {
  // Instance-scoped counter — no global leak across test runs or multiple app instances
  let clientCounter = 0;
  const {
    path = "/ws",
    auth = true,
    resources = [],
    heartbeatInterval = 30000,
    authenticate: customAuth,
    maxClientsPerRoom = 10000,
    roomPolicy,
    maxMessageBytes = 16384,
    maxSubscriptionsPerClient = 100,
    exposeStats = false,
    onMessage,
    onConnect,
    onDisconnect,
  } = options;

  // Fail-closed: throw early if auth required but no authenticator available
  if (auth && !customAuth && !fastify.hasDecorator("authenticate")) {
    throw new Error(
      "[arc-websocket] auth is true but fastify.authenticate is not registered. " +
        "Register an auth plugin before WebSocket, provide a custom authenticate function, or set auth: false.",
    );
  }

  const rooms = new RoomManager(maxClientsPerRoom);

  // Decorate fastify with room manager for external access
  if (!fastify.hasDecorator("ws")) {
    fastify.decorate("ws", {
      rooms,
      broadcast: (room: string, data: unknown) => {
        rooms.broadcast(
          room,
          JSON.stringify({ type: "broadcast", channel: room, data }),
        );
      },
      broadcastToOrg: (orgId: string, room: string, data: unknown) => {
        rooms.broadcastToOrg(
          orgId,
          room,
          JSON.stringify({ type: "broadcast", channel: room, data }),
        );
      },
      getStats: () => rooms.getStats(),
    });
  }

  // Wire into Arc's event bus for auto-broadcasting resource events
  // Track unsubscribe handles so we can clean up on server close
  const eventUnsubscribers: Array<() => void> = [];

  if (resources.length > 0 && fastify.events?.subscribe) {
    for (const resourceName of resources) {
      for (const op of ["created", "updated", "deleted"] as const) {
        const unsub = await fastify.events.subscribe(
          `${resourceName}.${op}`,
          async (event: any) => {
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
          },
        );
        eventUnsubscribers.push(unsub);
      }
    }
  }

  // Register WebSocket route
  // Requires @fastify/websocket to be registered beforehand
  fastify.get(
    path,
    { websocket: true } as any,
    async (socket: any, request: any) => {
      const clientId = `ws_${++clientCounter}_${Date.now()}`;

      // Authentication
      let userId: string | undefined;
      let organizationId: string | undefined;

      if (auth) {
        if (customAuth) {
          const result = await customAuth(request);
          if (!result) {
            socket.close(4001, "Unauthorized");
            return;
          }
          userId = result.userId;
          organizationId = result.organizationId;
        } else {
          // Run fastify.authenticate to parse token and populate request.user
          // during the WebSocket handshake. Without this, request.user is never
          // set and all authenticated WS connections are rejected.
          if (fastify.authenticate) {
            try {
              // Create a minimal reply-like object for authenticate()
              // that captures the status code without sending a real HTTP response
              let rejected = false;
              const fakeReply = {
                code(_statusCode: number) { rejected = true; return fakeReply; },
                send() { return fakeReply; },
                sent: false,
              };
              await (fastify.authenticate as any)(request, fakeReply);
              if (rejected) {
                socket.close(4001, "Unauthorized");
                return;
              }
            } catch {
              socket.close(4001, "Unauthorized");
              return;
            }
          }

          if (request.user) {
            userId = (request.user as any).id ?? (request.user as any).sub;
            organizationId = (request.scope as any)?.organizationId;
          } else {
            socket.close(4001, "Unauthorized");
            return;
          }
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
      socket.send(
        JSON.stringify({
          type: "connected",
          clientId,
          resources: resources,
        }),
      );

      // Heartbeat
      let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
      if (heartbeatInterval > 0) {
        heartbeatTimer = setInterval(() => {
          if (socket.readyState === 1) {
            socket.send(
              JSON.stringify({ type: "ping", timestamp: Date.now() }),
            );
          }
        }, heartbeatInterval);
      }

      // Handle incoming messages
      socket.on("message", async (raw: Buffer | string) => {
        // Message size cap — drop oversized messages
        const rawSize = typeof raw === "string" ? Buffer.byteLength(raw) : raw.length;
        if (rawSize > maxMessageBytes) {
          socket.send(
            JSON.stringify({ type: "error", error: "Message too large" }),
          );
          return;
        }

        try {
          const msg: WebSocketMessage = JSON.parse(
            typeof raw === "string" ? raw : raw.toString(),
          );

          switch (msg.type) {
            case "subscribe": {
              const room = msg.resource ?? msg.channel;
              if (room) {
                // Subscription limit per client
                if (client.subscriptions.size >= maxSubscriptionsPerClient) {
                  socket.send(
                    JSON.stringify({
                      type: "error",
                      channel: room,
                      error: "Subscription limit reached",
                    }),
                  );
                  break;
                }

                // Room authorization policy
                if (roomPolicy) {
                  const allowed = await roomPolicy(client, room);
                  if (!allowed) {
                    socket.send(
                      JSON.stringify({
                        type: "error",
                        channel: room,
                        error: "Subscription denied",
                      }),
                    );
                    break;
                  }
                }

                const ok = rooms.subscribe(clientId, room);
                socket.send(
                  JSON.stringify({
                    type: ok ? "subscribed" : "error",
                    channel: room,
                    ...(ok ? {} : { error: "Room at capacity" }),
                  }),
                );
              }
              break;
            }

            case "unsubscribe": {
              const room = msg.resource ?? msg.channel;
              if (room) {
                rooms.unsubscribe(clientId, room);
                socket.send(
                  JSON.stringify({ type: "unsubscribed", channel: room }),
                );
              }
              break;
            }

            case "pong":
              // Heartbeat response, ignore
              break;

            default:
              // Forward to custom handler
              await onMessage?.(client, msg);
              break;
          }
        } catch {
          socket.send(
            JSON.stringify({ type: "error", error: "Invalid message format" }),
          );
        }
      });

      // Cleanup on disconnect
      socket.on("close", async () => {
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        await onDisconnect?.(client);
        rooms.removeClient(clientId);
      });

      socket.on("error", () => {
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        rooms.removeClient(clientId);
      });
    },
  );

  // Stats endpoint (opt-in)
  if (exposeStats === true) {
    fastify.get(`${path}/stats`, async () => {
      return { success: true, data: rooms.getStats() };
    });
  } else if (exposeStats === "authenticated") {
    if (fastify.hasDecorator("authenticate")) {
      fastify.get(
        `${path}/stats`,
        { preHandler: fastify.authenticate } as any,
        async () => {
          return { success: true, data: rooms.getStats() };
        },
      );
    } else {
      fastify.log.warn(
        'arc-websocket: exposeStats is "authenticated" but fastify.authenticate is not registered — stats endpoint skipped',
      );
    }
  }

  // Cleanup on server close — unsubscribe event handlers to prevent leaks
  fastify.addHook("onClose", async () => {
    for (const unsub of eventUnsubscribers) {
      unsub();
    }
    eventUnsubscribers.length = 0;
  });
};

/** Pluggable WebSocket integration for Arc */
export const websocketPlugin = fp(websocketPluginImpl, {
  name: "arc-websocket",
  fastify: "5.x",
}) as FastifyPluginAsync<WebSocketPluginOptions>;
export default websocketPlugin;
