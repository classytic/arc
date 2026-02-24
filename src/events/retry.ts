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

import type { DomainEvent, EventHandler, EventLogger } from './EventTransport.js';

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
   * Callback when all retries are exhausted. The event is "dead".
   * Use this to publish to a `$deadLetter` channel, log, alert, etc.
   */
  onDead?: (event: DomainEvent, errors: Error[]) => void | Promise<void>;

  /**
   * Optional name for logging/debugging.
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
 */
export function withRetry(
  handler: EventHandler,
  options: RetryOptions = {},
): EventHandler {
  const {
    maxRetries = 3,
    backoffMs = 1000,
    maxBackoffMs = 30_000,
    jitter = 0.1,
    onDead,
    name,
    logger = console,
  } = options;

  const label = name ?? handler.name ?? 'anonymous';

  return async (event: DomainEvent): Promise<void> => {
    const errors: Error[] = [];

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        await handler(event);
        return; // Success
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        errors.push(error);

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
    logger.error(
      `[Arc Events] Handler '${label}' permanently failed for ${event.type} ` +
      `after ${maxRetries + 1} attempts. ${errors.length} errors.`,
    );

    if (onDead) {
      try {
        await onDead(event, errors);
      } catch (dlqErr) {
        logger.error('[Arc Events] Dead letter callback failed:', dlqErr);
      }
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
export function createDeadLetterPublisher(
  events: { publish: <T>(type: string, payload: T, meta?: Record<string, unknown>) => Promise<void> },
): (event: DomainEvent, errors: Error[]) => Promise<void> {
  return async (event: DomainEvent, errors: Error[]) => {
    await events.publish('$deadLetter', {
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
