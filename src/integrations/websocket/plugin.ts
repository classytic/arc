/**
 * WebSocket plugin orchestrator.
 *
 * Thin composition layer — resolves options, creates the room manager, wires
 * the adapter + event bus, registers the stats route, and delegates every
 * connection to `handleConnection`. The real logic lives in the submodules:
 *
 *   - `room-manager.ts` — subscription bookkeeping + broadcast
 *   - `auth.ts`         — single auth boundary for handshake + re-auth
 *   - `connection.ts`   — per-socket lifecycle
 *   - `event-bridge.ts` — bus → rooms + stats route
 *
 * Pre-split this was a 680-LOC file doing all seven jobs inline, with two
 * duplicated `fakeReply` shims on the auth path. The decomposition here
 * keeps each unit focused, typed, and individually testable.
 */

import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import { LocalWebSocketAdapter } from "./adapter.js";
import type { ConnectionContext } from "./connection.js";
import { handleConnection } from "./connection.js";
import { registerStatsRoute, wireResourceEvents } from "./event-bridge.js";
import { RoomManager } from "./room-manager.js";
import type { WebSocketPluginOptions } from "./types.js";

// Minimal socket/request shape that @fastify/websocket hands to the route
// handler. We avoid a typecheck-time dep on @fastify/websocket itself.
interface WsSocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  readyState: number;
  on(event: "message", cb: (raw: Buffer | string) => void): void;
  on(event: "close", cb: () => void): void;
  on(event: "error", cb: () => void): void;
}

const websocketPluginImpl: FastifyPluginAsync<WebSocketPluginOptions> = async (
  fastify: FastifyInstance,
  options: WebSocketPluginOptions,
) => {
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
    reauthInterval = 0,
    adapter,
    exposeStats = false,
    onMessage,
    onConnect,
    onDisconnect,
  } = options;

  // Fail-closed: throw early if auth required but no authenticator available.
  // This is the ONLY place this check belongs — `connection.ts` trusts that
  // by the time a socket connects, auth is wired or auth is off.
  if (auth && !customAuth && !fastify.hasDecorator("authenticate")) {
    throw new Error(
      "[arc-websocket] auth is true but fastify.authenticate is not registered. " +
        "Register an auth plugin before WebSocket, provide a custom authenticate function, or set auth: false.",
    );
  }

  const rooms = new RoomManager(maxClientsPerRoom, adapter ?? new LocalWebSocketAdapter());

  // Wire adapter subscription — relay messages from other instances to local
  // clients. The namespace prefix `org:<orgId>:<room>` is the contract
  // between `broadcastToOrgWithAdapter` and this subscriber.
  if (adapter) {
    await adapter.subscribe((room, message) => {
      if (room.startsWith("org:")) {
        const parts = room.split(":");
        const orgId = parts[1]!;
        const actualRoom = parts.slice(2).join(":");
        rooms.broadcastToOrg(orgId, actualRoom, message);
      } else {
        rooms.broadcast(room, message);
      }
    });
  }

  // Decorate fastify with room manager for external access. Only decorate
  // once — nested registrations share the outer decorator.
  if (!fastify.hasDecorator("ws")) {
    fastify.decorate("ws", {
      rooms,
      broadcast: (room: string, data: unknown) => {
        const msg = JSON.stringify({ type: "broadcast", channel: room, data });
        void rooms.broadcastWithAdapter(room, msg);
      },
      broadcastToOrg: (orgId: string, room: string, data: unknown) => {
        const msg = JSON.stringify({ type: "broadcast", channel: room, data });
        void rooms.broadcastToOrgWithAdapter(orgId, room, msg);
      },
      getStats: () => rooms.getStats(),
    });
  }

  // Wire event bus → room broadcasts for every declared resource.
  const eventUnsubscribers = await wireResourceEvents(fastify, rooms, resources);

  // Register WebSocket route. `{ websocket: true }` is the @fastify/websocket
  // hook — Fastify's base RouteShorthandOptions doesn't know about it, so
  // the cast lives here (one site, documented).
  let clientCounter = 0;
  const ctx: ConnectionContext = {
    fastify,
    rooms,
    nextClientId: () => `ws_${++clientCounter}_${Date.now()}`,
    options: {
      auth,
      resources,
      heartbeatInterval,
      maxClientsPerRoom,
      maxMessageBytes,
      maxSubscriptionsPerClient,
      reauthInterval,
      authenticate: customAuth,
      roomPolicy,
      onConnect,
      onDisconnect,
      onMessage,
    },
  };

  // The `{ websocket: true }` option and the `(socket, request)` handler
  // shape come from @fastify/websocket, which augments Fastify's route
  // shorthand via declaration merging. Arc doesn't take a typecheck-time
  // dep on that package (see ADR in types.ts), so the registration goes
  // through a single narrowed `any` here. One boundary, documented.
  //
  // biome-ignore lint/suspicious/noExplicitAny: @fastify/websocket route
  // signature — not worth a typecheck-time dependency on the peer package.
  (fastify.get as any)(
    path,
    { websocket: true },
    async (socket: WsSocketLike, request: unknown) => {
      await handleConnection(ctx, socket, request);
    },
  );

  // Register the optional stats endpoint.
  registerStatsRoute(fastify, rooms, path, exposeStats);

  // Cleanup on server close — unsubscribe event handlers to prevent leaks.
  fastify.addHook("onClose", async () => {
    for (const unsub of eventUnsubscribers) {
      unsub();
    }
    eventUnsubscribers.length = 0;
    if (adapter) {
      await adapter.close();
    }
  });
};

/** Pluggable WebSocket integration for Arc */
export const websocketPlugin = fp(websocketPluginImpl, {
  name: "arc-websocket",
  fastify: "5.x",
}) as FastifyPluginAsync<WebSocketPluginOptions>;
