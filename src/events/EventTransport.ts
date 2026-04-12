/**
 * Event Transport Interface
 *
 * Defines contract for event delivery backends.
 * Implement for durable transports (Redis, RabbitMQ, Kafka, etc.)
 *
 * @example
 * // Redis Pub/Sub implementation
 * class RedisEventTransport implements EventTransport {
 *   async publish(event) {
 *     await redis.publish(event.type, JSON.stringify(event));
 *   }
 *   async subscribe(pattern, handler) {
 *     redis.psubscribe(pattern);
 *     redis.on('pmessage', (p, channel, msg) => handler(JSON.parse(msg)));
 *   }
 * }
 */

export interface DomainEvent<T = unknown> {
  /** Event type (e.g., 'product.created', 'order.shipped') */
  type: string;
  /** Event payload */
  payload: T;
  /** Event metadata */
  meta: {
    /** Unique event ID */
    id: string;
    /** Event timestamp */
    timestamp: Date;
    /** Source resource */
    resource?: string;
    /** Resource ID */
    resourceId?: string;
    /** User who triggered the event */
    userId?: string;
    /** Organization context */
    organizationId?: string;
    /** Correlation ID for tracing */
    correlationId?: string;
  };
}

export type EventHandler<T = unknown> = (event: DomainEvent<T>) => void | Promise<void>;

/**
 * Minimal logger interface for event transports.
 * Compatible with `console`, `pino`, `fastify.log`, and any custom logger.
 *
 * @example
 * ```typescript
 * // Use Fastify's logger
 * new MemoryEventTransport({ logger: fastify.log });
 *
 * // Use a custom logger
 * new MemoryEventTransport({ logger: { warn: myWarn, error: myError } });
 *
 * // Default: console (no logger option needed)
 * new MemoryEventTransport();
 * ```
 */
export interface EventLogger {
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

export interface EventTransport {
  /** Transport name for logging */
  readonly name: string;

  /**
   * Publish an event to the transport
   */
  publish(event: DomainEvent): Promise<void>;

  /**
   * Publish a batch of events to the transport (optional, v2.8.1+).
   *
   * Transports that can efficiently batch (Kafka producer, Redis pipeline,
   * RabbitMQ publisher confirms, SQS send-message-batch) should implement
   * this. {@link import('./outbox.js').EventOutbox.relay} auto-detects and
   * uses it for much higher throughput than per-event publishing.
   *
   * **Contract**: the returned `PublishManyResult` must describe the
   * per-event outcome so the caller can acknowledge successes and fail the
   * rest. Partial success is allowed — the transport reports it per event.
   *
   * If not implemented, `EventOutbox.relay` falls back to calling
   * {@link publish} once per event.
   *
   * @param events - Events to publish (in order)
   * @returns Per-event outcome map keyed by `event.meta.id`
   */
  publishMany?(events: readonly DomainEvent[]): Promise<PublishManyResult>;

  /**
   * Subscribe to events matching a pattern
   * @param pattern - Event type pattern (e.g., 'product.*', '*')
   * @param handler - Handler function
   * @returns Unsubscribe function
   */
  subscribe(pattern: string, handler: EventHandler): Promise<() => void>;

  /**
   * Close transport connections
   */
  close?(): Promise<void>;
}

/**
 * Per-event outcome returned by {@link EventTransport.publishMany}.
 *
 * The key is `event.meta.id`; the value is `null` for success or an `Error`
 * for per-event failure. Transports MUST include an entry for every event
 * in the input batch.
 */
export type PublishManyResult = ReadonlyMap<string, Error | null>;

export interface MemoryEventTransportOptions {
  /** Logger for error/warning messages (default: console) */
  logger?: EventLogger;
}

/**
 * In-memory event transport (default)
 * Events are delivered synchronously within the process.
 * Not suitable for multi-instance deployments.
 */
export class MemoryEventTransport implements EventTransport {
  readonly name = "memory";
  private handlers = new Map<string, Set<EventHandler>>();
  private logger: EventLogger;

  constructor(options?: MemoryEventTransportOptions) {
    this.logger = options?.logger ?? console;
  }

  async publish(event: DomainEvent): Promise<void> {
    // Exact match handlers
    const exactHandlers = this.handlers.get(event.type) ?? new Set();

    // Wildcard handlers
    const wildcardHandlers = this.handlers.get("*") ?? new Set();

    // Pattern match handlers (e.g., 'product.*' matches 'product.created')
    const patternHandlers = new Set<EventHandler>();
    for (const [pattern, handlers] of this.handlers.entries()) {
      if (pattern.endsWith(".*")) {
        const prefix = pattern.slice(0, -2);
        if (event.type.startsWith(`${prefix}.`)) {
          for (const h of handlers) patternHandlers.add(h);
        }
      }
    }

    const allHandlers = new Set([...exactHandlers, ...wildcardHandlers, ...patternHandlers]);

    // Execute handlers (catch errors to prevent one handler from blocking others)
    for (const handler of allHandlers) {
      try {
        await handler(event);
      } catch (err) {
        this.logger.error(`[EventTransport] Handler error for ${event.type}:`, err);
      }
    }
  }

  /**
   * Reference `publishMany` implementation — delegates to `publish()` in order.
   *
   * Production transports (Kafka, Redis pipeline, SQS batch) should override
   * this with a single batched network call. Memory transport has nothing to
   * batch, so we just loop — the loop still returns a proper result map so
   * `EventOutbox.relay` can exercise the batched code path in tests.
   */
  async publishMany(events: readonly DomainEvent[]): Promise<PublishManyResult> {
    const results = new Map<string, Error | null>();
    for (const event of events) {
      try {
        await this.publish(event);
        results.set(event.meta.id, null);
      } catch (err) {
        results.set(event.meta.id, err instanceof Error ? err : new Error(String(err)));
      }
    }
    return results;
  }

  async subscribe(pattern: string, handler: EventHandler): Promise<() => void> {
    if (!this.handlers.has(pattern)) {
      this.handlers.set(pattern, new Set());
    }
    this.handlers.get(pattern)?.add(handler);

    return () => {
      const set = this.handlers.get(pattern);
      if (set) {
        set.delete(handler);
        // Clean up empty sets to prevent memory leaks from dynamic subscriptions
        if (set.size === 0) {
          this.handlers.delete(pattern);
        }
      }
    };
  }

  async close(): Promise<void> {
    this.handlers.clear();
  }
}

/**
 * Create a domain event with auto-generated metadata
 */
export function createEvent<T>(
  type: string,
  payload: T,
  meta?: Partial<DomainEvent["meta"]>,
): DomainEvent<T> {
  return {
    type,
    payload,
    meta: {
      id: crypto.randomUUID(),
      timestamp: new Date(),
      ...meta,
    },
  };
}
