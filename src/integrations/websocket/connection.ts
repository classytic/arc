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

import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import sjson from "secure-json-parse";
import { authenticateWebSocket } from "./auth.js";
import { DeadQueue } from "./dead-queue.js";
import { EnvelopeWriter } from "./envelope.js";
import { derivePrincipal, type PushRefRegistry } from "./pushref-registry.js";
import type { RoomManager } from "./room-manager.js";
import { safeAsync } from "./safe-async.js";
import { SendQueue } from "./send-queue.js";
import type { WebSocketClient, WebSocketMessage, WebSocketPluginOptions } from "./types.js";

interface SocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  readyState: number;
  bufferedAmount?: number;
  /** RFC 6455 §5.5.2 ping control frame (provided by the `ws` library). */
  ping?(data?: unknown): void;
  /** Immediate destroy — no Close frame. Use for zombies that never pong. */
  terminate?(): void;
  on(event: "message", cb: (raw: Buffer | string) => void): void;
  on(event: "close", cb: () => void): void;
  on(event: "error", cb: () => void): void;
  on(event: "pong", cb: (data: Buffer) => void): void;
}

/** Extract a client-supplied pushRef from the upgrade URL, if any. */
function readPushRefFromRequest(request: unknown): string | undefined {
  const req = request as { url?: string; query?: { pushRef?: unknown } } | undefined;
  // Fastify parses querystring onto `request.query` by the time the WS
  // upgrade handler runs; fall back to URL parse for safety.
  const fromQuery = req?.query?.pushRef;
  if (typeof fromQuery === "string" && fromQuery.length > 0 && fromQuery.length <= 128) {
    return fromQuery;
  }
  if (req?.url) {
    try {
      const u = new URL(req.url, "http://x");
      const v = u.searchParams.get("pushRef");
      if (v && v.length > 0 && v.length <= 128) return v;
    } catch {}
  }
  return undefined;
}

export interface ConnectionContext {
  fastify: FastifyInstance;
  rooms: RoomManager;
  pushRefRegistry: PushRefRegistry;
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
    messageEnvelope: "raw" | "seq";
    deadQueueSize: number;
  };
  /** Next client ID to mint. Incremented per connection. */
  nextClientId: () => string;
  /**
   * Cluster-wide fence — close any socket on another node that still
   * holds the named pushRef. Implemented by the plugin via adapter
   * publish on a `fence:` prefix; LocalWebSocketAdapter is a no-op.
   */
  fence?: (pushRef: string, generation: number) => void;
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

  // pushRef acquisition — claim through the registry so the envelope +
  // dead queue survive across reconnects within the TTL window, AND so
  // the pushRef is bound to the authenticated principal (preventing
  // another user from hijacking by guessing the URL parameter).
  //
  // Three outcomes from `claim()`:
  //   - 'new'      → fresh entry; envelope minted via the callback
  //   - 'resumed'  → same principal reconnected; existing envelope reused,
  //                  so the client's `resume` request can replay
  //   - 'rejected' → principal mismatch (hijack attempt OR registry full
  //                  with all active entries); we mint a fresh pushRef
  //                  and retry, ignoring the URL claim
  const principal = derivePrincipal({
    userId,
    clientId: serviceClientId,
    authMode: options.auth,
  });
  const mintEnvelope =
    options.messageEnvelope === "seq"
      ? () => new EnvelopeWriter(new DeadQueue(options.deadQueueSize))
      : undefined;
  const urlPushRef = readPushRefFromRequest(request);

  let pushRef: string;
  let envelope: EnvelopeWriter | undefined;
  let resumed = false;
  /**
   * Connection generation — monotonic per-pushRef counter the registry
   * bumps on every claim. Used by the fence path: after we claim with
   * a higher generation than any prior live owner, we publish
   * `fence:<pushRef>` so OTHER nodes close their stale socket too.
   */
  let generation = 1;
  let supersededActive = false;

  // Security gate (2.17.2 review fix): when auth is enabled but the
  // auth handler returned no stable identity (e.g., org-only token),
  // `principal` is null. We refuse to accept URL pushRef claims under
  // a shared namespace — instead, mint a fresh pushRef and bind it to
  // a connection-unique principal (`conn:<pushRef>`). This guarantees
  // no other connection can ever claim or resume against it.
  const claimOpts = {
    envelopeMode: options.messageEnvelope,
    deadQueueSize: options.deadQueueSize,
  } as const;

  if (principal === null) {
    pushRef = `ps_${randomUUID()}`;
    const fresh = await ctx.pushRefRegistry.claim(pushRef, `conn:${pushRef}`, claimOpts);
    if (fresh.outcome === "rejected") {
      socket.close(1011, "pushRef registry capacity");
      return;
    }
    envelope = fresh.envelope;
    if (fresh.outcome === "new" || fresh.outcome === "resumed") generation = fresh.generation;
  } else if (urlPushRef !== undefined) {
    const claim = await ctx.pushRefRegistry.claim(urlPushRef, principal, claimOpts);
    if (claim.outcome === "rejected") {
      pushRef = `ps_${randomUUID()}`;
      const fresh = await ctx.pushRefRegistry.claim(pushRef, principal, claimOpts);
      if (fresh.outcome === "rejected") {
        socket.close(1011, "pushRef registry capacity");
        return;
      }
      envelope = fresh.envelope;
      if (fresh.outcome === "new" || fresh.outcome === "resumed") generation = fresh.generation;
    } else {
      pushRef = urlPushRef;
      envelope = claim.envelope;
      resumed = claim.outcome === "resumed";
      generation = claim.generation;
      if (claim.outcome === "resumed") supersededActive = claim.supersededActive;
    }
  } else {
    pushRef = `ps_${randomUUID()}`;
    const fresh = await ctx.pushRefRegistry.claim(pushRef, principal, claimOpts);
    if (fresh.outcome === "rejected") {
      socket.close(1011, "pushRef registry capacity");
      return;
    }
    envelope = fresh.envelope;
    if (fresh.outcome === "new" || fresh.outcome === "resumed") generation = fresh.generation;
  }

  // Fence path: a resumed claim against a still-active entry means the
  // previous owner socket is somewhere in the cluster (possibly on this
  // node, possibly another). Close any local one immediately; let the
  // adapter publish broadcast cluster-wide so other nodes do the same.
  // Without this, two sockets would race nextSeq + persist on the same
  // EnvelopeWriter — that's the 2.17.2 review's HIGH-2 finding.
  if (supersededActive) {
    const stale = rooms.getClientByPushRef(pushRef);
    if (stale && stale.socket !== socket) {
      stale.socket.close(4011, "Superseded by newer connection");
    }
    ctx.fence?.(pushRef, generation);
  }

  const queue = new SendQueue(socket);

  const client: WebSocketClient = {
    id: clientId,
    pushRef,
    socket,
    subscriptions: new Set(),
    userId,
    organizationId,
    ...(serviceClientId ? { clientId: serviceClientId } : {}),
    ...(serviceScopes ? { scopes: serviceScopes } : {}),
    queue,
    ...(envelope ? { envelope } : {}),
    generation,
  };

  rooms.addClient(client);
  await options.onConnect?.(client);

  // Connection confirmation — bare (not enveloped) because the client
  // hasn't sent its `lastSeq` yet. Includes `envelope: 'seq'` flag so
  // the client knows to expect wrapped frames, and `resumed: true` when
  // the pushRef carried over surviving envelope state (so the client
  // knows to send a `resume` message with its lastSeq).
  socket.send(
    JSON.stringify({
      type: "connected",
      clientId,
      pushRef,
      resources: options.resources,
      ...(envelope ? { envelope: "seq" } : {}),
      ...(resumed ? { resumed: true } : {}),
    }),
  );

  // ── 2. Heartbeat — native RFC 6455 control frames ───────────────────────
  // The `ws` library auto-replies to incoming pings with pongs at the
  // protocol layer; browsers do the same. We send a ping, mark the socket
  // dead, and flip it back alive on `'pong'`. Next tick, if still dead,
  // the peer never responded — `terminate()` (RFC 6455 §7.1.7 — no Close
  // frame because the peer is presumed gone and would never ACK one).
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let isAlive = true;
  socket.on("pong", () => {
    isAlive = true;
  });
  if (options.heartbeatInterval > 0) {
    heartbeatTimer = setInterval(() => {
      if (socket.readyState !== 1) return;
      if (!isAlive) {
        // Zombie — never ponged. Destroy without graceful close.
        // (Native `terminate()` from the `ws` library skips the Close
        // handshake — correct per RFC 6455 §7.1.7 because the peer is
        // presumed dead and would never ACK a Close frame.)
        if (typeof socket.terminate === "function") {
          socket.terminate();
        } else {
          socket.close(4008, "Heartbeat timeout");
        }
        return;
      }
      isAlive = false;
      if (typeof socket.ping === "function") {
        socket.ping();
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
      // `sjson.parse` blocks `__proto__` / `constructor.prototype` in untrusted
      // client frames; any downstream `Object.assign(target, msg)` is safe.
      msg = sjson.parse(typeof raw === "string" ? raw : raw.toString()) as WebSocketMessage;
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

      case "resume": {
        const raw = msg as unknown as { lastSeq?: unknown };
        const lastSeq = typeof raw.lastSeq === "number" ? raw.lastSeq : -1;
        if (!envelope) {
          socket.send(JSON.stringify({ type: "resumed", lastSeq, replayed: 0 }));
          break;
        }
        const replay = envelope.drainAfter(lastSeq);
        if (replay === null) {
          socket.send(
            JSON.stringify({
              type: "resume_gap",
              lastSeq,
              highestSeq: envelope.highestSeq(),
            }),
          );
          break;
        }
        for (const payload of replay) socket.send(payload);
        socket.send(JSON.stringify({ type: "resumed", lastSeq, replayed: replay.length }));
        break;
      }

      default:
        // Forward to custom handler
        await options.onMessage?.(client, msg);
        break;
    }
  });

  // ── 5. Cleanup on disconnect ────────────────────────────────────────────
  // Stale-connection close guard: only purge the room manager if THIS
  // socket is still the one registered for this clientId. A reconnect
  // race can otherwise evict the *new* connection when the old close
  // fires late. The clientId is per-socket so this is theoretical here,
  // but the same guard at the room/pushRef level lands in PR2.
  socket.on("close", async () => {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (reauthTimer) clearInterval(reauthTimer);
    if (rooms.getClient(clientId)?.socket === socket) {
      await options.onDisconnect?.(client);
      rooms.removeClient(clientId);
    }
    queue.dispose();
    // Release the registry binding ONLY if no live socket currently owns
    // this pushRef. A faster reconnect under the same pushRef has already
    // re-activated the entry via `claim()` — calling release() here
    // would start a TTL countdown while the new connection is live,
    // causing premature eviction.
    if (!rooms.getClientByPushRef(pushRef)) {
      // Close handlers are sync — wrap async release with safeAsync so
      // a store outage (Redis down) surfaces as a logged warning, not
      // an unhandled promise rejection.
      safeAsync(ctx.pushRefRegistry.release(pushRef, generation), fastify.log, "registry.release", {
        pushRef,
        generation,
      });
    }
  });

  socket.on("error", () => {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (reauthTimer) clearInterval(reauthTimer);
    if (rooms.getClient(clientId)?.socket === socket) {
      rooms.removeClient(clientId);
    }
    queue.dispose();
    if (!rooms.getClientByPushRef(pushRef)) {
      safeAsync(ctx.pushRefRegistry.release(pushRef, generation), fastify.log, "registry.release", {
        pushRef,
        generation,
      });
    }
  });
}
