/**
 * Usage store contract — period-bucketed counters per actor.
 *
 * CANONICAL HOME: `@classytic/repo-core/usage` (>=0.10) owns this
 * contract for the ecosystem — kits implement it there without ever
 * depending on arc (`@classytic/mongokit/usage`, ...). This file is a
 * deliberate STRUCTURAL MIRROR of that shape — same trick as
 * `ScheduleLockLike` vs repo-core's `LockAdapter` — so arc's emitted
 * declarations carry no repo-core@>=0.10 subpath reference and the
 * peer floor stays honest. Any conforming adapter assigns directly.
 *
 * The deliberately tiny surface (one increment, one read) is what makes
 * every backend trivial: memory (dev/tests), Redis (`HINCRBY`), or any kit
 * (Mongo `$inc` upsert) implements it in a handful of lines. Aggregation
 * happens IN the store — arc never buffers counters in process memory
 * beyond the built-in memory store, so multi-replica deployments stay
 * correct as long as the store is shared.
 *
 * This is the HORIZONTAL usage layer (per-actor, per-period platform
 * accounting for quotas/plans/billing). Itemized vertical records — e.g.
 * `@classytic/arc-ai/usage`'s per-run AI token/cost tracking — keep their
 * own richer stores and can sink into this one (`kind: 'ai.tokens'`).
 */

/** One counter cell: (actor, period, kind). */
export interface UsageBucket {
  /** Who consumed — org / user / client id, or an IP-derived fallback. */
  actor: string;
  /** Aggregation period, `YYYY-MM` (see `usagePeriod()`). */
  period: string;
  /** Namespaced counter, dot-separated: `api.requests`, `ai.tokens`, `storage.bytes`. */
  kind: string;
}

export interface UsageStore {
  /** Store name for diagnostics (e.g. 'memory', 'redis', 'mongo'). */
  readonly name: string;
  /** Add `amount` to the bucket's counter, creating it at 0 first. MUST be atomic per bucket. */
  increment(bucket: UsageBucket, amount: number): Promise<void> | void;
  /** Every counter for an actor in a period: `{ 'api.requests': 40231, ... }`. */
  summary(actor: string, period: string): Promise<Record<string, number>>;
  /** Optional cleanup hook (connections, timers). */
  close?(): Promise<void>;
}

/**
 * Canonical period key for a date — calendar month, UTC: `2026-07`.
 * Monthly is the billing-native granularity; stores that want finer
 * windows can shard internally without changing the contract.
 */
export function usagePeriod(date: Date = new Date()): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}
