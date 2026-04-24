/**
 * Per-connection lifecycle handler.
 *
 * Runs for every WebSocket upgrade accepted by the plugin's Fastify route.
 * Orchestrates the 5-phase lifecycle:
 *
 *   1. authenticate (handshake)     → accept or close(4001)
 *   2. register client, fire onConnect
 *   3. start heartbeat + reauth timers
 *   4. wire message handler (subscribe / unsubscribe / pong / custom)
 *   5. cleanup on close/error (clear timers, fire onDisconnect, remove from rooms)
 *
 * Keeps the plugin orchestrator (`plugin.ts`) thin — it just wires options,
 * creates a `RoomManager`, subscribes to the event bus, and hands each
 * connection off to `handleConnection`.
 *
 * The `socket` / `request` parameter types are `unknown`-boxed because
 * @fastify/websocket isn't a typecheck-time dependency. The shapes used
 * are documented inline.
 */

import type { FastifyInstance } from "fastify";
import { authenticateWebSocket } from "./auth.js";
import type { RoomManager } from "./room-manager.js";
import type { WebSocketClient, WebSocketMessage, WebSocketPluginOptions } from "./types.js";

interface SocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  readyState: number;
  on(event: "message", cb: (raw: Buffer | string) => void): void;
  on(event: "close", cb: () => void): void;
  on(event: "error", cb: () => void): void;
}

export interface ConnectionContext {
  fastify: FastifyInstance;
  rooms: RoomManager;
  options: Required<
    Pick<
      WebSocketPluginOptions,
      | "auth"
      | "resources"
      | "heartbeatInterval"
      | "maxClientsPerRoom"
      | "maxMessageBytes"
      | "maxSubscriptionsPerClient"
      | "reauthInterval"
    >
  > & {
    authenticate: WebSocketPluginOptions["authenticate"];
    roomPolicy: WebSocketPluginOptions["roomPolicy"];
    onConnect: WebSocketPluginOptions["onConnect"];
    onDisconnect: WebSocketPluginOptions["onDisconnect"];
    onMessage: WebSocketPluginOptions["onMessage"];
  };
  /** Next client ID to mint. Incremented per connection. */
  nextClientId: () => string;
}

export async function handleConnection(
  ctx: ConnectionContext,
  socket: SocketLike,
  request: unknown,
): Promise<void> {
  const { fastify, rooms, options } = ctx;
  const clientId = ctx.nextClientId();

  // ── 1. Authenticate (handshake) ─────────────────────────────────────────
  let userId: string | undefined;
  let organizationId: string | undefined;
  let serviceClientId: string | undefined;
  let serviceScopes: readonly string[] | undefined;

  if (options.auth) {
    const result = await authenticateWebSocket(fastify, request, options.authenticate);
    if (!result) {
      socket.close(4001, "Unauthorized");
      return;
    }
    userId = result.userId;
    organizationId = result.organizationId;
    serviceClientId = result.clientId;
    serviceScopes = result.scopes;

    // Custom authenticator that returned successfully but without user info
    // is still "authenticated" (machine-to-machine flows may omit userId).
    // The default fastify.authenticate path already enforces user presence
    // inside `authenticateWebSocket` — it returns null when user is absent.
  }

  const client: WebSocketClient = {
    id: clientId,
    socket,
    subscriptions: new Set(),
    userId,
    organizationId,
    ...(serviceClientId ? { clientId: serviceClientId } : {}),
    ...(serviceScopes ? { scopes: serviceScopes } : {}),
  };

  rooms.addClient(client);
  await options.onConnect?.(client);

  // Connection confirmation
  socket.send(
    JSON.stringify({
      type: "connected",
      clientId,
      resources: options.resources,
    }),
  );

  // ── 2. Heartbeat timer ──────────────────────────────────────────────────
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  if (options.heartbeatInterval > 0) {
    heartbeatTimer = setInterval(() => {
      if (socket.readyState === 1) {
        socket.send(JSON.stringify({ type: "ping", timestamp: Date.now() }));
      }
    }, options.heartbeatInterval);
  }

  // ── 3. Periodic re-authentication loop ──────────────────────────────────
  let reauthTimer: ReturnType<typeof setInterval> | undefined;
  if (options.reauthInterval > 0 && options.auth) {
    reauthTimer = setInterval(async () => {
      if (socket.readyState !== 1) return;
      const result = await authenticateWebSocket(fastify, request, options.authenticate);
      if (!result) {
        socket.send(JSON.stringify({ type: "error", error: "Session expired" }));
        socket.close(4003, "Session expired");
      }
    }, options.reauthInterval);
  }

  // ── 4. Message handler ──────────────────────────────────────────────────
  socket.on("message", async (raw: Buffer | string) => {
    // Message size cap — drop oversized messages
    const rawSize = typeof raw === "string" ? Buffer.byteLength(raw) : raw.length;
    if (rawSize > options.maxMessageBytes) {
      socket.send(JSON.stringify({ type: "error", error: "Message too large" }));
      return;
    }

    let msg: WebSocketMessage;
    try {
      msg = JSON.parse(typeof raw === "string" ? raw : raw.toString()) as WebSocketMessage;
    } catch {
      socket.send(JSON.stringify({ type: "error", error: "Invalid message format" }));
      return;
    }

    switch (msg.type) {
      case "subscribe": {
        const room = msg.resource ?? msg.channel;
        if (!room) break;

        // Subscription limit per client
        if (client.subscriptions.size >= options.maxSubscriptionsPerClient) {
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
        if (options.roomPolicy) {
          const allowed = await options.roomPolicy(client, room);
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
        break;
      }

      case "unsubscribe": {
        const room = msg.resource ?? msg.channel;
        if (room) {
          rooms.unsubscribe(clientId, room);
          socket.send(JSON.stringify({ type: "unsubscribed", channel: room }));
        }
        break;
      }

      case "pong":
        // Heartbeat response, ignore
        break;

      default:
        // Forward to custom handler
        await options.onMessage?.(client, msg);
        break;
    }
  });

  // ── 5. Cleanup on disconnect ────────────────────────────────────────────
  socket.on("close", async () => {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (reauthTimer) clearInterval(reauthTimer);
    await options.onDisconnect?.(client);
    rooms.removeClient(clientId);
  });

  socket.on("error", () => {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (reauthTimer) clearInterval(reauthTimer);
    rooms.removeClient(clientId);
  });
}
