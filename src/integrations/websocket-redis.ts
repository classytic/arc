/**
 * Redis WebSocket Adapter — Cross-Instance Broadcast via Redis Pub/Sub
 *
 * Enables WebSocket room broadcasts across multiple server instances.
 * Each instance publishes broadcasts to a Redis channel; all instances
 * subscribe and relay messages to their local clients.
 *
 * Requires: ioredis (peer dependency)
 *
 * @example
 * ```typescript
 * import { RedisWebSocketAdapter } from '@classytic/arc/integrations/websocket-redis';
 * import Redis from 'ioredis';
 *
 * const redis = new Redis(process.env.REDIS_URL);
 *
 * await app.register(websocketPlugin, {
 *   adapter: new RedisWebSocketAdapter(redis, { channel: 'arc-ws' }),
 *   resources: ['product', 'order'],
 * });
 * ```
 */

import type { WebSocketAdapter } from "./websocket.js";

// Minimal Redis interface — works with ioredis, node-redis wrappers, etc.
export interface RedisLike {
  publish(channel: string, message: string): Promise<number>;
  subscribe(...channels: string[]): Promise<unknown>;
  on(event: string, handler: (...args: unknown[]) => void): unknown;
  duplicate(): RedisLike;
  quit(): Promise<unknown>;
}

export interface RedisWebSocketAdapterOptions {
  /**
   * Redis channel for WebSocket broadcasts.
   * @default 'arc-ws'
   */
  channel?: string;

  /**
   * Unique instance ID to prevent echo (receiving own broadcasts).
   * Auto-generated if not provided.
   */
  instanceId?: string;
}

/**
 * Redis Pub/Sub adapter for cross-instance WebSocket broadcast.
 *
 * Architecture:
 * 1. Instance A calls broadcastWithAdapter('products', message)
 * 2. RoomManager broadcasts locally + calls adapter.publish()
 * 3. Adapter publishes to Redis channel: { room, message, instanceId }
 * 4. All instances (including A) receive the Redis message
 * 5. Each instance checks instanceId — skips if it's own message (prevents double delivery)
 * 6. Other instances call RoomManager.broadcast() to deliver to their local clients
 */
export class RedisWebSocketAdapter implements WebSocketAdapter {
  readonly name = "redis";

  private pub: RedisLike;
  private sub: RedisLike;
  private channel: string;
  private instanceId: string;

  constructor(redis: RedisLike, options: RedisWebSocketAdapterOptions = {}) {
    const { channel = "arc-ws", instanceId } = options;

    this.channel = channel;
    this.instanceId = instanceId ?? `arc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.pub = redis;
    this.sub = redis.duplicate();
  }

  async publish(room: string, message: string): Promise<void> {
    const envelope = JSON.stringify({
      room,
      message,
      instanceId: this.instanceId,
    });
    await this.pub.publish(this.channel, envelope);
  }

  async subscribe(callback: (room: string, message: string) => void): Promise<void> {
    this.sub.on("message", (...args: unknown[]) => {
      const [, raw] = args as [string, string];
      try {
        const envelope = JSON.parse(raw) as { room: string; message: string; instanceId: string };
        // Skip own messages (already broadcast locally)
        if (envelope.instanceId === this.instanceId) return;
        callback(envelope.room, envelope.message);
      } catch {
        // Ignore malformed messages
      }
    });

    await this.sub.subscribe(this.channel);
  }

  async close(): Promise<void> {
    await this.sub.quit();
    // Don't quit the pub client — it may be shared
  }
}

export default RedisWebSocketAdapter;
