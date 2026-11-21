# Wiki Log

Recent decisions only — a **recency signal, not an archive**. This file loads into context, so it stays small: one line per entry (≤150 chars), ~10 entries max, oldest dropped when it grows.

Full history: `git log -- wiki/` · release detail: [changelog/v2.md](../changelog/v2.md) · current contracts: the wiki page itself.

---
- 2026-11-21 — presets — preset routes never public by omission; multiTenant guards preset + custom handler routes. wiki/presets.md.
- 2026-11-21 — presets — `routes(permissions, controller)`; arc presets use function handlers; host preset string dispatch warns. wiki/presets.md.
- 2026-11-21 — factory, core, permissions — 2.53: per-user rate key, `ArcBootError`, module invariants, strict ungated reads, warn-once deprecations.
- 2026-11-21 — plugins — ⚠ tracing on OTel SDK 3.x only (`sdk-trace` TracerProvider, semconv constants); peers raised. wiki/peer-deps.md.
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