# Wiki Log

Recent decisions only — a **recency signal, not an archive**. This file loads into context, so it stays small: one line per entry (≤150 chars), ~10 entries max, oldest dropped when it grows.

Full history: `git log -- wiki/` · release detail: [changelog/v2.md](../changelog/v2.md) · current contracts: the wiki page itself.

---
- 2026-10-27 — toolchain — TODO when tsdown 0.23.3 is on npm: drop the TS 7.1.0-beta pin and the tsdown + attw overrides (see package.json).
- 2026-10-23 — core, plugins — `routeInput`/`crudInput`/`parse`, `{ body }` wrapper diagnostic, `schedules daily`, default `arc.not_found` handler. changelog/v2.md.
- 2026-10-17 — plugins — SSE `audience`: keyed delivery via a per-replica connection map; filter still runs on recipients. `sseStats()` gauge. wiki/plugins.md.
- 2026-10-17 — explicit organization headers select request scope and membership; active-session roles cannot cross organizations. wiki/auth.md.
- 2026-10-10 — shared tenant/limit policies, fenced replay, stable inbox identities, ordered runtime drains and bounded histograms. changelog/v2.md.
- 2026-09-30 — surface — ⚠ clean break: `*PluginFn`, `./sync`, kernel plumbing removed; forgotten-exports absolute at 0; type-only barrels now gated. changelog/v2.md#2420.
- 2026-09-30 — factory, cache — off means never imported (`LazyBridge`); `beforeBoot` disposer; cache limits hold on every path. changelog/v2.md#2420.
- 2026-09-23 — core, plugins — tenancy decided ONCE (`core/tenancy.ts`); 7 layers had re-derived it. Fixed on the way: SSE cross-tenant default, bulk writes ignoring an admin's org. changelog/v2.md#2420.
- 2026-09-14 — utils — `CircuitBreaker` sharedState: cluster failure window (`RedisCircuitBreakerState`) — 50 pods no longer each absorb the full threshold. Shares the SIGNAL, not the state machine; failure path never awaits it. changelog/v2.md#2410.
- 2026-09-14 — factory, plugins — ⚠ schedules without a `lock` FAIL a distributed boot (was a warn; an external audit read the warn as a guarantee). Escape: `singleReplica: true`, same idiom as `eventPlugin singleProcess`. changelog/v2.md#2410.
