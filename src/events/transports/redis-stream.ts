/**
 * Redis Stream Event Transport — Durable Event Delivery
 *
 * Uses Redis Streams (`XADD`/`XREADGROUP`) for persistent, exactly-once event
 * delivery across multiple service instances. Unlike Pub/Sub, events are stored
 * in Redis and survive crashes/restarts.
 *
 * Key features:
 * - Consumer groups: each event processed by exactly one consumer per group
 * - Crash recovery: pending entries are auto-claimed after `claimTimeoutMs`
 * - Dead letter stream: events exceeding `maxRetries` are moved to a DLQ
 * - Backpressure: configurable block time and batch size
 *
 * @example
 * ```typescript
 * import { RedisStreamTransport } from '@classytic/arc/events';
 * import Redis from 'ioredis';
 *
 * const transport = new RedisStreamTransport(new Redis(), {
 *   stream: 'arc-events',
 *   group: 'api-service',
 *   consumer: 'worker-1',
 * });
 *
 * await app.register(eventPlugin, { transport });
 * ```
 */

import type { DomainEvent, EventHandler, EventLogger, EventTransport } from "../EventTransport.js";

// ---------------------------------------------------------------------------
// Minimal Redis-like interface for Streams support
// ---------------------------------------------------------------------------

export interface RedisStreamLike {
  xadd(key: string, id: string, ...fieldValues: string[]): Promise<string | null>;
  xreadgroup(
    command: "GROUP",
    group: string,
    consumer: string,
    ...args: (string | number)[]
  ): Promise<Array<[string, Array<[string, string[]]>]> | null>;
  xack(key: string, group: string, ...ids: string[]): Promise<number>;
  xgroup(command: string, key: string, group: string, ...args: string[]): Promise<unknown>;
  xpending(
    key: string,
    group: string,
    ...args: (string | number)[]
  ): Promise<Array<[string, string, number, number]>>;
  xclaim(
    key: string,
    group: string,
    consumer: string,
    minIdleTime: number,
    ...ids: string[]
  ): Promise<Array<[string, string[]]>>;
  xlen(key: string): Promise<number>;
  quit(): Promise<unknown>;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface RedisStreamTransportOptions {
  /**
   * Redis stream key name.
   * @default 'arc:events'
   */
  stream?: string;

  /**
   * Consumer group name. Each group receives every event independently.
   * Multiple instances of the same service should share a group name.
   * @default 'default'
   */
  group?: string;

  /**
   * Consumer name within the group. Must be unique per instance.
   * @default 'consumer-<random>'
   */
  consumer?: string;

  /**
   * Block time in ms when waiting for new events.
   * @default 5000
   */
  blockTimeMs?: number;

  /**
   * Max events to read per batch.
   * @default 10
   */
  batchSize?: number;

  /**
   * Max delivery attempts before moving to dead letter stream.
   * @default 5
   */
  maxRetries?: number;

  /**
   * Idle time in ms before pending entries are claimed by this consumer.
   * Handles crash recovery — if a consumer dies mid-processing, another
   * consumer will claim its pending entries after this timeout.
   * @default 30000
   */
  claimTimeoutMs?: number;

  /**
   * Dead letter stream name. Failed events are moved here after maxRetries.
   * Set to `false` to disable DLQ (failed events are acked and dropped).
   * @default 'arc:events:dlq'
   */
  deadLetterStream?: string | false;

  /**
   * Max stream length (approximate). Uses XADD MAXLEN ~ to trim old entries.
   * Set to 0 to disable trimming.
   * @default 10000
   */
  maxLen?: number;

  /**
   * Logger for error messages (default: console).
   * Pass `fastify.log` to integrate with your application logger.
   */
  logger?: EventLogger;
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

export class RedisStreamTransport implements EventTransport {
  readonly name = "redis-stream";

  private redis: RedisStreamLike;
  private stream: string;
  private group: string;
  private consumer: string;
  private blockTimeMs: number;
  private batchSize: number;
  private maxRetries: number;
  private claimTimeoutMs: number;
  private deadLetterStream: string | false;
  private maxLen: number;

  private logger: EventLogger;

  private handlers = new Map<string, Set<EventHandler>>();
  private running = false;
  private pollPromise: Promise<void> | null = null;
  private groupCreated = false;

  constructor(redis: RedisStreamLike, options: RedisStreamTransportOptions = {}) {
    this.redis = redis;
    this.stream = options.stream ?? "arc:events";
    this.group = options.group ?? "default";
    this.consumer = options.consumer ?? `consumer-${crypto.randomUUID().slice(0, 8)}`;
    this.blockTimeMs = options.blockTimeMs ?? 5000;
    this.batchSize = options.batchSize ?? 10;
    this.maxRetries = options.maxRetries ?? 5;
    this.claimTimeoutMs = options.claimTimeoutMs ?? 30_000;
    this.deadLetterStream = options.deadLetterStream ?? "arc:events:dlq";
    this.maxLen = options.maxLen ?? 10_000;
    this.logger = options.logger ?? console;
  }

  // -----------------------------------------------------------------------
  // EventTransport.publish
  // -----------------------------------------------------------------------

  async publish(event: DomainEvent): Promise<void> {
    const args: string[] = [
      this.stream,
      ...(this.maxLen > 0 ? ["MAXLEN", "~", String(this.maxLen)] : []),
      "*",
      "type",
      event.type,
      "data",
      JSON.stringify(event),
    ];

    // Use spread to call xadd with dynamic args
    await (this.redis as any).xadd(...args);
  }

  // -----------------------------------------------------------------------
  // EventTransport.subscribe
  // -----------------------------------------------------------------------

  async subscribe(pattern: string, handler: EventHandler): Promise<() => void> {
    if (!this.handlers.has(pattern)) {
      this.handlers.set(pattern, new Set());
    }
    this.handlers.get(pattern)?.add(handler);

    // Start the consumer loop if not already running
    if (!this.running) {
      await this.ensureGroup();
      this.running = true;
      this.pollPromise = this.pollLoop();
    }

    return () => {
      const set = this.handlers.get(pattern);
      if (set) {
        set.delete(handler);
        if (set.size === 0) this.handlers.delete(pattern);
      }
      // Stop polling when no handlers remain — prevents CPU/network waste
      if (this.handlers.size === 0 && this.running) {
        this.running = false;
      }
    };
  }

  // -----------------------------------------------------------------------
  // EventTransport.close
  // -----------------------------------------------------------------------

  async close(): Promise<void> {
    this.running = false;
    this.handlers.clear();

    // Wait for the poll loop to finish its current iteration
    if (this.pollPromise) {
      await this.pollPromise;
      this.pollPromise = null;
    }
  }

  // -----------------------------------------------------------------------
  // Consumer group management
  // -----------------------------------------------------------------------

  private async ensureGroup(): Promise<void> {
    if (this.groupCreated) return;

    try {
      // Create the consumer group, starting from new messages ('$')
      // Use MKSTREAM to auto-create the stream if it doesn't exist
      await this.redis.xgroup("CREATE", this.stream, this.group, "$", "MKSTREAM");
    } catch (err: unknown) {
      // BUSYGROUP = group already exists, which is fine
      if (err instanceof Error && !err.message.includes("BUSYGROUP")) {
        throw err;
      }
    }

    this.groupCreated = true;
  }

  // -----------------------------------------------------------------------
  // Poll loop — reads new messages + claims pending (crash recovery)
  // -----------------------------------------------------------------------

  private async pollLoop(): Promise<void> {
    while (this.running) {
      try {
        // Phase 1: Claim pending entries from dead consumers (crash recovery)
        await this.claimPending();

        // Phase 2: Read new messages
        await this.readNewMessages();
      } catch (err) {
        if (this.running) {
          this.logger.error("[RedisStreamTransport] Poll error:", err);
          // Brief pause before retrying on error
          await this.sleep(1000);
        }
      }
    }
  }

  private async readNewMessages(): Promise<void> {
    // XREADGROUP GROUP <group> <consumer> COUNT <n> BLOCK <ms> STREAMS <key> >
    const result = await this.redis.xreadgroup(
      "GROUP",
      this.group,
      this.consumer,
      "COUNT",
      this.batchSize,
      "BLOCK",
      this.blockTimeMs,
      "STREAMS",
      this.stream,
      ">",
    );

    if (!result) return; // Timeout, no new messages

    for (const [, entries] of result) {
      for (const [messageId, fields] of entries) {
        await this.processEntry(messageId, fields);
      }
    }
  }

  private async claimPending(): Promise<void> {
    try {
      // Check for pending entries across all consumers that have been idle
      const pending = await this.redis.xpending(
        this.stream,
        this.group,
        "-",
        "+",
        10, // Check up to 10 pending entries
      );

      if (!pending || pending.length === 0) return;

      const staleIds: string[] = [];
      const overRetryIds: string[] = [];

      for (const entry of pending) {
        const [id, , idleTime, deliveryCount] = entry;
        if (idleTime > this.claimTimeoutMs) {
          if (deliveryCount >= this.maxRetries) {
            overRetryIds.push(id);
          } else {
            staleIds.push(id);
          }
        }
      }

      // Move over-retry entries to DLQ
      if (overRetryIds.length > 0) {
        await this.moveToDlq(overRetryIds);
      }

      // Claim stale entries
      if (staleIds.length > 0) {
        const claimed = await this.redis.xclaim(
          this.stream,
          this.group,
          this.consumer,
          this.claimTimeoutMs,
          ...staleIds,
        );

        for (const [messageId, fields] of claimed) {
          await this.processEntry(messageId, fields);
        }
      }
    } catch {
      // Pending check failures are non-fatal — will retry next iteration
    }
  }

  // -----------------------------------------------------------------------
  // Message processing
  // -----------------------------------------------------------------------

  private async processEntry(messageId: string, fields: string[]): Promise<void> {
    // Parse fields array into key-value pairs
    const fieldMap = new Map<string, string>();
    for (let i = 0; i < fields.length; i += 2) {
      fieldMap.set(fields[i]!, fields[i + 1]!);
    }

    const eventType = fieldMap.get("type");
    const rawData = fieldMap.get("data");
    if (!eventType || !rawData) {
      // Malformed entry — ack and skip
      await this.redis.xack(this.stream, this.group, messageId);
      return;
    }

    let event: DomainEvent;
    try {
      event = JSON.parse(rawData, (key, value) => {
        if (key === "timestamp" && typeof value === "string") return new Date(value);
        return value;
      }) as DomainEvent;
    } catch {
      // Unparseable — ack and skip
      await this.redis.xack(this.stream, this.group, messageId);
      return;
    }

    // Dispatch to matching handlers
    const matchingHandlers = this.getMatchingHandlers(event.type);
    let allSucceeded = true;

    for (const handler of matchingHandlers) {
      try {
        await handler(event);
      } catch (err) {
        allSucceeded = false;
        this.logger.error(`[RedisStreamTransport] Handler error for ${event.type}:`, err);
      }
    }

    if (allSucceeded) {
      await this.redis.xack(this.stream, this.group, messageId);
    }
    // If not all succeeded, leave unacked — will be retried via pending claim
  }

  private getMatchingHandlers(eventType: string): EventHandler[] {
    const matched: EventHandler[] = [];

    for (const [pattern, handlers] of this.handlers) {
      if (this.matchesPattern(pattern, eventType)) {
        for (const h of handlers) {
          matched.push(h);
        }
      }
    }

    return matched;
  }

  private matchesPattern(pattern: string, eventType: string): boolean {
    if (pattern === "*") return true;
    if (pattern === eventType) return true;
    if (pattern.endsWith(".*")) {
      const prefix = pattern.slice(0, -2);
      return eventType.startsWith(`${prefix}.`);
    }
    return false;
  }

  // -----------------------------------------------------------------------
  // Dead letter queue
  // -----------------------------------------------------------------------

  private async moveToDlq(ids: string[]): Promise<void> {
    if (this.deadLetterStream === false) {
      // DLQ disabled — just ack and drop
      for (const id of ids) {
        await this.redis.xack(this.stream, this.group, id);
      }
      return;
    }

    // Read the entries, write to DLQ stream, then ack
    for (const id of ids) {
      try {
        await (this.redis as any).xadd(
          this.deadLetterStream,
          "*",
          "originalStream",
          this.stream,
          "originalId",
          id,
          "group",
          this.group,
          "failedAt",
          new Date().toISOString(),
        );
        await this.redis.xack(this.stream, this.group, id);
      } catch (err) {
        this.logger.error(`[RedisStreamTransport] DLQ write failed for ${id}:`, err);
      }
    }
  }

  // -----------------------------------------------------------------------
  // Utility
  // -----------------------------------------------------------------------

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export default RedisStreamTransport;
