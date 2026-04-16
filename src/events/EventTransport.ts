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

/**
 * Event metadata.
 *
 * Split out as a standalone interface so primitives / downstream packages can
 * mirror it without re-declaring the DomainEvent wrapper. See events.ts in
 * @classytic/primitives for the sibling shape.
 */
export interface EventMeta {
  /** Unique event ID (UUID v4 recommended) */
  id: string;

  /** Event timestamp */
  timestamp: Date;

  /**
   * Schema version for this event type. Default: `1`.
   *
   * Use when the payload shape evolves so handlers can branch on version
   * during migration windows (`if (event.meta.schemaVersion === 2) ...`).
   * Bump ONLY when the payload contract changes in a breaking way.
   */
  schemaVersion?: number;

  /**
   * Correlation ID — stays stable across an entire causal chain so a single
   * user action can be traced through every downstream event. Spans service
   * boundaries. Generated at the edge (HTTP request, CLI invocation) and
   * inherited by every child event.
   */
  correlationId?: string;

  /**
   * Causation ID — the `meta.id` of the direct parent event that caused
   * this one. Forms a linked-list of cause-and-effect within a correlation.
   *
   * Distinct from correlationId: correlation groups, causation chains.
   * Use {@link createChildEvent} to populate this automatically.
   */
  causationId?: string;

  /**
   * Partition key hint for ordered transports (Kafka, Kinesis, Redis Streams
   * consumer groups). Events with the same partitionKey are guaranteed to be
   * delivered in publish order by transports that honour it.
   *
   * Defaults to `resourceId` if unset. Transports that don't support ordering
   * (in-memory, simple pub/sub) ignore this field.
   */
  partitionKey?: string;

  /** Source resource (e.g. 'order', 'transaction') */
  resource?: string;

  /** Resource identifier */
  resourceId?: string;

  /** User who triggered the event */
  userId?: string;

  /** Organization context */
  organizationId?: string;

  /**
   * Originating service or package (e.g. `'commerce'`, `'billing'`, `'arc-core'`).
   *
   * In a multi-service deployment, consumers route / log / alert by `source`
   * without parsing `type` prefixes. Arc itself never populates this — hosts
   * set it once per emitter (`app.events.publish('order.placed', p, { source: 'commerce' })`).
   * Inherited by {@link createChildEvent} so downstream events carry the same
   * source unless overridden.
   */
  source?: string;

  /**
   * Idempotency key — stable hint that this event represents a specific
   * operation exactly once. Consumers dedupe with `if (processed.has(meta.idempotencyKey)) return`.
   *
   * Survives every transport (Memory / Pub-Sub / Streams / Kafka) because it's
   * part of the event, not a transport-side option. Distinct from `meta.id`
   * (which is fresh per emit — a retry would produce a new id).
   *
   * Typical sources: HTTP `Idempotency-Key` header, outbox `dedupeKey`, or
   * `{aggregate.type}:{aggregate.id}:{action}`. Inherited by child events.
   */
  idempotencyKey?: string;

  /**
   * DDD aggregate marker — the aggregate that owns this event's invariant.
   *
   * Use when routing events by aggregate, doing event-sourcing replay, or
   * enforcing consistency boundaries. Distinct from `resource` / `resourceId`
   * (HTTP-origin entity) because an event emitted *by* one REST resource can
   * *belong to* a different aggregate (e.g. `POST /orders/:id/ship` emits
   * `shipment.dispatched` owned by a shipment aggregate).
   *
   * Downstream packages narrow `aggregate.type` to their own string union via
   * interface extension:
   *
   * ```ts
   * type CartAggregateType = 'cart' | 'cart-item';
   * interface CartEventMeta extends EventMeta {
   *   aggregate?: { type: CartAggregateType; id: string };
   * }
   * ```
   *
   * Not inherited by {@link createChildEvent} — child events typically belong
   * to a different aggregate than their parent.
   */
  aggregate?: { type: string; id: string };
}

export interface DomainEvent<T = unknown> {
  /** Event type (e.g., 'product.created', 'order.shipped') */
  type: string;
  /** Event payload */
  payload: T;
  /** Event metadata */
  meta: EventMeta;
}

export type EventHandler<T = unknown> = (event: DomainEvent<T>) => void | Promise<void>;

/**
 * A permanently-failed event routed to a dead-letter sink after retries
 * have been exhausted. Mirrors the shape a caller would log, alert on, or
 * replay from once the upstream issue is fixed.
 */
export interface DeadLetteredEvent<T = unknown> {
  /** The original event */
  event: DomainEvent<T>;
  /** Serialised failure reason (message + optional machine code + stack) */
  error: {
    message: string;
    code?: string;
    stack?: string;
  };
  /** How many delivery attempts were made before giving up */
  attempts: number;
  /** First failure timestamp */
  firstFailedAt: Date;
  /** Last failure timestamp (immediately before dead-lettering) */
  lastFailedAt: Date;
  /** Optional handler / subscriber name that last failed (for debug) */
  handlerName?: string;
}

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
   * Route a permanently-failed event to the transport's dead-letter sink
   * (Kafka DLQ topic, SQS DLQ, Redis Stream `PEL` timeout handler, etc.).
   *
   * Called by {@link import('./outbox.js').EventOutbox} after exhausting
   * retries. Transports that don't have a native DLQ can omit this —
   * callers treat an absent `deadLetter` as "log and drop".
   */
  deadLetter?(dlq: DeadLetteredEvent): Promise<void>;

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
 * Create a domain event with auto-generated metadata.
 *
 * `id` and `timestamp` are filled in; everything else is caller-controlled.
 * Set `schemaVersion` explicitly for any event type you plan to evolve.
 */
export function createEvent<T>(
  type: string,
  payload: T,
  meta?: Partial<EventMeta>,
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

/**
 * Create a child event that chains causation from a parent event.
 *
 * Rules:
 *  - `causationId` is set to the parent's `id` (direct cause)
 *  - `correlationId` is inherited from the parent if set, else falls back
 *    to the parent's `id` (root correlation)
 *  - `userId` / `organizationId` are inherited when not overridden so the
 *    whole chain stays scoped to the originating principal/tenant
 *
 * Caller-supplied `meta` wins over inherited fields — pass `{ userId: newActor }`
 * to override when a subsystem acts on behalf of a different principal.
 *
 * @example
 * ```typescript
 * const orderPlaced = createEvent('order.placed', { orderId: 'o1' }, {
 *   correlationId: req.id, userId: user.id,
 * });
 * await events.publish(orderPlaced);
 *
 * // Downstream handler emits a child event:
 * const reserved = createChildEvent(orderPlaced, 'inventory.reserved', {
 *   orderId: 'o1', skus: ['sku-1', 'sku-2'],
 * });
 * // reserved.meta.causationId   === orderPlaced.meta.id
 * // reserved.meta.correlationId === orderPlaced.meta.correlationId
 * // reserved.meta.userId        === user.id   (inherited)
 * ```
 */
export function createChildEvent<T>(
  parent: DomainEvent,
  type: string,
  payload: T,
  meta?: Partial<EventMeta>,
): DomainEvent<T> {
  const inherited: Partial<EventMeta> = {
    correlationId: parent.meta.correlationId ?? parent.meta.id,
    causationId: parent.meta.id,
  };
  if (parent.meta.userId !== undefined) inherited.userId = parent.meta.userId;
  if (parent.meta.organizationId !== undefined) {
    inherited.organizationId = parent.meta.organizationId;
  }
  if (parent.meta.source !== undefined) inherited.source = parent.meta.source;
  if (parent.meta.idempotencyKey !== undefined) {
    inherited.idempotencyKey = parent.meta.idempotencyKey;
  }
  // `aggregate` is NOT inherited — child events usually belong to a different
  // aggregate than their parent (see the DDD semantics in EventMeta docs).

  return {
    type,
    payload,
    meta: {
      id: crypto.randomUUID(),
      timestamp: new Date(),
      ...inherited,
      ...meta,
    },
  };
}
