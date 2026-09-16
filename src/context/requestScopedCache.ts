/**
 * A cache whose lifetime is ONE REQUEST.
 *
 * Several collaborators in one request read the same document and none can
 * amortise it, because no layer sees the whole request. A process-lifetime
 * cache is the wrong fix — it serves one request's data to the next. Scoping
 * to the request makes staleness impossible by construction instead of by
 * tuning a TTL.
 *
 * Outside a request `requestScopedCache()` returns `undefined` (cron, CLI,
 * boot, tests) and repo-core reads through. Falling back to a process-wide
 * store there would be the cross-request leak this prevents — and invisible,
 * since every call still returns a plausible value.
 *
 * Since 2.40 a "scope" is any unit of work — a request, an event dispatch, or
 * a job run — so the store is bounded by entry count, not only by the scope
 * ending. See the adapter's note below.
 *
 * The seam is a resolver so neither package learns the other's vocabulary:
 * repo-core owns "how to cache a repository read", arc owns "what is a
 * request".
 *
 * @example
 * ```ts
 * new Repository(OrderModel, [
 *   cachePlugin({ adapter: () => requestScopedCache() }),
 * ]);
 * ```
 */

import type { CacheAdapter } from "@classytic/repo-core/cache";
import { requestContext } from "./requestContext.js";
import { scopedValue } from "./workScope.js";

/** The memo slot the per-scope store hangs off. */
const SLOT = Symbol.for("arc.requestScopedCache");

/**
 * Entry cap for one scope's cache. A request touching this many distinct keys
 * is already pathological; a JOB RUN reaching it is ordinary, and that is the
 * case this exists for (see the eviction note below).
 */
const MAX_ENTRIES = 10_000;

/**
 * A `Map`-backed `CacheAdapter` with NO TTL and LRU eviction above
 * {@link MAX_ENTRIES}.
 *
 * TTL is accepted and ignored because repo-core stamps freshness INTO the
 * envelope and re-checks on read — honouring it here too would put two clocks
 * on one question.
 *
 * Eviction is newer than the rest of this file and the reason is worth
 * keeping. Unbounded was correct while a scope meant an HTTP REQUEST: the
 * store is unreachable once that async context ends, so it was garbage in
 * milliseconds and bounded by what one request touched, and an LRU would have
 * guarded a lifetime that could not occur. 2.40 extended scopes to job runs
 * and event dispatches — and `schedulesPlugin` wraps the WHOLE handler in one
 * scope, so a nightly job sweeping a million rows holds a single cache for the
 * duration. That is now a lifetime that occurs, and the old premise no longer
 * holds. Evicting is always safe here: this is a cache, so the worst a miss
 * costs is the re-read it was avoiding.
 */
function createRequestCacheAdapter(): CacheAdapter {
  const map = new Map<string, unknown>();
  return {
    // eslint-disable-next-line @typescript-eslint/require-await -- contract is async; a Map is not
    async get(key: string): Promise<unknown> {
      if (!map.has(key)) return undefined;
      // Re-insert so `Map`'s insertion order is recency order, which is what
      // makes the eviction below LRU rather than "oldest written".
      const value = map.get(key);
      map.delete(key);
      map.set(key, value);
      return value;
    },
    async set(key: string, value: unknown, _ttlSeconds?: number): Promise<void> {
      // Delete first so an overwrite counts as a fresh use, not a stale slot.
      map.delete(key);
      map.set(key, value);
      if (map.size > MAX_ENTRIES) {
        const oldest = map.keys().next();
        if (!oldest.done) map.delete(oldest.value);
      }
    },
    // `delete`, not `del` — repo-core's contract names it after `Map.delete`
    // and arc's own `RepositoryLike.delete`; Redis clients translate.
    async delete(key: string): Promise<void> {
      map.delete(key);
    },
    /**
     * Ignores the pattern and wipes the whole store. Over-invalidating within
     * one request costs at most a re-read; pattern matching is complexity a
     * store that dies in milliseconds does not earn.
     */
    async clear(_pattern?: string): Promise<void> {
      map.clear();
    },
  };
}

/**
 * The cache for the CURRENT unit of work — a request, an event dispatch or a
 * job run (see `runWorkScope`) — or `undefined` outside one.
 *
 * Lazily created on first use, so a scope that never touches a cached
 * repository allocates nothing.
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
