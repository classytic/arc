# Wiki Log

Recent decisions only — a **recency signal, not an archive**. This file loads into context, so it stays small: one line per entry (≤150 chars), ~10 entries max, oldest dropped when it grows.

Full history: `git log -- wiki/` · release detail: [changelog/v2.md](../changelog/v2.md) · current contracts: the wiki page itself.

---
- 2026-11-01 — events — a capped outbox claim warns `OUTBOX_CLAIM_CAPPED`, `batchSize` follows `claimCap` (G-PLAT-1); inbox `transaction` scope documented.
- 2026-11-01 — events — outbox relay: single-flight passes, lease budget checked before publish, adaptive claim, lease-loss back-off (G-LOAD-2).
- 2026-11-01 — core — route `config.rateLimit` honours `keyGenerator`/`allowList`/`groupId` on arc's limiter; other options refuse. wiki/core.md.
- 2026-10-31 — core, mcp — arc owns the action discriminator (`actionSchemaIR`; `parse: true` re-adds a declared `action`); `routeInput`/`crudInput` `mapIssues`.
- 2026-10-31 — utils, factory, core, events — ⚠ `openSseStream` waits for `drain` (byte/time budget); replay `retry` verdicts; `createApp({ http })`; `CrudInput`; ⚠ CORS `methods` default; `requestDrain({ types })`.
- 2026-10-30 — utils, core, events — `createReplayHub` SSE replay; `writes.update` gets If-Match + `expectedVersion`; `maxPassesPerTick`.
- 2026-10-28 — mcp — ⚠ 2026-07-28 only: 2025 era + stateful mode removed, `ctx.log` server-side, harness speaks 2026. wiki/mcp.md.
- 2026-10-28 — toolchain — tsdown 0.23.3 + TypeScript 7.0.2; the 7.1.0-beta pin and the tsdown/attw overrides are gone.
- 2026-10-23 — core, plugins — `routeInput`/`crudInput`/`parse`, `{ body }` wrapper diagnostic, `schedules daily`, default `arc.not_found` handler. changelog/v2.md.
- 2026-10-17 — plugins — SSE `audience`: keyed delivery via a per-replica connection map; filter still runs on recipients. `sseStats()` gauge. wiki/plugins.md.
- 2026-10-17 — explicit organization headers select request scope and membership; active-session roles cannot cross organizations. wiki/auth.md.
- 2026-10-10 — shared tenant/limit policies, fenced replay, stable inbox identities, ordered runtime drains and bounded histograms. changelog/v2.md.
- 2026-09-30 — surface — ⚠ clean break: `*PluginFn`, `./sync`, kernel plumbing removed; forgotten-exports absolute at 0; type-only barrels now gated. changelog/v2.md#2420.
- 2026-09-30 — factory, cache — off means never imported (`LazyBridge`); `beforeBoot` disposer; cache limits hold on every path. changelog/v2.md#2420.