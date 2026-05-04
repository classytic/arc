/**
 * Event Plugin
 *
 * Integrates event transport with Fastify.
 * Defaults to in-memory transport; configure durable transport for production.
 *
 * @example
 * // Development (in-memory)
 * await fastify.register(eventPlugin);
 *
 * // Production (Redis)
 * await fastify.register(eventPlugin, {
 *   transport: new RedisEventTransport({ url: process.env.REDIS_URL }),
 * });
 */

import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import { requestContext } from "../context/requestContext.js";
import { arcLog } from "../logger/index.js";
import { createDomainError } from "../utils/errors.js";
import type { EventRegistry } from "./defineEvent.js";
import {
  createEvent,
  type DomainEvent,
  type EventHandler,
  type EventTransport,
  MemoryEventTransport,
} from "./EventTransport.js";
import { createDeadLetterPublisher, type RetryOptions, withRetry } from "./retry.js";

export interface EventPluginOptions {
  /** Event transport (default: MemoryEventTransport) */
  transport?: EventTransport;
  /** Enable event logging (default: false) */
  logEvents?: boolean;
  /**
   * Fail-open mode for runtime resilience (default: true).
   * - true: publish/subscribe/close errors are logged and suppressed — the
   *   request still succeeds even if event delivery fails. Safe for analytics
   *   and non-critical side effects.
   * - false: errors are thrown to caller — use this for business-critical
   *   events where silent loss is unacceptable (e.g. billing, notifications).
   *
   * **Important:** With `failOpen: true` (default), a transport outage will
   * silently drop events while requests continue succeeding. Pair with the
   * `onPublishError` callback to monitor failures, or use `wal` for
   * at-least-once delivery guarantees.
   */
  failOpen?: boolean;
  /**
   * Low-level write-ahead hook called BEFORE the transport publish, with an
   * optional acknowledge() called AFTER a successful publish.
   *
   * **Important**: this is NOT at-least-once delivery on its own. If
   * `transport.publish()` throws after `wal.save()`, the saved row stays
   * but arc does NOT relay it on next boot — there is no replay loop here.
   * For at-least-once you must EITHER:
   *
   *   1. Run a relay loop yourself (read unacknowledged WAL rows on boot,
   *      republish, ack on success), or
   *   2. Use `EventOutbox` ([./outbox.ts]) — `outbox.relay()` is the
   *      production-grade at-least-once primitive with claim/lease,
   *      retry/DLQ, multi-worker safety, and `repository`-backed durable
   *      storage. New code should prefer `EventOutbox` over `wal`.
   *
   * The `wal` slot is kept for hosts that want to integrate with custom
   * write-ahead infrastructure (Kafka producer transactions, S3 batch
   * archives, debug audit logs) without arc's outbox claim/lease semantics.
   */
  wal?: {
    save: (event: DomainEvent) => Promise<void>;
    acknowledge?: (eventId: string) => Promise<void>;
  };
  /**
   * Auto-wrap all subscribed handlers with retry logic.
   * When enabled, failed handler invocations are retried with exponential backoff.
   */
  retry?: Pick<RetryOptions, "maxRetries" | "backoffMs" | "maxBackoffMs" | "jitter">;
  /**
   * Dead letter queue for events that exhaust all retries.
   * Requires `retry` to be enabled. If `retry` is set but no custom `store`,
   * failed events are published to the `$deadLetter` event type by default.
   */
  deadLetterQueue?: {
    /** Custom store function. If omitted, publishes to '$deadLetter' event type. */
    store?: (event: DomainEvent, errors: Error[]) => void | Promise<void>;
  };
  /** Callback after successful publish (for metrics/tracking) */
  onPublish?: (event: DomainEvent) => void;
  /** Callback on publish failure (for metrics/alerting) */
  onPublishError?: (event: DomainEvent, error: Error) => void;
  /**
   * Event registry for payload validation and introspection.
   * When provided, payloads are validated against registered schemas on publish.
   *
   * @example
   * ```typescript
   * const registry = createEventRegistry();
   * registry.register(defineEvent({ name: 'order.created', schema: { ... } }));
   *
   * await fastify.register(eventPlugin, { registry, validateMode: 'warn' });
   * ```
   */
  registry?: EventRegistry;
  /**
   * How to handle schema validation failures on publish:
   * - `'warn'` (default when registry is provided): log a warning, still publish
   * - `'reject'`: throw an error, do NOT publish
   * - `'off'`: skip validation entirely (registry is only for introspection)
   */
  validateMode?: "warn" | "reject" | "off";
  /**
   * Dev-mode duplicate-publish detector (v2.12).
   *
   * When enabled, arc keeps a 5-second LRU on `(eventType, correlationId)`
   * and emits an `arcLog("events").warn(...)` the second time a request
   * publishes the same event with the same correlation id within the
   * window. Catches the dual-publish trap where a domain service holds
   * BOTH a publisher AND a notification helper that internally publishes
   * to the same bus — every subscriber fires twice for one logical event.
   *
   * Defaults:
   *   - `undefined` → enabled when `process.env.NODE_ENV !== 'production'`.
   *   - `true` → always enabled (catches duplicates in prod too — overhead
   *     is one Map lookup per publish).
   *   - `false` → always disabled.
   *
   * When a duplicate is detected, arc logs once and **still publishes** —
   * the detector is observability, not enforcement. Pair with the outbox
   * for at-most-once delivery.
   *
   * Documented in `wiki/gotchas.md` (#20).
   */
  warnOnDuplicate?: boolean;
}

declare module "fastify" {
  interface FastifyInstance {
    events: {
      /** Publish an event */
      publish: <T>(type: string, payload: T, meta?: Partial<DomainEvent["meta"]>) => Promise<void>;
      /** Subscribe to events */
      subscribe: (pattern: string, handler: EventHandler) => Promise<() => void>;
      /** Get transport name */
      transportName: string;
      /** Event registry for introspection (undefined when no registry configured) */
      registry?: EventRegistry;
    };
  }
}

const eventPlugin: FastifyPluginAsync<EventPluginOptions> = async (
  fastify: FastifyInstance,
  opts: EventPluginOptions = {},
) => {
  const {
    transport = new MemoryEventTransport(),
    logEvents = false,
    failOpen = true,
    retry: retryOpts,
    deadLetterQueue: dlqOpts,
    wal,
    onPublish,
    onPublishError,
    registry,
    validateMode: rawValidateMode,
    warnOnDuplicate: rawWarnOnDuplicate,
  } = opts;

  // Default validateMode: 'warn' when registry is provided, 'off' otherwise
  const validateMode = rawValidateMode ?? (registry ? "warn" : "off");

  // Default duplicate-publish detector: on in non-production, off in prod
  // unless explicitly enabled. See `EventPluginOptions.warnOnDuplicate` JSDoc.
  const warnOnDuplicate = rawWarnOnDuplicate ?? process.env.NODE_ENV !== "production";

  // 5-second LRU window — long enough to span retry backoffs, short enough
  // to catch the same logical request firing twice (dual-publish trap).
  // Keyed on `${eventType}::${correlationId}`; entries timestamped at insert.
  // Map ordering preserves insertion → cheap eviction by walking from the
  // front when the head entry is older than the window.
  const DUP_WINDOW_MS = 5_000;
  const recentPublishes: Map<string, number> = warnOnDuplicate ? new Map() : new Map();
  const evictExpiredPublishes = (now: number): void => {
    if (recentPublishes.size === 0) return;
    for (const [key, timestamp] of recentPublishes) {
      if (now - timestamp <= DUP_WINDOW_MS) break;
      recentPublishes.delete(key);
    }
  };

  // Decorate fastify with event utilities
  fastify.decorate("events", {
    publish: async <T>(
      type: string,
      payload: T,
      meta?: Partial<DomainEvent["meta"]>,
    ): Promise<void> => {
      // Validate event type — reject reserved prefixes and obviously invalid types
      if (!type || typeof type !== "string") {
        throw new Error("[Arc Events] Event type must be a non-empty string");
      }
      if (type.startsWith("$") && type !== "$deadLetter") {
        throw new Error(`[Arc Events] Event type '${type}' uses reserved '$' prefix`);
      }
      if (type.length > 256) {
        throw new Error("[Arc Events] Event type exceeds 256 characters");
      }

      // Auto-inject correlationId from request context if not already set
      const store = requestContext.get();
      const enrichedMeta: Partial<DomainEvent["meta"]> = {
        ...(store?.requestId && !meta?.correlationId ? { correlationId: store.requestId } : {}),
        ...meta,
      };
      const event = createEvent(type, payload, enrichedMeta);

      // Dev-mode duplicate-publish detector. Keyed on (type, correlationId)
      // with a 5-second window. Catches the dual-publish trap where a
      // service holds both a publisher and a notification helper that
      // also publishes — every subscriber would otherwise fire twice.
      // See wiki/gotchas.md #20.
      if (warnOnDuplicate && event.meta.correlationId) {
        const now = Date.now();
        evictExpiredPublishes(now);
        const dupKey = `${type}::${event.meta.correlationId}`;
        const previous = recentPublishes.get(dupKey);
        if (previous !== undefined && now - previous <= DUP_WINDOW_MS) {
          arcLog("events").warn(
            `Duplicate publish detected: event type "${type}" published twice within ` +
              `${DUP_WINDOW_MS}ms with correlationId "${event.meta.correlationId}". ` +
              `Subscribers will fire twice for the same logical event. ` +
              `Common cause: a domain service holds both a publisher and a notification ` +
              `helper that also publishes to the same bus — pick one. ` +
              `Set \`arcPlugins: { events: { warnOnDuplicate: false } }\` to silence.`,
          );
        }
        // Update timestamp for this key (re-publishes refresh the window).
        // Map order: delete-then-set keeps the entry at the tail so
        // eviction walks from oldest to newest naturally.
        recentPublishes.delete(dupKey);
        recentPublishes.set(dupKey, now);
      }

      if (logEvents) {
        fastify.log?.info?.(
          {
            eventType: type,
            eventId: event.meta.id,
            correlationId: event.meta.correlationId,
          },
          "Publishing event",
        );
      }

      // Schema validation (when registry is provided and mode is not 'off')
      if (registry && validateMode !== "off") {
        // Validate against the schema version the producer declared on the
        // event itself. `defineEvent.create()` stamps `meta.schemaVersion`
        // automatically; raw `publish()` calls without an explicit version
        // fall through to the registry's "latest" lookup, preserving the
        // 2.11.3 behaviour for unversioned producers.
        const result = registry.validate(type, payload, event.meta.schemaVersion);
        if (!result.valid) {
          const msg = `[Arc Events] Event '${type}' payload validation failed: ${result.errors?.join("; ")}`;
          if (validateMode === "reject") {
            // 400 with a hierarchical event-domain code so consumers can
            // discriminate event-validation errors from CRUD-validation
            // errors at observability + retry-policy time. `details.event`
            // pins the offending event type for log-aggregation.
            throw createDomainError("arc.event.validation_error", msg, 400, {
              event: type,
              errors: result.errors,
            });
          }
          // warn mode — log and continue
          fastify.log?.warn?.(msg);
        }
      }

      try {
        // Skip WAL for internal lifecycle events (arc.*) — these are fire-and-forget
        // and don't need at-least-once delivery guarantees. With a durable WAL store
        // (e.g. MongoDB), each save() is an awaited DB write. For apps with many
        // resources, WAL-ing every arc.resource.registered during startup can exhaust
        // Fastify's plugin timeout window.
        const isInternalEvent = type.startsWith("arc.");
        if (wal && !isInternalEvent) {
          await wal.save(event);
        }
        await transport.publish(event);
        if (wal?.acknowledge && !isInternalEvent) {
          await wal.acknowledge(event.meta.id);
        }
        onPublish?.(event);
      } catch (error) {
        fastify.log?.error?.(
          { transport: transport.name, eventType: type, error },
          "[Arc Events] Failed to publish event",
        );
        onPublishError?.(event, error as Error);
        if (!failOpen) throw error;
      }
    },

    subscribe: async (pattern: string, handler: EventHandler): Promise<() => void> => {
      // Auto-wrap handler with retry if configured (skip for DLQ subscriptions)
      let wrappedHandler = handler;
      if (retryOpts && pattern !== "$deadLetter") {
        wrappedHandler = withRetry(handler, {
          ...retryOpts,
          onDead: dlqOpts?.store ?? createDeadLetterPublisher(fastify.events),
          logger: fastify.log as import("./EventTransport.js").EventLogger,
        });
      }

      if (logEvents) {
        fastify.log?.info?.({ pattern, retry: !!retryOpts }, "Subscribing to events");
      }
      try {
        return await transport.subscribe(pattern, wrappedHandler);
      } catch (error) {
        fastify.log?.error?.(
          { transport: transport.name, pattern, error },
          "[Arc Events] Failed to subscribe to events",
        );
        if (!failOpen) throw error;
        return () => {};
      }
    },

    transportName: transport.name,
    registry,
  });

  // Cleanup on close
  fastify.addHook("onClose", async () => {
    try {
      await transport.close?.();
    } catch (error) {
      fastify.log?.warn?.(
        { transport: transport.name, error },
        "[Arc Events] Transport close failed",
      );
      if (!failOpen) throw error;
    }
  });

  // Log transport type
  if (transport.name === "memory") {
    fastify.log?.warn?.(
      "[Arc Events] Using in-memory transport. Events will not persist or scale across instances. " +
        "For production, configure a durable transport (Redis, RabbitMQ, etc.)",
    );
  } else {
    fastify.log?.debug?.(`[Arc Events] Using ${transport.name} transport`);
  }
};

export default fp(eventPlugin, {
  name: "arc-events",
  fastify: "5.x",
});

export { eventPlugin };
