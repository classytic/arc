# Cache

**Summary**: `QueryCache` caches list/read responses with scope-aware keys, tag-based invalidation, and optional SWR.
**Sources**: src/cache/.
**Last updated**: 2026-04-21.

---

## Stores

- Memory (LRU) — default.
- Redis — `createRedisCacheStore(ioredis)`.
- Implement `CacheStoreLike` for custom backends.

## Scope-aware keys

Cache keys include the [[request-scope]] signature. A `member` of org A and org B get disjoint entries — no accidental cross-tenant reads. Public responses are shared.

## Tags + invalidation

`defineResource({ cache: { tags: ['order'] } })`. After-hooks and events invalidate by tag. Manual: `fastify.queryCache.invalidateByTag('order')`.

## SWR

`cache: { swr: true, staleMs, maxAgeMs }` — serves stale while refetching in background. Not a replacement for the [[events]] outbox; SWR is for read-side latency only.

## Plugin: response-cache

Separate from `QueryCache`. Caches full HTTP responses (incl. headers, status) keyed by method + url + scope signature. Set headers at `preSerialization`, never `onSend` — see [[plugins]] and [[gotchas]] #15.

## Related
- [[plugins]] — response-cache plugin
- [[hooks]] — where invalidation fires
- [[request-scope]] — keying input
