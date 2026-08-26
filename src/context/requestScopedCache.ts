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

/**
 * The slot the per-request store hangs off. Underscore-prefixed to sit apart
 * from the fields arc's own hooks populate on `RequestStore`.
 */
const SLOT = "_requestCache";

/**
 * A `Map`-backed `CacheAdapter` with NO eviction and NO TTL — both deliberate.
 *
 * The store is unreachable once the request's async context ends, so it is
 * garbage in milliseconds and bounded by what one request touches; an LRU
 * would guard a lifetime that cannot occur. TTL is accepted and ignored
 * because repo-core stamps freshness INTO the envelope and re-checks on read —
 * honouring it here too would put two clocks on one question.
 */
function createRequestCacheAdapter(): CacheAdapter {
  const map = new Map<string, unknown>();
  return {
    // eslint-disable-next-line @typescript-eslint/require-await -- contract is async; a Map is not
    async get(key: string): Promise<unknown> {
      return map.get(key);
    },
    async set(key: string, value: unknown, _ttlSeconds?: number): Promise<void> {
      map.set(key, value);
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
 * The cache for the CURRENT request, or `undefined` outside one.
 *
 * Lazily created on first use, so a request that never touches a cached
 * repository allocates nothing.
 */
export function requestScopedCache(): CacheAdapter | undefined {
  const store = requestContext.get();
  if (!store) return undefined;
  const existing = store[SLOT] as CacheAdapter | undefined;
  if (existing) return existing;
  const created = createRequestCacheAdapter();
  store[SLOT] = created;
  return created;
}

/**
 * Whether the current request has allocated a cache yet. Diagnostics and
 * tests only — never branch application behaviour on this.
 */
export function hasRequestScopedCache(): boolean {
  return requestContext.get()?.[SLOT] !== undefined;
}
