/**
 * Subscribe-side helpers — close the symmetry that arc's publish-side
 * already has via [`eventPlugin({ registry, validateMode: 'reject' })`](./eventPlugin.ts).
 *
 * Two wrapper pairs, both transport-agnostic:
 *
 * - `wrapWithSchema` / `subscribeWithSchema` — read the schema from a
 *   typed `EventDefinitionOutput<T>` and validate `event.payload` before
 *   the handler runs. Single source of truth for event shape: declare
 *   once at `defineEvent`, enforced on BOTH sides without parallel Zod
 *   schemas in subscriber files.
 *
 * - `wrapWithBoundary` / `subscribeWithBoundary` — catch + log + swallow
 *   handler errors, for projection / cache-invalidation / fire-and-forget
 *   handlers where retry would just delay the next-event resync. Lighter
 *   than `withRetry` (no DLQ, no exponential backoff) and avoids the
 *   "single bad event poisons the bus" hazard.
 *
 * Both pairs compose with `withRetry` and with each other:
 *
 * ```ts
 * await subscribeWithSchema(
 *   fastify,
 *   OrderPaid,
 *   withRetry(handler, { maxRetries: 3 }),
 * );
 * ```
 *
 * @see [retry.ts](./retry.ts) for the retry + DLQ wrapper.
 * @see [defineEvent.ts](./defineEvent.ts) for `defineEvent` / `EventDefinitionOutput`.
 */

import type {
  CustomValidator,
  EventDefinitionOutput,
  EventRegistry,
  ValidationResult,
} from "./defineEvent.js";
import type { DomainEvent, EventHandler, EventLogger } from "./EventTransport.js";

// ============================================================================
// PayloadOf<D> — extract the payload type from an EventDefinitionOutput<T>
// ============================================================================

/**
 * Extract the payload type from an `EventDefinitionOutput<T>`.
 *
 * `defineEvent<T>` already threads `T` through `.create(payload: T, ...)`, but
 * there's no exposed way to recover `T` for use in handler signatures, factory
 * helpers, or test fixtures. `PayloadOf<typeof OrderPaid>` closes the loop
 * without forcing every host to define their own copy.
 *
 * @example
 * ```ts
 * const OrderPaid = defineEvent<{ orderId: string; total: number }>({
 *   name: 'order.paid',
 *   schema: { type: 'object', required: ['orderId', 'total'] },
 * });
 * type OrderPaidPayload = PayloadOf<typeof OrderPaid>;
 * //   ^? { orderId: string; total: number }
 * ```
 */
export type PayloadOf<D> = D extends EventDefinitionOutput<infer T> ? T : never;

// ============================================================================
// Schema-validating subscribe helpers
// ============================================================================

export interface WrapWithSchemaOptions<_T> {
  /**
   * Custom validator. Overrides the built-in lookup. Use this to plug AJV /
   * Zod / TypeBox in. Same shape as `EventRegistryOptions.validate`.
   *
   * Resolution order:
   *   1. `validate` (this option)
   *   2. `registry.validate(definition.name, payload)` — uses whatever
   *      validator the registry was configured with
   *   3. Built-in minimal validator (top-level `required` + property types)
   */
  validate?: CustomValidator;

  /**
   * Optional registry — when set and `validate` is omitted, validation routes
   * through `registry.validate(definition.name, payload)`. Lets the subscriber
   * use the same configured validator (AJV, custom) the publish side uses
   * via `eventPlugin({ registry })`.
   */
  registry?: EventRegistry;

  /**
   * Called when payload validation fails. Default behaviour: log a warning
   * with the event's id/type/errors and skip the handler (the event is NOT
   * acknowledged as a failure, since the handler never ran — matches `withRetry`'s
   * `onDead` semantics for terminal failures, but at the validation boundary).
   *
   * Receives the raw event (untyped — the payload is by definition not the
   * declared shape) plus the validation errors array.
   */
  onInvalid?: (event: DomainEvent<unknown>, errors: string[]) => void | Promise<void>;

  /**
   * Logger for invalid-payload warnings. Pass `fastify.log` to integrate
   * with the application logger. Default: `console`.
   */
  logger?: EventLogger;

  /**
   * Optional name for log output (otherwise the definition name is used).
   */
  name?: string;
}

/**
 * Pure handler wrapper — returns a new `EventHandler` that validates
 * `event.payload` against the definition's schema before invoking the handler.
 *
 * The returned handler's input is `DomainEvent<unknown>` (since the transport
 * delivers untyped events) but the inner `handler` receives `DomainEvent<T>`.
 * No cast at the call site.
 *
 * @example
 * ```ts
 * await fastify.events.subscribe(
 *   OrderPaid.name,
 *   wrapWithSchema(OrderPaid, async (event) => {
 *     // event.payload is typed via the registered schema — no cast.
 *     await postSalesEntry(event.payload.orderId, event.payload.total);
 *   }),
 * );
 * ```
 */
export function wrapWithSchema<T>(
  definition: EventDefinitionOutput<T>,
  handler: EventHandler<T>,
  options: WrapWithSchemaOptions<T> = {},
): EventHandler<unknown> {
  const { validate, registry, onInvalid, logger = console, name } = options;
  const label = name ?? definition.name;

  return async (event: DomainEvent<unknown>): Promise<void> => {
    // Resolution order documented on `WrapWithSchemaOptions.validate` —
    // explicit > registry > built-in. Skip entirely when no schema is
    // declared (matches `EventRegistry.validate` "events without schema pass"
    // semantics — `defineEvent` makes schema optional).
    //
    // Version threading: prefer the version stamped on the event itself
    // (`event.meta.schemaVersion` — set by `defineEvent.create()` since
    // 2.11.3), then fall back to `definition.version`. This makes the
    // subscriber validate against the schema the PRODUCER declared, not
    // whatever's currently installed locally. Critical during rolling
    // migrations where producer + consumer can be on different versions.
    const eventVersion =
      typeof event.meta?.schemaVersion === "number" ? event.meta.schemaVersion : definition.version;
    let result: ValidationResult;
    if (validate && definition.schema) {
      result = validate(definition.schema, event.payload);
    } else if (registry) {
      result = registry.validate(definition.name, event.payload, eventVersion);
    } else if (definition.schema) {
      // Lazy-import to avoid a cycle: `defineEvent.ts` exports the validator
      // and this file is pulled in via `events/index.ts`.
      const { createEventRegistry } = await import("./defineEvent.js");
      const adhoc = createEventRegistry();
      adhoc.register(definition as unknown as EventDefinitionOutput);
      result = adhoc.validate(definition.name, event.payload);
    } else {
      // No schema declared anywhere — pass through (consistent with the
      // registry's "unknown / unschema'd events pass" behaviour).
      result = { valid: true };
    }

    if (!result.valid) {
      const errors = result.errors ?? ["payload failed validation"];
      if (onInvalid) {
        try {
          await onInvalid(event, errors);
        } catch (cbErr) {
          logger.error(`[Arc Events] '${label}' onInvalid callback threw:`, cbErr);
        }
      } else {
        logger.warn(
          `[Arc Events] '${label}' skipped event ${event.meta?.id ?? "<no-id>"} ` +
            `— payload failed validation: ${errors.join("; ")}`,
        );
      }
      return; // Skip handler — payload doesn't match the declared shape.
    }

    // Validated — handler receives DomainEvent<T> (cast safe because we just
    // verified the payload against T's schema).
    await handler(event as DomainEvent<T>);
  };
}

/**
 * Convenience: validate + subscribe in one call. Equivalent to
 * `fastify.events.subscribe(definition.name, wrapWithSchema(definition, handler, options))`.
 *
 * Returns the unsubscribe function from the underlying transport.
 *
 * @example
 * ```ts
 * await subscribeWithSchema(fastify, OrderPaid, async (event) => {
 *   await postSalesEntry(event.payload.orderId, event.payload.total);
 * });
 *
 * // Compose with withRetry — schema validation runs FIRST, then retry on
 * // handler failure. Invalid payloads skip without burning retry attempts.
 * await subscribeWithSchema(
 *   fastify,
 *   OrderPaid,
 *   withRetry(handler, { maxRetries: 3 }),
 * );
 * ```
 */
export async function subscribeWithSchema<T>(
  fastify: FastifyEventBus,
  definition: EventDefinitionOutput<T>,
  handler: EventHandler<T>,
  options?: WrapWithSchemaOptions<T>,
): Promise<() => void> {
  return fastify.events.subscribe(definition.name, wrapWithSchema(definition, handler, options));
}

// ============================================================================
// Error-boundary subscribe helpers (fire-and-forget projections)
// ============================================================================

export interface WrapWithBoundaryOptions {
  /**
   * Called when the handler throws. Default behaviour: log the error with
   * `{ err, event: event.type, eventId: event.meta.id }` and swallow.
   *
   * Use this to push metrics (`statsd.increment('handler.error', { type })`)
   * or alert on specific event types.
   */
  onError?: (err: Error, event: DomainEvent) => void | Promise<void>;

  /**
   * Logger for handler errors. Pass `fastify.log` to integrate with the
   * application logger. Default: `console`.
   */
  logger?: EventLogger;

  /**
   * Optional name for log output (otherwise the handler's `.name` is used).
   */
  name?: string;
}

/**
 * Pure handler wrapper — returns a new `EventHandler` that catches handler
 * exceptions and routes them to `onError` (or logs and swallows). For
 * projection / cache-invalidation / fire-and-forget handlers where retry
 * would just delay the next-event resync, and where one bad event must NOT
 * stop processing of subsequent events.
 *
 * Lighter than `withRetry`: no exponential backoff, no DLQ. Composes with
 * `withRetry` if you want both ("retry, then log if exhausted, never throw").
 *
 * @example
 * ```ts
 * await fastify.events.subscribe(
 *   'product:variants.changed',
 *   wrapWithBoundary(async (event) => {
 *     cache.invalidate(event.payload.productId);
 *   }),
 * );
 * ```
 */
export function wrapWithBoundary(
  handler: EventHandler,
  options: WrapWithBoundaryOptions = {},
): EventHandler {
  const { onError, logger = console, name } = options;
  const label = name ?? handler.name ?? "anonymous";

  return async (event: DomainEvent): Promise<void> => {
    try {
      await handler(event);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      if (onError) {
        try {
          await onError(error, event);
        } catch (cbErr) {
          logger.error(`[Arc Events] '${label}' onError callback threw:`, cbErr);
        }
      } else {
        // Two-arg shape: message string first (matches arc's EventLogger
        // contract), structured context as a follow-up arg so pino-style
        // loggers can still inspect `{ err, event, eventId }` while plain
        // `console` ignores it.
        logger.error(
          `[Arc Events] '${label}' threw on ${event.type} — swallowed (boundary): ${error.message}`,
          { err: error, event: event.type, eventId: event.meta?.id, handler: label },
        );
      }
    }
  };
}

/**
 * Convenience: subscribe + error-boundary in one call. Equivalent to
 * `fastify.events.subscribe(pattern, wrapWithBoundary(handler, options))`.
 *
 * Returns the unsubscribe function from the underlying transport.
 */
export async function subscribeWithBoundary(
  fastify: FastifyEventBus,
  pattern: string,
  handler: EventHandler,
  options?: WrapWithBoundaryOptions,
): Promise<() => void> {
  return fastify.events.subscribe(pattern, wrapWithBoundary(handler, options));
}

// ============================================================================
// Internal — minimal Fastify shape these helpers actually use
// ============================================================================

/**
 * Structural type — accepts anything with the `events.subscribe` method,
 * including `FastifyInstance` (declaration-merged in `eventPlugin.ts`) and
 * test doubles. Avoids importing the full Fastify type in this module.
 */
interface FastifyEventBus {
  events: {
    subscribe: (pattern: string, handler: EventHandler) => Promise<() => void>;
  };
}
