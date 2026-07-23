/**
 * Exponential backoff for outbox failure policies — pure date math shared
 * by `failurePolicy({ attempts })` style handlers.
 */

// ============================================================================
// Retry helpers — utilities for store authors implementing `fail()` with backoff
// ============================================================================

/**
 * Options for {@link exponentialBackoff}.
 */
export interface ExponentialBackoffOptions {
  /** Current attempt count (1-indexed — first retry is attempt 1) */
  readonly attempt: number;
  /** Base delay in ms (first retry delay). Default: 1000 (1 second) */
  readonly baseMs?: number;
  /** Maximum delay in ms — caps exponential growth. Default: 60_000 (1 minute) */
  readonly maxMs?: number;
  /**
   * Jitter factor [0–1]. The returned delay is multiplied by
   * `1 + (random * jitter)` to spread retry bursts across workers.
   * Default: 0.2 (±20%). Set to 0 to disable.
   */
  readonly jitter?: number;
  /** Reference time (for deterministic tests). Default: `Date.now()` */
  readonly now?: number;
}

/**
 * Compute a `retryAt` `Date` using exponential backoff with jitter.
 *
 * This is a convenience helper for store authors implementing
 * {@link OutboxStore.fail}: call it to compute the retry visibility window
 * based on the event's current attempt count.
 *
 * Formula: `delay = min(maxMs, baseMs * 2^(attempt - 1)) * (1 + random * jitter)`
 *
 * @example Basic usage inside a store's `fail()` method
 * ```typescript
 * async fail(eventId, error, options) {
 *   const entry = await this.findById(eventId);
 *   entry.attempts++;
 *   if (entry.attempts >= MAX_ATTEMPTS) {
 *     return this.deadLetter(eventId, error);
 *   }
 *   const retryAt = exponentialBackoff({ attempt: entry.attempts });
 *   entry.visibleAt = retryAt;
 *   await this.update(entry);
 * }
 * ```
 *
 * @example Tuning for a faster transport
 * ```typescript
 * exponentialBackoff({ attempt: 3, baseMs: 250, maxMs: 10_000, jitter: 0.3 });
 * // attempt=1 → ~250ms   ±30%
 * // attempt=2 → ~500ms   ±30%
 * // attempt=3 → ~1000ms  ±30%
 * // attempt=10 → capped at 10_000ms
 * ```
 */
export function exponentialBackoff(options: ExponentialBackoffOptions): Date {
  const attempt = Math.max(1, Math.floor(options.attempt));
  const baseMs = options.baseMs ?? 1000;
  const maxMs = options.maxMs ?? 60_000;
  const jitter = Math.max(0, Math.min(1, options.jitter ?? 0.2));
  const now = options.now ?? Date.now();

  // Exponential growth: base * 2^(attempt-1), capped at maxMs
  const exp = baseMs * 2 ** (attempt - 1);
  const capped = Math.min(maxMs, exp);

  // Apply jitter (always additive — never schedules earlier than `capped`)
  const jittered = jitter > 0 ? capped * (1 + Math.random() * jitter) : capped;

  return new Date(now + jittered);
}
