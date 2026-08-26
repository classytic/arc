/**
 * A cache whose lifetime is ONE REQUEST.
 *
 * ## Why this exists
 *
 * A repository read is a network round trip. When several independent
 * collaborators in one request each need the same document — the order handler,
 * the posting handler, the invoice loader — each pays for it again, because no
 * layer sees the whole request and so no layer can amortise it. A measured
 * order placement issued **15 reads of one order document and 9 of one
 * customer**, every one of them a full round trip.
 *
 * A process-lifetime cache is the WRONG fix for that: it would serve one
 * request's order to the next request, which is a correctness bug traded for a
 * latency win. The right lifetime is the request itself — and then staleness
 * is impossible by construction rather than by tuning a TTL.
 *
 * ## The division of labour
 *
 * - **repo-core** owns "how do I cache a repository read" — the key, the
 *   envelope, the invalidation. It accepts a `CacheAdapterResolver` and never
 *   learns what a request is.
 * - **arc** owns "what is a request" — this file. It already runs the
 *   `AsyncLocalStorage` that makes the question answerable.
 *
 * Neither package gains a dependency on the other's vocabulary, which is the
 * whole reason the seam is a resolver and not a flag.
 *
 * ## Outside a request, there is NO cache
 *
 * `requestScopedCache()` returns `undefined` when called outside the ALS —
 * cron jobs, CLI scripts, boot, tests. repo-core treats that as `disabled` and
 * reads straight through. The alternative (lazily creating a process-wide
 * store as a fallback) is exactly the cross-request leak this design exists to
 * prevent, and it would be invisible: every call would still return a
 * plausible value, occasionally someone else's.
 *
 * @example
 * ```ts
 * import { requestScopedCache } from '@classytic/arc/context';
 * import { cachePlugin } from '@classytic/mongokit';
 *
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
 * A `Map`-backed `CacheAdapter` with NO eviction and NO TTL enforcement.
 *
 * Both omissions are deliberate rather than unfinished. The store is
 * unreachable once the request's async context ends, so it is garbage in
 * milliseconds and bounded by what a single request can touch — an LRU here
 * would add bookkeeping to protect against a lifetime that cannot occur.
 *
 * TTL is accepted and ignored for the same reason: repo-core stamps freshness
 * INTO the envelope it stores and re-checks it on read, so expiry is already
 * enforced one layer up. Honouring `ttl` here as well would mean two clocks
 * deciding the same question, and the interesting case — a request outliving
 * its own `staleTime` — is already handled correctly by the envelope.
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
     * `clear` ignores its pattern and wipes the request's whole store.
     *
     * Over-invalidating within one request costs at most a re-read; the
     * pattern-matching a shared store needs is what would have to be
     * CORRECT here, and a store that dies in milliseconds does not earn it.
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
