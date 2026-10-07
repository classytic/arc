# Wiki Log

Recent decisions only — a **recency signal, not an archive**. This file loads into context, so it stays small: one line per entry (≤150 chars), ~10 entries max, oldest dropped when it grows.

Full history: `git log -- wiki/` · release detail: [changelog/v2.md](../changelog/v2.md) · current contracts: the wiki page itself.

---
- 2026-09-30 — surface — ⚠ clean break: `*PluginFn`, `./sync`, kernel plumbing removed; forgotten-exports absolute at 0; type-only barrels now gated. changelog/v2.md#2420.
- 2026-09-30 — factory, cache — off means never imported (`LazyBridge`); `beforeBoot` disposer; cache limits hold on every path. changelog/v2.md#2420.
- 2026-09-23 — core, plugins — tenancy decided ONCE (`core/tenancy.ts`); 7 layers had re-derived it. Fixed on the way: SSE cross-tenant default, bulk writes ignoring an admin's org. changelog/v2.md#2420.
- 2026-09-14 — utils — `CircuitBreaker` sharedState: cluster failure window (`RedisCircuitBreakerState`) — 50 pods no longer each absorb the full threshold. Shares the SIGNAL, not the state machine; failure path never awaits it. changelog/v2.md#2410.
- 2026-09-14 — factory, plugins — ⚠ schedules without a `lock` FAIL a distributed boot (was a warn; an external audit read the warn as a guarantee). Escape: `singleReplica: true`, same idiom as `eventPlugin singleProcess`. changelog/v2.md#2410.
- 2026-09-13 — usage, context — the audit may only name what arc can fix: `RedisUsageStore` ships (HINCRBY, opt-in retention), both stores run repo-core's `runUsageStoreContract`. Scope cache LRU-bounded — a job run is not "garbage in milliseconds". changelog/v2.md#2410.
- 2026-09-12 — context, events, factory — a scope must not outlive its unit of work: `setImmediate` keeps the caller's ALS store, so `requestDrain` ran the whole relay pass under the nudging request; capability declarations from an encapsulated child were dropped. changelog/v2.md#2410.
- 2026-09-12 — plugins, factory, delivery-guarantees — lame duck: `/ready` 503 `draining` BEFORE close, `drainDelayMs` window; every arc memory default now declares to the distributed audit; rate-limit `redis:` form accepted. changelog/v2.md#2410.
- 2026-09-07 — mcp, security — ⚠ DNS-rebinding protection: `Host`/`Origin` via the SDK's own validators, default ON under `auth: false` (the loopback shape) and OFF with auth (a real domain's Host isn't localhost). Health exempt for probes. changelog/v2.md#2400.
- 2026-09-07 — audit — ⚠ 7 peer floors raised to the majors arc tests (ioredis/bullmq/jose 6, multipart 10, rate-limit 11, static 10, vitest 4). Websocket async listeners settle via `safeAsync` (host throw was a process crash); `noFloatingPromises`/`noMisusedPromises` on. 76 cargo-cult double-casts stripped. ES2024. changelog/v2.md#2400.
