/**
 * Redis-backed cluster failure counting for {@link CircuitBreaker}.
 *
 * A fixed-window counter per circuit: `INCR` the key, `PEXPIRE` it on the first
 * increment, read the count back from `INCR`'s own reply. One round trip on the
 * failure path, none on the success path.
 *
 * ## Why a fixed window and not a sliding one
 *
 * A sliding window (a sorted set of timestamps, `ZREMRANGEBYSCORE` + `ZCARD`)
 * is more precise and costs a multi-command round trip plus unbounded member
 * growth under a real outage — which is exactly when the store is busiest and
 * least healthy. The imprecision it buys back is a boundary effect: failures
 * straddling a window edge can take up to two windows to trip instead of one.
 * For a breaker whose job is "notice the downstream is down", one extra window
 * is not the failure mode worth paying for.
 *
 * Size `windowMs` to the outage you want to catch, not to the request rate: it
 * is the period over which `failureThreshold` failures mean "down". The default
 * matches the breaker's own default `resetTimeout` (60s), so a circuit that
 * reopens is counting over the same horizon it probes on.
 *
 * @example
 * ```ts
 * import { CircuitBreaker } from '@classytic/arc/utils';
 * import { RedisCircuitBreakerState } from '@classytic/arc/utils/circuit-breaker-redis';
 * import Redis from 'ioredis';
 *
 * const shared = new RedisCircuitBreakerState({ redis: new Redis(process.env.REDIS_URL) });
 *
 * const payments = new CircuitBreaker(charge, {
 *   name: 'stripe.charges',   // REQUIRED with sharedState — the cluster key
 *   failureThreshold: 5,
 *   sharedState: shared,
 * });
 * ```
 */

import type { CircuitBreakerSharedState } from "./circuitBreaker.js";

/**
 * The two commands this needs. Variadic tail is `unknown[]` for the same
 * reason as every other `*Like` shape in arc — ioredis types its commands as
 * overloads mixing literal tokens and an optional callback, which a narrower
 * tail matches none of. Pinned by `tests/types/ioredis-assignability.test.ts`.
 */
export interface CircuitBreakerRedisLike {
  incr(key: string): Promise<number>;
  pexpire(key: string, milliseconds: number, ...args: unknown[]): Promise<number>;
  del(...keys: string[]): Promise<number>;
}

export interface RedisCircuitBreakerStateOptions {
  /** Redis client (ioredis or compatible). */
  redis: CircuitBreakerRedisLike;
  /**
   * Key prefix (default: `'arc:circuit:'`). Keys are `{prefix}{circuitName}`,
   * so the circuit's `name` is what every replica must agree on.
   */
  prefix?: string;
  /**
   * Counting window in ms (default: `60_000`, matching the breaker's default
   * `resetTimeout`). The period over which `failureThreshold` failures mean
   * the downstream is down.
   */
  windowMs?: number;
}

/** Fixed-window cluster failure counter. See the module header. */
export class RedisCircuitBreakerState implements CircuitBreakerSharedState {
  readonly name = "redis";
  readonly #redis: CircuitBreakerRedisLike;
  readonly #prefix: string;
  readonly #windowMs: number;

  constructor(options: RedisCircuitBreakerStateOptions) {
    this.#redis = options.redis;
    this.#prefix = options.prefix ?? "arc:circuit:";
    const windowMs = options.windowMs ?? 60_000;
    // A non-positive window makes `PEXPIRE` delete the key immediately, so the
    // count would reset on every failure and the circuit could never trip
    // cluster-wide — protection silently disabled. Refuse at construction.
    if (!Number.isFinite(windowMs) || windowMs <= 0) {
      throw new Error(
        `[arc] RedisCircuitBreakerState: windowMs must be a positive number, got ${String(options.windowMs)}.`,
      );
    }
    this.#windowMs = windowMs;
  }

  async recordFailure(circuit: string): Promise<number> {
    const key = this.#prefix + circuit;
    const count = await this.#redis.incr(key);
    // Only the increment that CREATED the key sets the expiry. Refreshing it
    // on every failure would turn the fixed window into a sliding one that
    // never expires under sustained load — the count would keep climbing from
    // an outage that ended hours ago.
    if (count === 1) {
      await this.#redis.pexpire(key, this.#windowMs);
    }
    return count;
  }

  async reset(circuit: string): Promise<void> {
    await this.#redis.del(this.#prefix + circuit);
  }
}
