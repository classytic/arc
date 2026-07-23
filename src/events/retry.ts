/**
 * Event Handler Retry with Dead Letter Queue
 *
 * Transport-agnostic retry wrapper for event handlers.
 * Works with any EventTransport (Memory, Redis Pub/Sub, Redis Streams).
 *
 * @example
 * ```typescript
 * import { withRetry } from '@classytic/arc/events';
 *
 * // Retry up to 3 times with exponential backoff
 * await fastify.events.subscribe('order.created', withRetry(
 *   async (event) => {
 *     await sendConfirmationEmail(event.payload);
 *   },
 *   { maxRetries: 3, backoffMs: 1000 }
 * ));
 *
 * // With dead letter callback
 * await fastify.events.subscribe('order.created', withRetry(
 *   async (event) => { ... },
 *   {
 *     maxRetries: 3,
 *     onDead: async (event, errors) => {
 *       await fastify.events.publish('$deadLetter', { event, errors });
 *     },
 *   }
 * ));
 * ```
 */

import type {
  DeadLetteredEvent,
  DomainEvent,
  EventHandler,
  EventLogger,
  EventTransport,
} from "./EventTransport.js";

export interface RetryOptions {
  /**
   * Max retry attempts (not counting the initial attempt).
   * @default 3
   */
  maxRetries?: number;

  /**
   * Initial backoff delay in ms. Doubles on each retry (exponential backoff).
   * @default 1000
   */
  backoffMs?: number;

  /**
   * Maximum backoff delay in ms (caps exponential growth).
   * @default 30000
   */
  maxBackoffMs?: number;

  /**
   * Jitter factor (0-1). Adds randomness to prevent thundering herd.
   * 0 = no jitter, 1 = full jitter (delay ∈ [0, calculated]).
   * @default 0.1
   */
  jitter?: number;

  /**
   * Transport to route dead-lettered events to. When set and the transport
   * implements {@link EventTransport.deadLetter}, exhausted events are
   * auto-wrapped in a {@link DeadLetteredEvent} envelope and routed to the
   * transport's native DLQ (Kafka DLQ topic, SQS DLQ, etc.). No custom
   * plumbing needed for Kafka/SQS/Streams users.
   *
   * Works alongside {@link onDead} — both fire if both are set.
   */
  transport?: Pick<EventTransport, "deadLetter">;

  /**
   * DURABLE dead-letter persistence for exhausted events (custom store,
   * `$deadLetter` publisher, ...). Treated exactly like
   * {@link transport}.deadLetter: a failure follows {@link dlqFailureMode}
   * — rethrow by default, so the transport redelivers instead of
   * acknowledging an event that is neither processed nor persisted.
   *
   * This is what `eventPlugin({ deadLetterQueue })` wires. Use
   * {@link onDead} for metrics/alerts whose failure must NOT affect
   * acknowledgement.
   */
  deadLetter?: (event: DomainEvent, errors: Error[]) => void | Promise<void>;

  /**
   * OBSERVABILITY callback when all retries are exhausted (metrics,
   * alerting, logging). Fires in addition to {@link transport} /
   * {@link deadLetter} routing. Failures are logged and swallowed — this
   * callback can never affect whether the event is acknowledged; durable
   * persistence belongs in {@link deadLetter}.
   */
  onDead?: (event: DomainEvent, errors: Error[]) => void | Promise<void>;

  /**
   * What to do when `transport.deadLetter()` ITSELF fails after retries are
   * exhausted.
   *
   *  - `'rethrow'` (default) — the wrapper throws, so the transport treats
   *    the handler as failed: an at-least-once transport (Redis Streams,
   *    SQS) keeps the original message pending and redelivers it. The only
   *    mode that cannot LOSE the event — returning normally would
   *    acknowledge a message that was neither processed nor persisted.
   *  - `'log-and-drop'` — log the DLQ failure and return normally,
   *    acknowledging the message. Only correct when losing the event is
   *    acceptable (metrics, notifications).
   *
   * @default 'rethrow'
   */
  dlqFailureMode?: "rethrow" | "log-and-drop";

  /**
   * Optional name for logging + written into `DeadLetteredEvent.handlerName`.
   */
  name?: string;

  /**
   * Logger for retry warnings and error messages (default: console).
   * Pass `fastify.log` to integrate with your application logger.
   */
  logger?: EventLogger;
}

/**
 * Wrap an event handler with retry logic and dead letter support.
 *
 * On failure, retries with exponential backoff (with jitter).
 * After all retries exhausted, calls `onDead` callback if provided.
 *
 * Generic in the payload type `T` so composing with `wrapWithSchema<T>` /
 * `subscribeWithSchema<T>` doesn't force a cast at the boundary — the inner
 * `handler: EventHandler<T>` flows through to the returned wrapper. Defaults
 * to `unknown` for raw `subscribe(pattern, withRetry(...))` call sites.
 */
export function withRetry<T = unknown>(
  handler: EventHandler<T>,
  options: RetryOptions = {},
): EventHandler<T> {
  const {
    maxRetries = 3,
    backoffMs = 1000,
    maxBackoffMs = 30_000,
    jitter = 0.1,
    transport,
    deadLetter,
    onDead,
    dlqFailureMode = "rethrow",
    name,
    logger = console,
  } = options;

  const label = name ?? handler.name ?? "anonymous";

  return async (event: DomainEvent<T>): Promise<void> => {
    const errors: Error[] = [];
    let firstFailedAt: Date | undefined;
    let lastFailedAt: Date | undefined;
    let dlqPersistError: Error | undefined;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        await handler(event);
        return; // Success
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        const now = new Date();
        errors.push(error);
        if (firstFailedAt === undefined) firstFailedAt = now;
        lastFailedAt = now;

        if (attempt < maxRetries) {
          // Calculate delay with exponential backoff + jitter
          const baseDelay = Math.min(backoffMs * 2 ** attempt, maxBackoffMs);
          const jitterAmount = jitter * baseDelay * Math.random();
          const delay = baseDelay + jitterAmount;

          logger.warn(
            `[Arc Events] Handler '${label}' failed for ${event.type} ` +
              `(attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${Math.round(delay)}ms: ${error.message}`,
          );

          await sleep(delay);
        }
      }
    }

    // All retries exhausted — event is dead
    const attempts = maxRetries + 1;
    logger.error(
      `[Arc Events] Handler '${label}' permanently failed for ${event.type} ` +
        `after ${attempts} attempts. ${errors.length} errors.`,
    );

    // Auto-route to transport DLQ if available. Built first so onDead can
    // compose with it (e.g. metrics + DLQ in parallel) instead of forcing
    // users to pick one.
    if (transport?.deadLetter) {
      const lastError = errors[errors.length - 1];
      const dlq: DeadLetteredEvent = {
        event,
        error: {
          message: lastError?.message ?? "unknown",
          ...(lastError && "code" in lastError && typeof lastError.code === "string"
            ? { code: lastError.code as string }
            : {}),
          ...(lastError?.stack ? { stack: lastError.stack } : {}),
        },
        attempts,
        firstFailedAt: firstFailedAt ?? new Date(),
        lastFailedAt: lastFailedAt ?? new Date(),
        handlerName: label,
      };
      try {
        await transport.deadLetter(dlq);
      } catch (dlqErr) {
        logger.error("[Arc Events] transport.deadLetter() failed:", dlqErr);
        dlqPersistError = dlqErr instanceof Error ? dlqErr : new Error(String(dlqErr));
      }
    }

    // Custom durable persistence (eventPlugin's deadLetterQueue.store or
    // $deadLetter publisher) — same failure contract as transport.deadLetter.
    if (deadLetter) {
      try {
        await deadLetter(event, errors);
      } catch (dlqErr) {
        logger.error("[Arc Events] deadLetter() persistence failed:", dlqErr);
        dlqPersistError ??= dlqErr instanceof Error ? dlqErr : new Error(String(dlqErr));
      }
    }

    if (onDead) {
      try {
        await onDead(event, errors);
      } catch (dlqErr) {
        logger.error("[Arc Events] onDead observability callback failed:", dlqErr);
      }
    }

    // Returning normally acknowledges the message. Rethrow (default) when
    // durable DLQ persistence failed so at-least-once transports retain
    // the original — otherwise the event is neither processed nor
    // dead-lettered. (onDead above is observability; it still ran.)
    if (dlqPersistError && dlqFailureMode === "rethrow") {
      throw new Error(
        `[Arc Events] Handler '${label}' exhausted retries for ${event.type} AND ` +
          "dead-letter persistence failed — rethrowing so the transport redelivers " +
          "instead of acknowledging a lost event (set dlqFailureMode: 'log-and-drop' " +
          "to accept loss).",
        { cause: dlqPersistError },
      );
    }
  };
}

/**
 * Create a dead letter publisher that sends failed events to a `$deadLetter` channel.
 *
 * @example
 * ```typescript
 * import { withRetry, createDeadLetterPublisher } from '@classytic/arc/events';
 *
 * const toDlq = createDeadLetterPublisher(fastify.events);
 *
 * await fastify.events.subscribe('order.created', withRetry(handler, {
 *   maxRetries: 3,
 *   onDead: toDlq,
 * }));
 *
 * // Monitor dead letters
 * await fastify.events.subscribe('$deadLetter', async (event) => {
 *   console.error('Dead letter:', event.payload);
 *   await alertOps(event.payload);
 * });
 * ```
 */
export function createDeadLetterPublisher(events: {
  publish: <T>(type: string, payload: T, meta?: Record<string, unknown>) => Promise<void>;
}): (event: DomainEvent, errors: Error[]) => Promise<void> {
  return async (event: DomainEvent, errors: Error[]) => {
    await events.publish("$deadLetter", {
      originalEvent: event,
      errors: errors.map((e) => ({
        message: e.message,
        stack: e.stack,
      })),
      failedAt: new Date().toISOString(),
    });
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
