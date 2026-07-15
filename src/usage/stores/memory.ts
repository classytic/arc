/**
 * In-memory usage store — development, tests, and single-instance apps.
 * Counters are per-process: multi-replica deployments need a shared
 * store (Redis / kit-backed) or every replica reports its own numbers.
 */

import type { UsageBucket, UsageStore } from "./interface.js";

export class MemoryUsageStore implements UsageStore {
  readonly name = "memory";
  /** actor → period → kind → count */
  #counters = new Map<string, Map<string, Map<string, number>>>();

  increment(bucket: UsageBucket, amount: number): void {
    const periods = this.#counters.get(bucket.actor) ?? new Map<string, Map<string, number>>();
    const kinds = periods.get(bucket.period) ?? new Map<string, number>();
    kinds.set(bucket.kind, (kinds.get(bucket.kind) ?? 0) + amount);
    periods.set(bucket.period, kinds);
    this.#counters.set(bucket.actor, periods);
  }

  async summary(actor: string, period: string): Promise<Record<string, number>> {
    const kinds = this.#counters.get(actor)?.get(period);
    return kinds ? Object.fromEntries(kinds) : {};
  }

  /** Test convenience — drop everything. */
  clear(): void {
    this.#counters.clear();
  }
}
