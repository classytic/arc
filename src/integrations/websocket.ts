/**
 * WebSocket integration — public surface, re-exporting `./websocket/*`.
 *
 * Wires `@fastify/websocket` into arc's resource system: room-based
 * subscriptions, auto-broadcast of resource CRUD events, arc auth/org scoping.
 * A separate subpath, loaded only when used. Peer: `@fastify/websocket`.
 *
 * ⚠ Needs PERSISTENT connections — not serverless (Lambda, Vercel). Use on
 * Docker / VPS / K8s / Cloud Run with min-instances > 0.
 *
 * Implementation splits into `types` · `adapter` · `room-manager` · `auth`
 * (the single handshake/re-auth boundary) · `connection` · `event-bridge` ·
 * `plugin`.
 *
 * @example
 * ```typescript
 * await fastify.register(websocketPlugin, {
 *   path: '/ws', auth: true, resources: ['product', 'order'],
 * });
 * ```
 */

// Public surface — keep tight. Internal helpers (SendQueue, DeadQueue,
// EnvelopeWriter, safeAsync, createTruncator, derivePrincipal) are NOT
// re-exported: hosts get them transitively through the plugin's
// decorated `app.ws` API and the option types below. Custom backends
// (Redis-backed pushRef stores, etc.) extend `PushRefStore` directly.
export type { WebSocketAdapter } from "./websocket/adapter.js";
export { LocalWebSocketAdapter } from "./websocket/adapter.js";
export type { GeoPoint, GeoPublishOpts, GeoRoomOptions } from "./websocket/geo-room.js";
export { GeoRoom } from "./websocket/geo-room.js";
export { websocketPlugin } from "./websocket/plugin.js";
export {
  MemoryPushRefStore,
  type Principal,
  PushRefRegistry,
  type PushRefRegistryOptions,
  type PushRefStore,
  type SerializedEntry,
} from "./websocket/pushref-registry.js";
export { RoomManager } from "./websocket/room-manager.js";
export type {
  AuthResult,
  WebSocketClient,
  WebSocketMessage,
  WebSocketPluginOptions,
} from "./websocket/types.js";
