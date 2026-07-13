# Plugins

**Summary**: Built-in Fastify plugins that augment arc apps. All opt-in via `createApp({ plugins })` except a few that auto-register.
**Sources**: src/plugins/.
**Last updated**: 2026-07-13 (`schedulesPlugin` — 2.21).

---

## Built-ins

| Plugin | Purpose |
|---|---|
| `health` | `/healthz` liveness, `/readyz` readiness |
| `tracing` | OpenTelemetry (lazy-loads `@opentelemetry/api`) |
| `requestId` | X-Request-Id header propagation |
| `response-cache` | Full-response caching; pairs with [[cache]] |
| `versioning` | API versioning via `Accept-Version` |
| `rate-limit` | Per-scope rate limiting |
| `metrics` | Prometheus/OTel metric emission |
| `sse` | Server-Sent Events transport |
| `gracefulShutdown` | Drains connections on SIGTERM |
| `schedules` | Recurring in-process jobs (2.21) — see below |

Also: `audit`, `idempotency`, `organization`, `mcp`, `jobs` (all in separate modules).

## `schedulesPlugin` (2.21) — recurring jobs without Redis

Interval-based (`every` ms) job loop with optional multi-replica leader safety via any ecosystem `LockAdapter` (`@classytic/mongokit/lock`, sqlitekit, repo-core memory). No overlap by construction (timeout chain, next tick after run settles); fail-open per tick (throwing handler logged, loop survives); lease deliberately NOT released after a run so other replicas skip the same window; timers unref'd + cleared on close with in-flight runs awaited. `fastify.getScheduleStats()` exposes runs/failures/skippedByLock. Deliberately NOT cron-expression-based — calendar semantics belong to the BullMQ `jobs` integration. Replaces the hand-rolled cron registry + mongo lock layer production hosts grow.

## The onSend race rule (v2.10.2)

**Plugins set response headers at `onRequest` or `preSerialization`, never `onSend`.**

Why: async `onSend` hooks race with Fastify's `onSendEnd → safeWriteHead` flush path and produce `ERR_HTTP_HEADERS_SENT` under slow responses.

- **`onRequest`** — when header is derivable from request (requestId, versioning).
- **`preSerialization`** — when payload is needed (caching, response-cache, idempotency).
- `isReplyCommitted()` in [src/utils/reply-guards.ts](../src/utils/reply-guards.ts) remains for third-party plugin authors; arc's own plugins no longer need it.

Fixed across 5 plugins in v2.9.2, fully swept in v2.10.3. See [[gotchas]] #15.

## Plugin registration returns `routes` (v2.9)

`PluginResourceResult.additionalRoutes` was removed. Plugins that add routes return `routes: RouteDefinition[]`. See [[removed]].

## Authoring

1. `src/plugins/myPlugin.ts`, use `createPlugin()` helper.
2. Register in `src/factory/` if auto-load.
3. Tests in `tests/plugins/my-plugin.test.ts`.

## Related
- [[factory]] — plugin ordering
- [[gotchas]] — onSend race (#15)
- [[cache]] — response-cache plugin
