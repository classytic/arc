/**
 * Redis-backed usage store — the shared counter backend for multi-replica
 * deployments.
 *
 * `runtime: 'distributed'` fails boot naming `usage.store` when the memory
 * default is in play, and until now arc shipped nothing to fix it with: the
 * plugin's own example told hosts to write `new RedisUsageStore({ client })`,
 * which did not exist. A kit-backed store (`@classytic/mongokit/usage`) was
 * always an answer, but it puts a write on the primary database for every
 * request — and these counters are the one thing in arc shaped exactly like
 * what Redis is for: a hot, tiny, monotonic integer per (actor, period, kind).
 *
 * One hash per `(actor, period)`, one field per `kind`:
 *
 *   arc:usage:org-42:2026-07  →  { 'api.requests': 40231, 'ai.tokens.input': 88 }
 *
 * `HINCRBY` is atomic server-side, so concurrent replicas never lose counts —
 * the property the whole contract rests on. `HGETALL` returns the summary in
 * one round trip.
 *
 * Peer-dep-free by design: the client is taken structurally as
 * {@link UsageRedisLike}, so this file imports nothing and `@classytic/arc`
 * never gains an `ioredis` dependency. Assignability from a real ioredis
 * `Redis` is pinned in `tests/types/ioredis-assignability.test.ts`.
 *
 * @example
 * ```ts
 * import { usagePlugin, RedisUsageStore } from '@classytic/arc/usage';
 * import Redis from 'ioredis';
 *
 * await app.register(usagePlugin, {
 *   store: new RedisUsageStore({ redis: new Redis(process.env.REDIS_URL) }),
 * });
 * ```
 */

import type { UsageBucket, UsageStore } from "./interface.js";

/**
 * The three commands this store needs. Fixed arity with an `unknown[]` tail
 * where ioredis overloads one — see the note in `idempotency/stores/redis.ts`
 * for why a narrower tail makes a real `Redis` unassignable.
 */
export interface UsageRedisLike {
  hincrby(key: string, field: string, increment: number): Promise<number>;
  hgetall(key: string): Promise<Record<string, string>>;
  expire(key: string, seconds: number, ...args: unknown[]): Promise<number>;
  /**
   * Optional. When present, a retention-enabled increment sends `HINCRBY` and
   * `EXPIRE` as ONE round trip instead of two. ioredis has it; a minimal
   * wrapper may not, and the store falls back to two sequential calls.
   */
  pipeline?(): {
    hincrby(key: string, field: string, increment: number): unknown;
    expire(key: string, seconds: number): unknown;
    exec(): Promise<unknown>;
  };
}

export interface RedisUsageStoreOptions {
  /** Redis client (ioredis or compatible). */
  redis: UsageRedisLike;
  /**
   * Key prefix (default: `'arc:usage:'`).
   *
   * Keys are `{prefix}{actor}:{period}`. `usagePeriod()` never emits a `:`,
   * so the split is unambiguous for every canonical period; a host that
   * passes its own period key should keep `:` out of it.
   */
  prefix?: string;
  /**
   * Seconds a bucket survives after its LAST write, or `undefined` (the
   * default) to keep counters forever.
   *
   * The default is deliberate and it is not the usual Redis default. These
   * counters are what quota decisions and invoices are computed from —
   * expiring them by default would delete billing history on a schedule
   * nobody chose, and the loss is silent because `summary()` answers `{}` for
   * a bucket that never existed and one that expired alike. Set it once you
   * know your retention window (e.g. `86400 * 400` to keep a year plus a
   * grace period), and only if the counters here are not your system of
   * record.
   */
  retentionSeconds?: number;
}

/** Period-bucketed usage counters in Redis hashes. See the module header. */
export class RedisUsageStore implements UsageStore {
  readonly name = "redis";
  readonly #redis: UsageRedisLike;
  readonly #prefix: string;
  readonly #retentionSeconds: number | undefined;

  constructor(options: RedisUsageStoreOptions) {
    this.#redis = options.redis;
    this.#prefix = options.prefix ?? "arc:usage:";
    const retention = options.retentionSeconds;
    // A zero or negative TTL means "delete immediately" to Redis, which would
    // silently discard every counter written. Refuse at construction rather
    // than at the first invoice.
    if (retention !== undefined && (!Number.isFinite(retention) || retention <= 0)) {
      throw new Error(
        `[arc-usage] RedisUsageStore: retentionSeconds must be a positive number, got ${String(retention)}. Omit it to keep counters forever.`,
      );
    }
    this.#retentionSeconds = retention;
  }

  #key(actor: string, period: string): string {
    return `${this.#prefix}${actor}:${period}`;
  }

  async increment(bucket: UsageBucket, amount: number): Promise<void> {
    const key = this.#key(bucket.actor, bucket.period);
    const ttl = this.#retentionSeconds;

    if (ttl === undefined) {
      await this.#redis.hincrby(key, bucket.kind, amount);
      return;
    }

    // Refresh the TTL on EVERY write, not just the first: a monthly bucket is
    // written all month, and a TTL set once at creation would expire the
    // bucket while it is still being counted into.
    const pipeline = this.#redis.pipeline?.();
    if (pipeline) {
      pipeline.hincrby(key, bucket.kind, amount);
      pipeline.expire(key, ttl);
      await pipeline.exec();
      return;
    }
    await this.#redis.hincrby(key, bucket.kind, amount);
    await this.#redis.expire(key, ttl);
  }

  async summary(actor: string, period: string): Promise<Record<string, number>> {
    const raw = await this.#redis.hgetall(this.#key(actor, period));
    const out: Record<string, number> = {};
    // `HGETALL` on a missing key is `{}`, which is the contract's answer for an
    // unknown actor/period — no special case needed.
    for (const [kind, value] of Object.entries(raw ?? {})) {
      const n = Number(value);
      // A non-numeric field means something else wrote to this key. Skip it
      // rather than reporting `NaN` into a quota comparison, where `NaN > max`
      // is `false` and the quota silently stops enforcing.
      if (Number.isFinite(n)) out[kind] = n;
    }
    return out;
  }
}
