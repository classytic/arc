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
  readonly name = 'memory';
  private handlers = new Map<string, Set<EventHandler>>();
  private logger: EventLogger;

  constructor(options?: MemoryEventTransportOptions) {
    this.logger = options?.logger ?? console;
  }

  async publish(event: DomainEvent): Promise<void> {
    // Exact match handlers
    const exactHandlers = this.handlers.get(event.type) ?? new Set();

    // Wildcard handlers
    const wildcardHandlers = this.handlers.get('*') ?? new Set();

    // Pattern match handlers (e.g., 'product.*' matches 'product.created')
    const patternHandlers = new Set<EventHandler>();
    for (const [pattern, handlers] of this.handlers.entries()) {
      if (pattern.endsWith('.*')) {
        const prefix = pattern.slice(0, -2);
        if (event.type.startsWith(prefix + '.')) {
          handlers.forEach((h) => patternHandlers.add(h));
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

  async subscribe(pattern: string, handler: EventHandler): Promise<() => void> {
    if (!this.handlers.has(pattern)) {
      this.handlers.set(pattern, new Set());
    }
    this.handlers.get(pattern)!.add(handler);

    return () => {
      this.handlers.get(pattern)?.delete(handler);
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
  meta?: Partial<DomainEvent['meta']>
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

export default MemoryEventTransport;
