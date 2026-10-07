/**
 * A cache whose lifetime is ONE unit of work — a request, an event dispatch or
 * a job run. Scoping to the unit makes cross-request staleness impossible by
 * construction instead of by tuning a TTL.
 *
 * Outside a scope `requestScopedCache()` returns `undefined` and repo-core
 * reads through. Never fall back to a process-wide store there: that is the
 * cross-request leak this prevents, and it would be invisible.
 *
 * The seam is a resolver so repo-core owns "how to cache a read" and arc owns
 * "what is a request", with neither learning the other's vocabulary.
 *
 * @example
 * ```ts
 * new Repository(OrderModel, [
 *   cachePlugin({ adapter: () => requestScopedCache() }),
 * ]);
 * ```
 */

import type { CacheAdapter } from "@classytic/repo-core/cache";
import { evictToSize, touch } from "../collections/boundedMap.js";
import { requestContext } from "./requestContext.js";
import { scopedValue } from "./workScope.js";

/** The memo slot the per-scope store hangs off. */
const SLOT = Symbol.for("arc.requestScopedCache");

/** Entry cap for one scope's cache — sized for long job runs, not requests. */
const MAX_ENTRIES = 10_000;

/**
 * A `Map`-backed `CacheAdapter` with NO TTL and LRU eviction above
 * {@link MAX_ENTRIES}.
 *
 * TTL is ignored: repo-core stamps freshness INTO the envelope and re-checks
 * on read, so honouring it here would put two clocks on one question.
 *
 * The cap matters because `schedulesPlugin` wraps a WHOLE job handler in one
 * scope, so a long sweep holds a single cache throughout. Evicting is always
 * safe — a miss costs only the re-read it was avoiding.
 */
function createRequestCacheAdapter(): CacheAdapter {
  const map = new Map<string, unknown>();
  return {
    async get(key: string): Promise<unknown> {
      if (!map.has(key)) return undefined;
      // Re-insert so insertion order is recency order (LRU, not FIFO).
      const value = map.get(key);
      touch(map, key, value);
      return value;
    },
    async set(key: string, value: unknown, _ttlSeconds?: number): Promise<void> {
      // An overwrite counts as a fresh use, not a stale slot.
      touch(map, key, value);
      evictToSize(map, MAX_ENTRIES);
    },
    // `delete`, not `del` — repo-core's contract name.
    async delete(key: string): Promise<void> {
      map.delete(key);
    },
    /**
     * Ignores the pattern and wipes the whole store — over-invalidating a
     * short-lived store costs at most a re-read.
     */
    async clear(_pattern?: string): Promise<void> {
      map.clear();
    },
  };
}

/**
 * The cache for the CURRENT unit of work (see `runWorkScope`), or `undefined`
 * outside one. Lazily created on first use.
 */
export function requestScopedCache(): CacheAdapter | undefined {
  return scopedValue(SLOT, createRequestCacheAdapter);
}

/**
 * Whether the current scope has allocated a cache yet. Diagnostics and
 * tests only — never branch application behaviour on this.
 */
export function hasRequestScopedCache(): boolean {
  const store = requestContext.get() as unknown as Record<symbol, unknown> | undefined;
  return store?.[SLOT] !== undefined;
}
