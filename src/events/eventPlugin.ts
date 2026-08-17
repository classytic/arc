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

import { isProductionEnv } from "@classytic/primitives/environment";
import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import { requestContext } from "../context/requestContext.js";
import { arcLog } from "../logger/index.js";
import { createDomainError } from "../utils/errors.js";
import type { EventRegistry } from "./defineEvent.js";
import {
  ARC_EVENT_TRANSPORT,
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
  /**
   * Declare that this deployment is ONE process on purpose — the in-memory
   * transport is its intended configuration, not a forgotten default.
   *
   * A single-node host (a small SaaS on one VPS, an on-prem install, a
   * personal deployment that cannot justify Redis) is a legitimate production
   * topology: with one process there are no other instances to broadcast to,
   * so the memory transport is not a compromise — it is exactly sufficient.
   * Without this flag arc cannot tell that apart from the accidental default
   * (a multi-replica deployment that forgot to configure Redis), so it warns
   * on every boot. Setting `singleProcess: true` states the topology and
   * downgrades the warn to a factual info line.
   *
   * What it does NOT change: in-process delivery semantics. Events still
   * vanish with the process — subscribers that were offline missed them. For
   * durable at-least-once delivery on a single node, pair this with the
   * repository-backed outbox (`createOutboxModule` + `repositoryAsOutboxStore`):
   * events are committed to YOUR database and relayed to the in-process
   * subscribers, so a crash between write and delivery replays on restart —
   * no Redis anywhere in that path.
   *
   * Scale-out later by swapping the transport (Redis Streams etc.) and
   * removing this flag; handler code is transport-independent and unchanged.
   *
   * Ignored (with a warn) when a non-memory transport is configured — the
   * declaration would be describing a topology the transport contradicts.
   */
  singleProcess?: boolean;
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
   *
   * The store is DURABLE persistence: if it throws, the wrapped handler
   * rethrows (per `retry.dlqFailureMode`, default `'rethrow'`) so an
   * at-least-once transport redelivers instead of acknowledging an event
   * that was neither processed nor dead-lettered. Metrics/alerting belongs
   * in `retry.onDead`, whose failures never affect acknowledgement.
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
  /**
   * Lifecycle ownership: arc closes ONLY the transport it built.
   *
   * A host-supplied transport (a Redis client wrapper, typically) may be
   * shared with other apps in the process or outlive this one — closing it
   * on this app's shutdown severs a connection arc does not own. Read
   * BEFORE the destructure, because the default below is indistinguishable
   * from a host value afterwards.
   */
  const ownsTransport = opts.transport === undefined;
  const {
    transport = new MemoryEventTransport(),
    singleProcess = false,
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

  // Default duplicate-publish detector: on in non-production, off in prod unless explicitly
  // enabled. See `EventPluginOptions.warnOnDuplicate` JSDoc.
  //
  // Shared classifier, not a raw comparison — `NODE_ENV=prod` read as non-production, so the
  // detector (and its per-publish LRU bookkeeping) stayed ON in production.
  const warnOnDuplicate = rawWarnOnDuplicate ?? !isProductionEnv(process.env.NODE_ENV);

  // 5-second LRU window — long enough to span retry backoffs, short enough
  // to catch the same logical request firing twice (dual-publish trap).
  // Keyed on `${eventType}::${correlationId}`; entries timestamped at insert.
  // Map ordering preserves insertion → cheap eviction by walking from the
  // front when the head entry is older than the window.
  const DUP_WINDOW_MS = 5_000;
  const recentPublishes = new Map<string, number>();
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
          // DURABLE slot — a failing store/publisher follows dlqFailureMode
          // (rethrow by default → the transport redelivers). Never wire the
          // store through `onDead`: that slot swallows failures, which would
          // acknowledge an event that was neither processed nor persisted.
          // User-supplied retryOpts.onDead (observability) flows through the
          // spread above.
          deadLetter: dlqOpts?.store ?? createDeadLetterPublisher(fastify.events),
          logger: fastify.log as import("./EventTransport.js").EventLogger,
        });
      }

      if (logEvents) {
        fastify.log?.info?.({ pattern, retry: !!retryOpts }, "Subscribing to events");
      }
      // `EventTransport.subscribe` is optional as of primitives 0.14 —
      // publish-only transports (outbox bridges, Kafka/webhook pipes) omit
      // it. Arc's subscribe path requires in-process delivery, so a
      // publish-only transport can't register a handler: fail clearly rather
      // than throw a cryptic "not a function". Backward-compatible with 0.13
      // (subscribe always present there).
      if (typeof transport.subscribe !== "function") {
        const error = new Error(
          `[Arc Events] transport '${transport.name}' is publish-only (no subscribe) — ` +
            `cannot register a handler for '${pattern}'. Use MemoryEventTransport / ` +
            `RedisEventTransport, or a transport that implements subscribe().`,
        );
        fastify.log?.error?.({ transport: transport.name, pattern }, error.message);
        if (!failOpen) throw error;
        return () => {};
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

  /**
   * The RAW transport, for machinery that must observe publish failure.
   *
   * `fastify.events` is a REQUEST-FACING FACADE, and two of its properties make
   * it wrong for a relay to publish through:
   *
   *   1. Different signature — `publish(type, payload, meta?)` vs the
   *      transport's `publish(event)`. Handing it a `DomainEvent` makes the
   *      envelope the `type` argument, which fails the non-empty-string guard.
   *      Measured on the default `createOutboxModule()` path: subscribers saw
   *      NOTHING and every relay tick reported `publishFailed: 1`, so events
   *      retried to dead-letter and never arrived.
   *   2. Fail-open — the facade catches publish errors and only rethrows when
   *      `failOpen: false`. That is correct for HTTP (a transport outage must
   *      not fail a user's request) and fatal for an outbox: a swallowed error
   *      reads as success, the row is acknowledged, and the durability the
   *      outbox exists to provide is gone.
   *
   * So the boundary is explicit: **the facade may fail open; the relay must
   * see the truth.** Decorated under a `Symbol.for` key — not part of the
   * public `EventsDecorator` surface, and registry-keyed so it still resolves
   * if a host's graph ends up with two arc copies.
   */
  fastify.decorate(ARC_EVENT_TRANSPORT, transport);

  // Cleanup on close
  fastify.addHook("onClose", async () => {
    if (!ownsTransport) return; // host-supplied — the host closes it
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

  // Log transport type. The memory transport carries THREE distinct
  // messages depending on what the host declared, because it has three
  // distinct meanings:
  //   - undeclared          → probably a forgotten default; warn every boot.
  //   - singleProcess: true → a deliberate single-node topology; state the
  //                           semantics once at info level and stop nagging.
  //   - flag + real transport → the declaration contradicts the wiring; say so.
  if (transport.name === "memory") {
    if (singleProcess) {
      fastify.log?.info?.(
        "[Arc Events] In-memory transport, declared single-process. Events are delivered " +
          "in-process only and do not survive a crash or restart; subscribers in other " +
          "processes (if any ever exist) will not receive them. For durability on this " +
          "single node, pair with the repository-backed outbox (createOutboxModule + " +
          "repositoryAsOutboxStore) — no Redis required. That covers a crash BEFORE " +
          "publish; to also retry a THROWING handler, construct the transport with " +
          "`onHandlerError: 'throw'` (by default a handler error is logged and the outbox " +
          "row is still acknowledged).",
      );
    } else {
      fastify.log?.warn?.(
        "[Arc Events] Using in-memory transport. Events will not persist or scale across " +
          "instances. If this deployment is intentionally a single process, declare it — " +
          "`eventPlugin, { singleProcess: true }` — and this becomes a supported " +
          "configuration instead of a warning. Otherwise configure a durable transport " +
          "(Redis Streams, RabbitMQ, etc.)",
      );
    }
  } else {
    if (singleProcess) {
      fastify.log?.warn?.(
        `[Arc Events] \`singleProcess: true\` is declared but the '${transport.name}' ` +
          "transport is configured — a cross-instance transport contradicts a single-process " +
          "declaration. The flag is ignored; remove it or switch back to the memory transport.",
      );
    }
    fastify.log?.debug?.(`[Arc Events] Using ${transport.name} transport`);
  }
};

export default fp(eventPlugin, {
  name: "arc-events",
  fastify: "5.x",
});

export { eventPlugin };
