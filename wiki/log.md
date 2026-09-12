# Wiki Log

Recent decisions only — a **recency signal, not an archive**. This file loads into context, so it stays small: one line per entry (≤150 chars), ~10 entries max, oldest dropped when it grows.

Full history: `git log -- wiki/` · release detail: [changelog/v2.md](../changelog/v2.md) · current contracts: the wiki page itself.

---
- 2026-09-12 — plugins, factory, delivery-guarantees — lame duck: `/ready` 503 `draining` BEFORE close, `drainDelayMs` window; every arc memory default now declares to the distributed audit; rate-limit `redis:` form accepted. changelog/v2.md#unreleased.
- 2026-09-07 — mcp, security — ⚠ DNS-rebinding protection: `Host`/`Origin` via the SDK's own validators, default ON under `auth: false` (the loopback shape) and OFF with auth (a real domain's Host isn't localhost). Health exempt for probes. changelog/v2.md#2400.
- 2026-09-07 — audit — ⚠ 7 peer floors raised to the majors arc tests (ioredis/bullmq/jose 6, multipart 10, rate-limit 11, static 10, vitest 4). Websocket async listeners settle via `safeAsync` (host throw was a process crash); `noFloatingPromises`/`noMisusedPromises` on. 76 cargo-cult double-casts stripped. ES2024. changelog/v2.md#2400.
- 2026-09-07 — mcp — ⚠ SDK v2 clean break: `sdk` peer → `server`+`node`(+`client`). v2 publishes no in-memory transport and no `Transport` interface, so `mcp/testing` drives the REAL loopback transport; `connectMcpTestClient` is the one shared connect. changelog/v2.md#2400.
- 2026-09-02 — auth — Better Auth team scope is org-scoped, cross-org-safe, and shared by required/optional auth. changelog/v2.md#2371.
- 2026-08-25 — factory, security — ⚠ `trustProxy` drops `number`: fastify 5.12.1 fails hop-count trust closed (cannot validate the immediate peer → padded XFF spoofs `request.ip`). Name proxies instead; JS hosts get a boot warn.
- 2026-08-23 — events, testing — outbox + audit now JOIN the request transaction by default (`transactionContext` is finally populated by `transactional: true` writes); docs' `eventStrategy` never existed — the real option is `warnOnDuplicate`. Automatic-CRUD-outbox dropped: disclose, don't upgrade.
- 2026-08-23 — testing — `tests/_harness/` (arcApp + fixtures) and `tests/parity/` (`forEachSurface`): HTTP/MCP decisions asserted ONCE, transport as parameter; MCP surface must carry `wiring` or it silently runs hookless. Pooled-mongod experiment measured SLOWER, reverted.
- 2026-08-13 — factory — `createApp({ role })`: api/worker mount no schedule arms, relay mounts only kind:'relay', relay/scheduler+resources boot-fatal. changelog/v2.md#2330.
- 2026-08-13 — factory, delivery-guarantees — runtime capability registry: host-wired memory state now FAILS distributed boot by name (`declareRuntimeCapability`); the wiki checklist is enforcement now. changelog/v2.md#2330.
- 2026-08-13 — events — outbox fencing: token minted IN the claim CAS (`repositoryAsOutboxStore`), stale epoch rejected on ack/fail; relay feature-detects `claimPendingFenced` and threads the token to ack AND fail; LockAdapter + primitives contracts landed same day. changelog/v2.md#2330.
- 2026-08-13 — webhooks — durable delivery = outbox composition: `durable: { store }` enqueues one deterministic row per (event x subscription); `createDurableWebhookModule` relays the signed POST with fencing/DLQ. changelog/v2.md#2330.
- 2026-08-29 — events, factory — `defineEvent` compared JSON Schema `type` to a raw `typeof`: UNION (nullable) and `integer` fields failed for every value they allow. Plugin preflight names all missing packages at once. changelog/v2.md#2360.
