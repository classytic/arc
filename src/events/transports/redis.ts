/**
 * Redis Event Transport
 *
 * Uses Redis Pub/Sub for cross-process event delivery.
 * Optional dependency — only imported when explicitly used.
 *
 * @example
 * import { RedisEventTransport } from '@classytic/arc/events/redis';
 * import Redis from 'ioredis';
 *
 * const redis = new Redis();
 * const transport = new RedisEventTransport(redis, { channel: 'arc-events' });
 *
 * await app.register(eventPlugin, { transport });
 */

import type { DomainEvent, EventHandler, EventLogger, EventTransport } from "../EventTransport.js";

// ---------------------------------------------------------------------------
// Minimal Redis-like interface so consumers don't need ioredis at type level.
// Any Redis client implementing these methods (ioredis, node-redis wrapper,
// etc.) will work.
// ---------------------------------------------------------------------------

export interface RedisLike {
  publish(channel: string, message: string): Promise<number>;
  subscribe(...channels: string[]): Promise<unknown>;
  psubscribe(...patterns: string[]): Promise<unknown>;
  on(event: string, handler: (...args: unknown[]) => void): unknown;
  duplicate(): RedisLike;
  quit(): Promise<unknown>;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface RedisEventTransportOptions {
  /**
   * Redis channel prefix for all events.
   * Events are published to `<channel>:<event.type>`.
   * @default 'arc-events'
   */
  channel?: string;

  /**
   * If `true`, the transport will NOT call `quit()` on the Redis clients when
   * `close()` is called. Useful when you manage the Redis lifecycle externally.
   * @default false
   */
  externalLifecycle?: boolean;

  /**
   * Logger for error messages (default: console).
   * Pass `fastify.log` to integrate with your application logger.
   */
  logger?: EventLogger;
}

// ---------------------------------------------------------------------------
// Serialization helpers
// ---------------------------------------------------------------------------

/**
 * DomainEvent contains a `Date` in `meta.timestamp`.  We serialize it as an
 * ISO string and revive it on the other end so subscribers always receive a
 * proper Date object.
 */
function serialize(event: DomainEvent): string {
  return JSON.stringify(event, (_key, value) => {
    if (value instanceof Date) return value.toISOString();
    return value;
  });
}

function deserialize(raw: string): DomainEvent {
  return JSON.parse(raw, (key, value) => {
    if (key === "timestamp" && typeof value === "string") return new Date(value);
    return value;
  }) as DomainEvent;
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

export class RedisEventTransport implements EventTransport {
  readonly name = "redis";

  /** Publish-side client (the original client or a duplicate). */
  private pub: RedisLike;

  /** Subscribe-side client (always a duplicate — ioredis requires a dedicated connection for subscriptions). */
  private sub: RedisLike;

  /** Channel prefix. */
  private channel: string;

  /** Whether we own the Redis client lifecycle. */
  private externalLifecycle: boolean;

  /** Logger for error messages. */
  private logger: EventLogger;

  /** Registered handlers keyed by their *Redis* pattern (with channel prefix). */
  private handlers = new Map<string, Set<EventHandler>>();

  /** Tracks whether the pmessage listener has been attached. */
  private listenerAttached = false;

  constructor(redis: RedisLike, options: RedisEventTransportOptions = {}) {
    const { channel = "arc-events", externalLifecycle = false, logger = console } = options;

    this.channel = channel;
    this.externalLifecycle = externalLifecycle;
    this.logger = logger;

    // Use the provided client for publishing, create a dedicated duplicate for subscribing.
    // ioredis requires separate connections for pub and sub because a client in
    // subscriber mode cannot issue regular commands.
    this.pub = redis;
    this.sub = redis.duplicate();
  }

  // -----------------------------------------------------------------------
  // EventTransport.publish
  // -----------------------------------------------------------------------

  async publish(event: DomainEvent): Promise<void> {
    const redisChannel = `${this.channel}:${event.type}`;
    await this.pub.publish(redisChannel, serialize(event));
  }

  // -----------------------------------------------------------------------
  // EventTransport.subscribe
  // -----------------------------------------------------------------------

  async subscribe(pattern: string, handler: EventHandler): Promise<() => void> {
    this.ensureListener();

    const redisPattern = this.toRedisPattern(pattern);

    if (!this.handlers.has(redisPattern)) {
      this.handlers.set(redisPattern, new Set());

      // Decide between exact SUBSCRIBE or pattern PSUBSCRIBE.
      if (this.isGlob(redisPattern)) {
        await this.sub.psubscribe(redisPattern);
      } else {
        await this.sub.subscribe(redisPattern);
      }
    }

    this.handlers.get(redisPattern)?.add(handler);

    // Return unsubscribe function.
    return () => {
      const set = this.handlers.get(redisPattern);
      if (set) {
        set.delete(handler);
        // Note: we intentionally do NOT punsubscribe/unsubscribe from Redis
        // when the last handler for a pattern is removed. This keeps the
        // implementation simple and avoids race conditions. The pattern stays
        // active until close() is called.
      }
    };
  }

  // -----------------------------------------------------------------------
  // EventTransport.close
  // -----------------------------------------------------------------------

  async close(): Promise<void> {
    this.handlers.clear();

    if (!this.externalLifecycle) {
      // The subscriber connection is always a duplicate we created, so we
      // always quit it. The publisher is the client the user passed in, so
      // we only quit it when externalLifecycle is false.
      await Promise.all([this.sub.quit(), this.pub.quit()]);
    } else {
      // Even with external lifecycle we quit the subscriber duplicate since we
      // created it ourselves.
      await this.sub.quit();
    }
  }

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  /**
   * Attach the Redis message listeners exactly once.
   */
  private ensureListener(): void {
    if (this.listenerAttached) return;
    this.listenerAttached = true;

    // Pattern-matched messages (from psubscribe)
    this.sub.on("pmessage", (...args: unknown[]) => {
      const [redisPattern, , message] = args as [string, string, string];
      this.dispatch(redisPattern, message);
    });

    // Exact-matched messages (from subscribe)
    this.sub.on("message", (...args: unknown[]) => {
      const [channel, message] = args as [string, string];
      this.dispatch(channel, message);
    });
  }

  /**
   * Dispatch an incoming Redis message to all registered handlers.
   */
  private dispatch(redisPatternOrChannel: string, raw: string): void {
    const handlers = this.handlers.get(redisPatternOrChannel);
    if (!handlers || handlers.size === 0) return;

    let event: DomainEvent;
    try {
      event = deserialize(raw);
    } catch {
      // Ignore malformed messages — they may come from non-Arc publishers
      // sharing the same Redis instance.
      return;
    }

    for (const handler of handlers) {
      try {
        const result = handler(event);
        // If handler returns a promise, attach a catch so one failing
        // handler doesn't prevent the rest from executing or crash the process.
        if (result && typeof result === "object" && "catch" in result) {
          (result as Promise<void>).catch((err: unknown) => {
            this.logger.error(`[RedisEventTransport] Handler error for ${event.type}:`, err);
          });
        }
      } catch (err) {
        this.logger.error(`[RedisEventTransport] Handler error for ${event.type}:`, err);
      }
    }
  }

  /**
   * Convert an Arc event pattern to a Redis channel/pattern string.
   *
   * Arc patterns use `*` as a single-segment wildcard (e.g., `product.*`).
   * Redis PSUBSCRIBE uses the same glob syntax, so we just prepend the
   * channel prefix.
   *
   * Special case: bare `*` means "all events", which maps to
   * `<channel>:*` in Redis.
   */
  private toRedisPattern(pattern: string): string {
    return `${this.channel}:${pattern}`;
  }

  /**
   * Returns true if the pattern contains glob characters.
   */
  private isGlob(pattern: string): boolean {
    return pattern.includes("*") || pattern.includes("?") || pattern.includes("[");
  }
}

