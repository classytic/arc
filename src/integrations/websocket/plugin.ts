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
import { createTruncator, DEFAULT_MAX_OUTBOUND_BYTES } from "./outbound-truncate.js";
import { PushRefRegistry } from "./pushref-registry.js";
import { RoomManager } from "./room-manager.js";
import { safeAsync } from "./safe-async.js";
import type { WebSocketPluginOptions } from "./types.js";

// Minimal socket/request shape that @fastify/websocket hands to the route
// handler. We avoid a typecheck-time dep on @fastify/websocket itself.
interface WsSocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  readyState: number;
  bufferedAmount?: number;
  ping?(data?: unknown): void;
  terminate?(): void;
  on(event: "message", cb: (raw: Buffer | string) => void): void;
  on(event: "close", cb: () => void): void;
  on(event: "error", cb: () => void): void;
  on(event: "pong", cb: (data: Buffer) => void): void;
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
    messageEnvelope = "raw",
    deadQueueSize = 128,
    pushRefTtlMs = 60_000,
    pushRefMaxEntries = 10_000,
    maxOutboundBytes = DEFAULT_MAX_OUTBOUND_BYTES,
  } = options;

  // Instance-scoped truncator — closes over this plugin's cap. Two
  // plugin registrations with different caps each get their own
  // truncator; no module state is shared between them.
  const truncate = createTruncator(maxOutboundBytes);

  // Auto-register @fastify/websocket if the host hasn't done it yet, so
  // websocketPlugin works standalone (same as event-gateway does).
  if (!fastify.hasDecorator("websocketServer")) {
    try {
      const wsPlugin = await import("@fastify/websocket");
      await fastify.register(wsPlugin.default ?? wsPlugin);
    } catch {
      throw new Error(
        "[arc-websocket] WebSocket support requires @fastify/websocket.\n" +
          "Install it: npm install @fastify/websocket",
      );
    }
  }

  // Fail-closed: throw early if auth required but no authenticator available.
  // This is the ONLY place this check belongs — `connection.ts` trusts that
  // by the time a socket connects, auth is wired or auth is off.
  if (auth && !customAuth && !fastify.hasDecorator("authenticate")) {
    throw new Error(
      "[arc-websocket] auth is true but fastify.authenticate is not registered. " +
        "Register an auth plugin before WebSocket, provide a custom authenticate function, or set auth: false.",
    );
  }

  // The registry owns the cross-connection state (envelope + dead queue
  // + principal binding) that has to outlive a single TCP socket.
  // Reconnects within `pushRefTtlMs` preserve the dead queue so RESUME
  // actually replays missed envelopes; past the window, the entry is GC'd.
  //
  // When `pushRefStore` is supplied (e.g. the Redis-backed store from
  // `@classytic/arc/integrations/websocket-pushref-redis`), the state
  // survives node-to-node reconnects too — a client originating on
  // Node A and reconnecting to Node B picks up the same dead queue.
  const pushRefRegistry = new PushRefRegistry({
    ttlMs: pushRefTtlMs,
    maxEntries: pushRefMaxEntries,
    ...(options.pushRefStore ? { store: options.pushRefStore } : {}),
  });
  const rooms = new RoomManager(
    maxClientsPerRoom,
    adapter ?? new LocalWebSocketAdapter(),
    pushRefRegistry,
    fastify.log,
  );

  // Wire adapter subscription — relay messages from other instances to local
  // clients. Channel prefixes are the wire contract; receiver dispatches on
  // them. The address-based routes (`pushref:`, `userid:`) are no-ops on
  // every instance except the owner — the address lookup itself is the
  // ownership check (n8n's `hasPushRef`-guarded receiver pattern).
  if (adapter) {
    await adapter.subscribe((room, message) => {
      if (room.startsWith("org:")) {
        const parts = room.split(":");
        const orgId = parts[1];
        if (!orgId) return;
        const actualRoom = parts.slice(2).join(":");
        rooms.broadcastToOrg(orgId, actualRoom, message);
      } else if (room.startsWith("pushref-rt:")) {
        rooms.sendRealtimeToPushRef(room.slice("pushref-rt:".length), message);
      } else if (room.startsWith("pushref:")) {
        const id = room.slice("pushref:".length);
        const delivered = rooms.sendToPushRef(id, message);
        if (!delivered) {
          try {
            safeAsync(
              pushRefRegistry.stageForResume(id, JSON.parse(message)),
              fastify.log,
              "registry.stageForResume.relay",
              { pushRef: id },
            );
          } catch {
            /* malformed relay frame — drop */
          }
        }
      } else if (room.startsWith("fence:")) {
        // Cluster fence: another node accepted a newer connection for
        // this pushRef. Close our local socket so the new owner is the
        // single authoritative live writer. The fenced socket's close
        // handler will release the registry binding (which is now safe
        // because the new owner has already bumped the generation).
        const id = room.slice("fence:".length);
        const stale = rooms.getClientByPushRef(id);
        if (stale) {
          stale.socket.close(4011, "Superseded by newer connection");
        }
      } else if (room.startsWith("userid-rt:")) {
        rooms.sendRealtimeToUser(room.slice("userid-rt:".length), message);
      } else if (room.startsWith("userid:")) {
        rooms.sendToUser(room.slice("userid:".length), message);
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
        const msg = truncate(JSON.stringify({ type: "broadcast", channel: room, data }));
        void rooms.broadcastWithAdapter(room, msg);
      },
      broadcastToOrg: (orgId: string, room: string, data: unknown) => {
        const msg = truncate(JSON.stringify({ type: "broadcast", channel: room, data }));
        void rooms.broadcastToOrgWithAdapter(orgId, room, msg);
      },
      // Addressed sends. `send` is ordered/critical, `sendRealtime` is
      // droppable + coalesce-by-key. The `*ToUser` variants fan out to
      // every open tab/device for that user.
      //
      // Offline-staging contract: when `pushRef` is addressed and no
      // live client owns it, the payload is wrapped into the orphan
      // envelope's dead queue (if seq mode is on). The reconnect's
      // `resume` then replays it. Without staging, a critical message
      // sent during a brief disconnect would be silently lost — that
      // was the 2.17.2 review's High-1 finding.
      send: (target: { pushRef?: string; userId?: string }, data: unknown) => {
        const payload = { type: "direct", data };
        const msg = truncate(JSON.stringify(payload));
        if (target.pushRef) {
          // Three-step routing — the 2.17.2 review surfaced that the
          // previous shape skipped the cross-instance relay when the
          // pushRef was not local. Symmetric handling on send and
          // receive sides ensures the message reaches a live client on
          // ANY node, OR stages into the orphan envelope on whichever
          // node owns the registry entry.
          //
          //   1. Local live delivery (no-op when client is on another node)
          //   2. Local orphan staging (no-op when registry entry is on another node)
          //   3. Adapter publish so every other node tries (1) + (2) too
          //
          // Self-guarded: `sendToPushRef` returns false when no client
          // is local; `stageForResume` returns false when no registry
          // entry is local. Both calls are cheap and idempotent.
          const localDelivered = rooms.sendToPushRef(target.pushRef, msg);
          if (!localDelivered) {
            safeAsync(
              pushRefRegistry.stageForResume(target.pushRef, payload),
              fastify.log,
              "registry.stageForResume",
              { pushRef: target.pushRef },
            );
          }
          if (adapter) {
            safeAsync(
              adapter.publish(`pushref:${target.pushRef}`, msg),
              fastify.log,
              "adapter.publish",
              { kind: "pushref" },
            );
          }
          return;
        }
        if (target.userId) return void rooms.sendToUserWithAdapter(target.userId, msg);
      },
      sendRealtime: (
        target: { pushRef?: string; userId?: string },
        data: unknown,
        coalesceKey?: string,
      ) => {
        const msg = truncate(JSON.stringify({ type: "direct", data }));
        if (target.pushRef)
          return void rooms.sendRealtimeToPushRefWithAdapter(target.pushRef, msg, coalesceKey);
        if (target.userId)
          return void rooms.sendRealtimeToUserWithAdapter(target.userId, msg, coalesceKey);
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
    pushRefRegistry,
    nextClientId: () => `ws_${++clientCounter}_${Date.now()}`,
    fence: (pushRef: string, _generation: number) => {
      if (adapter) {
        // Generation is reserved for future "ignore stale fences" logic;
        // the current contract is "any fence closes the local socket".
        // Adapter publish is best-effort — bare void is fine because
        // missed fences would only mean a duplicate-active window until
        // the next claim, not data corruption.
        safeAsync(adapter.publish(`fence:${pushRef}`, ""), fastify.log, "fence.publish", {
          pushRef,
        });
      }
    },
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
      messageEnvelope,
      deadQueueSize,
    },
  };

  // The `{ websocket: true }` option and the `(socket, request)` handler
  // shape come from @fastify/websocket, which augments Fastify's route
  // shorthand via declaration merging. Arc doesn't take a typecheck-time
  // dep on that package (see ADR in types.ts), so the registration goes
  // through a single narrowed overload here. One boundary, documented —
  // the cast routes through `unknown` so neither the route options nor
  // the handler shape leaks `any` outward.
  type WsRouteRegistrar = (
    path: string,
    opts: { websocket: true },
    handler: (socket: WsSocketLike, request: unknown) => unknown,
  ) => void;
  (fastify.get as unknown as WsRouteRegistrar)(
    path,
    { websocket: true },
    async (socket, request) => {
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
