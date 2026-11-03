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

import sjson from "secure-json-parse";
import { runWorkScope, workSeedFromEvent } from "../../context/workScope.js";
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

  /**
   * Longest `subscribe()` waits for Redis to confirm a subscription (ms). Past it the
   * handler is registered anyway and the SUBSCRIBE stays queued on the client (ioredis
   * sends it once connected and re-subscribes after every reconnect), so an app BOOTS
   * while Redis is down instead of hanging until it returns. One warning per outage;
   * while the subscriber is not connected, later subscriptions do not wait at all.
   * @default 2000
   */
  subscribeTimeoutMs?: number;

  /**
   * Longest `publish()` waits for Redis (ms) before it rejects, so a caller with a retry
   * (the outbox relay) retries later instead of hanging on a client that queues while
   * disconnected. A publish that timed out may still be sent when the client reconnects:
   * handlers must be idempotent by event id (they already must be for at-least-once).
   * @default 5000
   */
  publishTimeoutMs?: number;
}

/** Settle `promise` within `ms`: `'timeout'` when it did not. The promise keeps running. */
function within<T>(promise: Promise<T>, ms: number): Promise<{ value: T } | "timeout"> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve("timeout"), ms);
    (timer as { unref?: () => void }).unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve({ value });
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * `error.code` of a publish refused because Redis did not answer (never a bad event): an outbox
 * `failurePolicy` can keep retrying it instead of counting it toward dead-lettering.
 */
export const TRANSPORT_UNAVAILABLE = "arc.transport_unavailable";

function unavailable(message: string): Error {
  return Object.assign(new Error(message), { code: TRANSPORT_UNAVAILABLE });
}

function positiveMs(name: string, value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value <= 0)
    throw new Error(`[RedisEventTransport] ${name} must be a positive number of milliseconds.`);
  return value;
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
  // Cross-service trust boundary: any service with Redis publish access can put
  // bytes on this channel. `sjson.parse` rejects `__proto__` / `constructor.prototype`
  // so a poisoned event payload can't pollute the consumer's Object prototype.
  return sjson.parse(raw, (key, value) => {
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

  private subscribeTimeoutMs: number;
  private publishTimeoutMs: number;

  /** A subscription timed out and the subscriber has not been ready since: do not wait again. */
  private subscriberDown = false;

  /** A publish timed out and the publisher has not been ready since: refuse at once. */
  private publisherDown = false;

  constructor(redis: RedisLike, options: RedisEventTransportOptions = {}) {
    const { channel = "arc-events", externalLifecycle = false, logger = console } = options;

    this.channel = channel;
    this.externalLifecycle = externalLifecycle;
    this.logger = logger;
    this.subscribeTimeoutMs = positiveMs("subscribeTimeoutMs", options.subscribeTimeoutMs, 2000);
    this.publishTimeoutMs = positiveMs("publishTimeoutMs", options.publishTimeoutMs, 5000);

    // Use the provided client for publishing, create a dedicated duplicate for subscribing.
    // ioredis requires separate connections for pub and sub because a client in
    // subscriber mode cannot issue regular commands.
    this.pub = redis;
    this.sub = redis.duplicate();
    // Optional on the publisher: a hand-rolled client may implement only the commands.
    if (typeof this.pub.on === "function")
      this.pub.on("ready", () => {
        this.publisherDown = false;
      });
    // The duplicate is ours: without a listener ioredis prints every failed reconnect as an
    // unhandled error. One warning per outage instead (reset when it is ready again).
    let reported = false;
    this.sub.on("error", (err: unknown) => {
      if (reported) return;
      reported = true;
      this.logger.warn(
        `[RedisEventTransport] subscriber connection error: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
    this.sub.on("ready", () => {
      reported = false;
    });
  }

  // -----------------------------------------------------------------------
  // EventTransport.publish
  // -----------------------------------------------------------------------

  async publish(event: DomainEvent): Promise<void> {
    const redisChannel = `${this.channel}:${event.type}`;
    if (this.publisherDown)
      // A publish already timed out and the client has not been ready since: fail at once (the
      // caller retries) rather than wait `publishTimeoutMs` on every event of the outage.
      throw unavailable(
        `[RedisEventTransport] publish of ${event.type} refused: Redis unavailable`,
      );
    const sent = await within(
      this.pub.publish(redisChannel, serialize(event)),
      this.publishTimeoutMs,
    );
    if (sent === "timeout") {
      this.publisherDown = true;
      throw unavailable(
        `[RedisEventTransport] publish of ${event.type} not confirmed within ${this.publishTimeoutMs} ms (Redis unavailable?)`,
      );
    }
  }

  // -----------------------------------------------------------------------
  // EventTransport.subscribe
  // -----------------------------------------------------------------------

  async subscribe(pattern: string, handler: EventHandler): Promise<() => void> {
    this.ensureListener();

    const redisPattern = this.toRedisPattern(pattern);

    const known = this.handlers.get(redisPattern);
    // Registered before Redis confirms: a message that arrives as the confirmation does is not missed.
    this.handlers.set(redisPattern, (known ?? new Set<EventHandler>()).add(handler));

    if (!known) {
      // Decide between exact SUBSCRIBE or pattern PSUBSCRIBE.
      const confirmed = this.isGlob(redisPattern)
        ? this.sub.psubscribe(redisPattern)
        : this.sub.subscribe(redisPattern);
      if (this.subscriberDown) {
        // Already known down: queued on the client, never waited on (boot must not stall per pattern).
        confirmed.catch((err: unknown) => this.subscribeFailed(redisPattern, err));
      } else {
        const outcome = await within(confirmed, this.subscribeTimeoutMs).catch((err: unknown) => {
          // A refused command (not a slow one) is still the caller's error, as before.
          this.handlers.delete(redisPattern);
          throw err;
        });
        if (outcome === "timeout") {
          this.subscriberDown = true;
          confirmed.catch((err: unknown) => this.subscribeFailed(redisPattern, err));
          this.logger.warn(
            `[RedisEventTransport] Redis did not confirm a subscription within ${this.subscribeTimeoutMs} ms: ` +
              "continuing; subscriptions are sent when it connects (no cross-instance events until then)",
          );
        }
      }
    }

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
      await Promise.all([this.quitOrDrop(this.sub), this.quitOrDrop(this.pub)]);
    } else {
      // Even with external lifecycle we quit the subscriber duplicate since we
      // created it ourselves.
      await this.quitOrDrop(this.sub);
    }
  }

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  /**
   * QUIT waits for Redis like any command (queued while disconnected): bounded, then the socket is
   * dropped (`disconnect()` when the client has one), so an app can shut down during an outage.
   */
  private async quitOrDrop(client: RedisLike): Promise<void> {
    const quit = client.quit();
    quit.catch(() => {});
    const outcome = await within(quit, this.publishTimeoutMs).catch(() => "failed" as const);
    if (outcome === "timeout" || outcome === "failed")
      (client as RedisLike & { disconnect?: () => void }).disconnect?.();
  }

  /** A queued subscription that Redis refused once it answered (logged; the handler stays registered). */
  private subscribeFailed(redisPattern: string, err: unknown): void {
    this.logger.error(`[RedisEventTransport] Subscription to ${redisPattern} failed:`, err);
  }

  /**
   * Attach the Redis message listeners exactly once.
   */
  private ensureListener(): void {
    if (this.listenerAttached) return;
    this.listenerAttached = true;

    // Subscriber connected (again): later subscriptions may wait for their confirmation.
    this.sub.on("ready", () => {
      this.subscriberDown = false;
    });

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

    // One work scope per delivered message — see `runWorkScope`.
    runWorkScope(workSeedFromEvent(event), () => {
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
    });
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
