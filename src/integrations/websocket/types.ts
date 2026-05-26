/**
 * WebSocket integration — public type surface.
 *
 * All interfaces used across the websocket/* submodules live here so there's
 * one canonical declaration site. The plugin implementation, room manager,
 * auth helper, and connection handler all import from this file.
 */

import type { WebSocketAdapter } from "./adapter.js";
import type { EnvelopeWriter } from "./envelope.js";
import type { SendQueue } from "./send-queue.js";

/**
 * A connected WebSocket client — one entry per TCP socket.
 *
 * `subscriptions` is mutated by `RoomManager`; other fields are set once at
 * handshake time and treated as effectively immutable for the lifetime of
 * the connection.
 */
export interface WebSocketClient {
  /**
   * Transport-level connection ID (one per TCP socket). Stable for the
   * lifetime of THIS connection only — a reconnect mints a new `id`.
   */
  id: string;
  /**
   * Session reference — stable across reconnects, distinct from `userId`.
   * One user with three browser tabs = three `pushRef`s, one `userId`.
   * Routing layer keys off this for "send to THIS tab" semantics.
   *
   * Clients MAY supply their own pushRef via the `?pushRef=` query param
   * on the upgrade URL (e.g. resumed reconnect); otherwise the server mints
   * one at handshake time.
   */
  pushRef: string;
  socket: {
    send(data: string): void;
    close(code?: number, reason?: string): void;
    readyState: number;
    bufferedAmount?: number;
    /** RFC 6455 §5.5.2 ping control frame. Browsers auto-respond at the protocol layer. */
    ping?(data?: unknown): void;
    /** Immediate socket destroy — no Close frame, no flush. Use for zombies. */
    terminate?(): void;
  };
  subscriptions: Set<string>;
  userId?: string;
  organizationId?: string;
  /** OAuth client ID — present for service/machine-to-machine connections */
  clientId?: string;
  /** OAuth scopes — present for service/machine-to-machine connections */
  scopes?: readonly string[];
  metadata?: Record<string, unknown>;
  /**
   * Outbound send queue — created at connect time, disposed on close.
   * `RoomManager.send/sendRealtime` enqueue via this; the raw
   * `client.socket.send()` path bypasses queue/coalesce/overflow policy
   * and should only be used for the connection-lifecycle handshake.
   */
  queue?: SendQueue;
  /**
   * Sequence-numbered envelope writer + dead queue. Present iff the
   * plugin was started with `messageEnvelope: 'seq'`. Critical sends are
   * wrapped via this so the client can RESUME after reconnect.
   */
  envelope?: EnvelopeWriter;
  /**
   * Connection generation captured at claim time. The fence + CAS
   * write paths use this — every release/persist passes it so the
   * store can refuse stale writes from a connection that's been
   * superseded by a newer claim on another node.
   */
  generation: number;
}

export interface WebSocketMessage {
  type: string;
  resource?: string;
  channel?: string;
  data?: unknown;
}

/**
 * Result of a successful authentication. The plugin's handshake and the
 * optional re-auth loop both return this shape so the downstream code
 * doesn't branch on auth mode. `null` means rejected.
 */
export interface AuthResult {
  userId?: string;
  organizationId?: string;
  /** Set for machine-to-machine / service account auth */
  clientId?: string;
  /** OAuth scopes for service accounts */
  scopes?: readonly string[];
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
  authenticate?: (request: unknown) => Promise<AuthResult | null>;
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
  roomPolicy?: (client: WebSocketClient, room: string) => boolean | Promise<boolean>;
  /** Maximum message size in bytes from client (default: 16384 = 16KB). Messages exceeding this are dropped. */
  maxMessageBytes?: number;
  /** Maximum subscriptions per client (default: 100). Prevents resource exhaustion. */
  maxSubscriptionsPerClient?: number;
  /**
   * Periodic re-authentication interval in ms (default: 0 = disabled).
   * When set, the server periodically re-validates the client's auth token.
   * If the token is expired/revoked, the client is disconnected with code 4003.
   *
   * Recommended: 300000 (5 minutes) for production.
   *
   * @example
   * ```typescript
   * websocketPlugin({ reauthInterval: 5 * 60 * 1000 }) // re-check every 5 min
   * ```
   */
  reauthInterval?: number;
  /** Custom message handler */
  onMessage?: (client: WebSocketClient, message: WebSocketMessage) => void | Promise<void>;
  /** Called when a client connects */
  onConnect?: (client: WebSocketClient) => void | Promise<void>;
  /** Called when a client disconnects */
  onDisconnect?: (client: WebSocketClient) => void | Promise<void>;
  /**
   * Cross-instance broadcast adapter (default: LocalWebSocketAdapter — single-instance only).
   * Provide a RedisWebSocketAdapter for multi-instance deployments.
   *
   * @example
   * ```typescript
   * import { RedisWebSocketAdapter } from '@classytic/arc/integrations/websocket-redis';
   * adapter: new RedisWebSocketAdapter(redis, { channel: 'arc-ws' })
   * ```
   */
  adapter?: WebSocketAdapter;
  /**
   * Outbound message wire format.
   *   - `'raw'` (default): write payloads as-is — no envelope, no replay.
   *   - `'seq'`: wrap every critical send in `{seq, t, msg}`. The dead
   *     queue of the last N envelopes is owned by the **PushRefRegistry**
   *     (per-pushRef / per-session, NOT per-connection) so a client
   *     reconnecting under the same pushRef within `pushRefTtlMs` can
   *     RESUME via `{type:'resume', lastSeq}` and replay missed messages
   *     across the disconnect — not just within a single socket.
   *
   * Opt-in to preserve compatibility with existing clients. Set to
   * `'seq'` for chat, ride-status, payment flows — anything where a
   * message lost mid-disconnect is a real bug.
   */
  messageEnvelope?: "raw" | "seq";
  /** Dead queue size (per pushRef) when `messageEnvelope: 'seq'`. Defaults to 128. */
  deadQueueSize?: number;
  /**
   * Time (ms) a released pushRef stays in the registry waiting for a
   * reconnect to RESUME against its envelope + dead queue. Past this
   * window the entry is GC'd. Default `60_000` (60 s) — typical mobile
   * lock-screen + carrier-handoff reconnect window.
   */
  pushRefTtlMs?: number;
  /**
   * Hard cap on pushRef registry entries. When full, the longest-inactive
   * entry is evicted to make room. Default `10_000` — sized for a single
   * Node process supporting tens of thousands of concurrent users with
   * tab-level granularity.
   */
  pushRefMaxEntries?: number;
  /**
   * Maximum bytes per outbound frame. Payloads exceeding this are
   * replaced with a `{type:'truncated', originalBytes, hint}` placeholder
   * so a misbehaving server-side emitter can't pin socket buffers across
   * the fleet. Default `5 * 1024 * 1024` (5 MiB) — same as n8n's
   * `relayViaPubSub` ceiling. Hosts may tighten for low-bandwidth tiers.
   */
  maxOutboundBytes?: number;
  /**
   * Optional external store for cross-instance pushRef state. When
   * provided, the envelope + dead queue survive reconnects to ANY node
   * in the cluster (not just the originator). See
   * `@classytic/arc/integrations/websocket-pushref-redis` for the
   * Redis-backed implementation.
   *
   * Without this, the in-memory registry is per-process — fine for
   * single-node deployments OR sticky-session load balancing, but a
   * client reconnecting through a different node loses dead-queue
   * state.
   */
  pushRefStore?: import("./pushref-registry.js").PushRefStore;
}
