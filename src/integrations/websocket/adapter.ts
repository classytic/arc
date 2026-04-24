/**
 * WebSocket cross-instance adapter contract.
 *
 * The adapter is NOT used for local broadcasts — `RoomManager` handles those.
 * The adapter only handles the cross-instance relay (Redis pub/sub, NATS, etc.)
 * so a message broadcast on instance A is also delivered to clients connected
 * to instance B.
 *
 * Implementations:
 *   - `LocalWebSocketAdapter` (here) — no-op, single-instance only
 *   - `RedisWebSocketAdapter` (@classytic/arc/integrations/websocket-redis)
 *
 * Custom adapters just need to satisfy the interface.
 */

/**
 * Adapter interface for cross-instance WebSocket broadcast.
 *
 * - `publish()`: Send a message to all instances (via Redis, NATS, etc.)
 * - `subscribe()`: Receive messages from other instances
 * - `close()`: Clean up connections
 */
export interface WebSocketAdapter {
  /** Adapter name for logging */
  readonly name: string;
  /** Publish a room broadcast to all other instances */
  publish(room: string, message: string): Promise<void>;
  /** Subscribe to broadcasts from other instances */
  subscribe(callback: (room: string, message: string) => void): Promise<void>;
  /** Close adapter connections */
  close(): Promise<void>;
}

/**
 * Default adapter — no cross-instance broadcast (single-instance only).
 * All methods are no-ops. Used when no adapter is configured.
 */
export class LocalWebSocketAdapter implements WebSocketAdapter {
  readonly name = "local";
  async publish(): Promise<void> {}
  async subscribe(): Promise<void> {}
  async close(): Promise<void> {}
}
