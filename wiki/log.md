# Wiki Log

Recent decisions only — a **recency signal, not an archive**. This file loads into context, so it stays small: one line per entry (≤150 chars), ~10 entries max, oldest dropped when it grows.

Full history: `git log -- wiki/` · release detail: [changelog/v2.md](../changelog/v2.md) · current contracts: the wiki page itself.

---
- 2026-09-14 — utils — `CircuitBreaker` sharedState: cluster failure window (`RedisCircuitBreakerState`) — 50 pods no longer each absorb the full threshold. Shares the SIGNAL, not the state machine; failure path never awaits it. changelog/v2.md#2410.
- 2026-09-14 — factory, plugins — ⚠ schedules without a `lock` FAIL a distributed boot (was a warn; an external audit read the warn as a guarantee). Escape: `singleReplica: true`, same idiom as `eventPlugin singleProcess`. changelog/v2.md#2410.
- 2026-09-13 — usage, context — the audit may only name what arc can fix: `RedisUsageStore` ships (HINCRBY, opt-in retention), both stores run repo-core's `runUsageStoreContract`. Scope cache LRU-bounded — a job run is not "garbage in milliseconds". changelog/v2.md#2410.
- 2026-09-12 — context, events, factory — a scope must not outlive its unit of work: `setImmediate` keeps the caller's ALS store, so `requestDrain` ran the whole relay pass under the nudging request; capability declarations from an encapsulated child were dropped. changelog/v2.md#2410.
- 2026-09-12 — plugins, factory, delivery-guarantees — lame duck: `/ready` 503 `draining` BEFORE close, `drainDelayMs` window; every arc memory default now declares to the distributed audit; rate-limit `redis:` form accepted. changelog/v2.md#2410.
- 2026-09-07 — mcp, security — ⚠ DNS-rebinding protection: `Host`/`Origin` via the SDK's own validators, default ON under `auth: false` (the loopback shape) and OFF with auth (a real domain's Host isn't localhost). Health exempt for probes. changelog/v2.md#2400.
- 2026-09-07 — audit — ⚠ 7 peer floors raised to the majors arc tests (ioredis/bullmq/jose 6, multipart 10, rate-limit 11, static 10, vitest 4). Websocket async listeners settle via `safeAsync` (host throw was a process crash); `noFloatingPromises`/`noMisusedPromises` on. 76 cargo-cult double-casts stripped. ES2024. changelog/v2.md#2400.
- 2026-09-07 — mcp — ⚠ SDK v2 clean break: `sdk` peer → `server`+`node`(+`client`). v2 publishes no in-memory transport and no `Transport` interface, so `mcp/testing` drives the REAL loopback transport; `connectMcpTestClient` is the one shared connect. changelog/v2.md#2400.
- 2026-09-02 — auth — Better Auth team scope is org-scoped, cross-org-safe, and shared by required/optional auth. changelog/v2.md#2371.
- 2026-08-25 — factory, security — ⚠ `trustProxy` drops `number`: fastify 5.12.1 fails hop-count trust closed (cannot validate the immediate peer → padded XFF spoofs `request.ip`). Name proxies instead; JS hosts get a boot warn.
