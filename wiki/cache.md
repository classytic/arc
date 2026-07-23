# Cache

**Summary**: `QueryCache` caches list/read responses with scope-aware keys, tag-based invalidation, and optional SWR.
**Sources**: src/cache/.
**Last updated**: 2026-07-22.

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

## Stampede protection (2.24)

- **Single-flight fills** — concurrent misses/stale reads on the SAME key coalesce onto one repo query / one background revalidation (per-instance, in `BaseCrudController`; keys already encode scope + version, so coalescing never crosses tenants).
- **`jitter` (opt-in, 0–1)** — varies each write's effective `staleTime` by ±(jitter × staleTime) so co-cached entries don't expire in the same instant; de-synchronizes ACROSS keys. `0.1` is sane.
- Distributed refresh leases are deliberately NOT here — that lands with the repo-core `CacheEngine` façade (v3.md).

## Plugin: response-cache

Separate from `QueryCache`. Caches full HTTP responses (incl. headers, status) keyed by method + url + scope signature. Set headers at `preSerialization`, never `onSend` — see [[plugins]] and [[gotchas]] #15.

## Related
- [[plugins]] — response-cache plugin
- [[hooks]] — where invalidation fires
- [[request-scope]] — keying input
