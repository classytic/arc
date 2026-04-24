/**
 * @classytic/arc — WebSocket Integration (public entry)
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
 *   resources: ['product', 'order'],
 *   heartbeatInterval: 30000,
 * });
 * ```
 *
 * ## Module layout
 *
 * Implementation was split from a single 680-LOC file (with two duplicated
 * `fakeReply` auth shims) into focused submodules:
 *
 *   - `./websocket/types.ts`        — public interfaces
 *   - `./websocket/adapter.ts`      — `WebSocketAdapter` + `LocalWebSocketAdapter`
 *   - `./websocket/room-manager.ts` — `RoomManager` subscription bookkeeping
 *   - `./websocket/auth.ts`         — single boundary for handshake + re-auth
 *   - `./websocket/connection.ts`   — per-socket lifecycle (handshake → close)
 *   - `./websocket/event-bridge.ts` — event bus wiring + stats endpoint
 *   - `./websocket/plugin.ts`       — thin orchestrator
 *
 * This file is the public surface — re-exports what apps import.
 */

export type { WebSocketAdapter } from "./websocket/adapter.js";
export { LocalWebSocketAdapter } from "./websocket/adapter.js";
export { websocketPlugin } from "./websocket/plugin.js";
export { RoomManager } from "./websocket/room-manager.js";
export type {
  AuthResult,
  WebSocketClient,
  WebSocketMessage,
  WebSocketPluginOptions,
} from "./websocket/types.js";
