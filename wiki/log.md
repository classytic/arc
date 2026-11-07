# Wiki Log

Recent decisions only — a **recency signal, not an archive**. This file loads into context, so it stays small: one line per entry (≤150 chars), ~10 entries max, oldest dropped when it grows.

Full history: `git log -- wiki/` · release detail: [changelog/v2.md](../changelog/v2.md) · current contracts: the wiki page itself.

---
- 2026-11-07 - auth - `./auth/social`: env presets, verified Google id token, `socialAuth()` bearer handoff + One Tap nonce. wiki/auth.md.
- 2026-11-06 — auth — opt-in sensitive-session routes (`sensitivePaths`, `requireSensitiveSession`); better-auth peer floor stays >=1.7.15. wiki/auth.md.
- 2026-11-05 — auth — Better Auth catch-all: GET/POST + plugin-declared verbs (no all()); URL keeps port; `x-arc-client-ip`; devDeps 1.7.18.
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