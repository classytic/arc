/**
 * WebSocket integration — public type surface.
 *
 * All interfaces used across the websocket/* submodules live here so there's
 * one canonical declaration site. The plugin implementation, room manager,
 * auth helper, and connection handler all import from this file.
 */

import type { WebSocketAdapter } from "./adapter.js";

/**
 * A connected WebSocket client — one entry per TCP socket.
 *
 * `subscriptions` is mutated by `RoomManager`; other fields are set once at
 * handshake time and treated as effectively immutable for the lifetime of
 * the connection.
 */
export interface WebSocketClient {
  id: string;
  socket: { send(data: string): void; close(): void; readyState: number };
  subscriptions: Set<string>;
  userId?: string;
  organizationId?: string;
  /** OAuth client ID — present for service/machine-to-machine connections */
  clientId?: string;
  /** OAuth scopes — present for service/machine-to-machine connections */
  scopes?: readonly string[];
  metadata?: Record<string, unknown>;
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
}
