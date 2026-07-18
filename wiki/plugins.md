# Plugins

**Summary**: Built-in Fastify plugins that augment arc apps. All opt-in via `createApp({ plugins })` except a few that auto-register.
**Sources**: src/plugins/.
**Last updated**: 2026-07-15 (Fastify best-practices hardening wave — 2.22).

---

## Built-ins

| Plugin | Purpose |
|---|---|
| `health` | `/healthz` liveness, `/readyz` readiness |
| `tracing` | OpenTelemetry (lazy-loads `@opentelemetry/api`) |
| `requestId` | X-Request-Id echo + W3C trace context; id RESOLUTION lives in `genReqId` (2.22) |
| `response-cache` | Full-response caching; pairs with [[cache]] |
| `versioning` | API versioning via `Accept-Version` |
| `rate-limit` | Per-scope rate limiting |
| `metrics` | Prometheus/OTel metric emission |
| `sse` | Server-Sent Events transport |
| `realtime` | Permission-gated per-resource change feed (2.22) — see below |
| `gracefulShutdown` | Drains connections on SIGTERM |
| `schedules` | Recurring in-process jobs (2.21) — see below |
| `usage` | Per-actor per-period usage counters (2.22) — see below |

Also: `audit`, `idempotency`, `organization`, `mcp`, `jobs` (all in separate modules).

## `schedulesPlugin` (2.21) — recurring jobs without Redis

Interval-based (`every` ms) job loop with optional multi-replica leader safety via any ecosystem `LockAdapter` (`@classytic/mongokit/lock`, sqlitekit, repo-core memory). No overlap by construction (timeout chain, next tick after run settles); fail-open per tick (throwing handler logged, loop survives); lease deliberately NOT released after a run so other replicas skip the same window; timers unref'd + cleared on close with in-flight runs awaited. `fastify.getScheduleStats()` exposes runs/failures/skippedByLock. Deliberately NOT cron-expression-based — calendar semantics belong to the BullMQ `jobs` integration. Replaces the hand-rolled cron registry + mongo lock layer production hosts grow.

## `usagePlugin` (2.22) — per-actor usage counters

`@classytic/arc/usage` — per-actor, per-UTC-month counters (the accounting primitive for quotas, plan enforcement, usage-based billing). Decorates `fastify.usage` (`record` / `summary` / `period` / `actorOf`); actor derivation mirrors the tenant rate-limit key chain (org → user → client → `ip:<addr>`). `UsageStore` is a two-method backend contract (`increment`, `summary`) — `MemoryUsageStore` built in, Redis/kit backends are a handful of lines. Auto-tracks `api.requests` (default on) and `api.egress.bytes` (opt-in), with `ignorePaths` defaulting to `/_health*` + `/_metrics*`. Recording is fail-safe: a throwing store never fails a request. Layering: `@classytic/arc-ai/usage` keeps itemized AI-token records + pricing math (vertical); arc/usage is the horizontal per-actor layer arc-ai can sink into (`kind: 'ai.tokens'`). Canonical store contract lives in `@classytic/repo-core/usage` (arc's is a documented structural mirror — no floor bump); kits implement it (`@classytic/mongokit/usage`) and prove parity via `runUsageStoreContract` from `@classytic/repo-core/testing`.

**Enforcement — `requireQuota` (2.22).** The other half: a `PermissionCheck` factory gating any operation on the actor's counters — `requireQuota({ kind: 'ai.tokens', limit })` where `limit` is a number, `false` (unlimited), or a plan-aware sync/async resolver. Denies with a thrown 429 `quota.exceeded` carrying `{ kind, used, limit, period, resetsAt }` (client-renderable). Deliberate semantics: check-then-act (approximate at the concurrent margin), **fail-open** on store errors by default (`onStoreError: 'deny'` → 503 for hard-cost endpoints; contrast `isRevoked`, fail-closed because it's security), LOUD 500 `quota.meter_missing` when `usagePlugin` isn't registered, opt-in `cacheTtlMs` micro-cache. Mnemonic: **plans cap speed, quotas cap volume, usage counts it.**

## Fastify best-practices hardening (2.22)

Plugin-side contracts from the audit (factory-side in [[factory]]; rationale in changelog 2.22):

- **requestId** — id resolution lives in `Fastify({ genReqId })` (Fastify binds `request.log`'s `reqId` before hooks run); the plugin only echoes + propagates trace context. Standalone registration keeps the legacy fallback.
- **errorHandler** — `exposeInternalMessages` (prod default: sanitize the `arc.internal_error` fallback); 4xx cause chains log at `warn`.
- **tracing + arcCore onRequest hooks are callback-style ON PURPOSE** — `context.with(..., done)` / `storage.run(store, done)` wrap the remaining lifecycle; an async hook activates for an empty function. Do not "modernize" to async.
- **Every per-request property is `decorateRequest`'d by its owner** (arcCore policy fields, `__arcCacheTTL`, `_idempotencyFullKey`, BA `user`/`session`) — undeclared writes deopt the request hidden class. New per-request properties MUST add a decoration + `tests/plugins/request-decorators.test.ts`.
- **health** — HTTP metrics use `reply.elapsedTime` (no per-request `_startTime` write).

## `realtimePlugin` (2.22) — permission-aware resource change feed

`GET /realtime/:resource` (`:resource` = the resource NAME, the registry key) streams that resource's `created/updated/deleted` events over SSE — the Supabase-`postgres_changes` answer, built by composing arc's own primitives instead of WAL polling. Gating and filtering reuse the REST machinery exactly: the resource's `list` permission runs at connect (same 401/403 shapes; its row filters snapshot per connection), each event's document is matched against those filters IN PROCESS (adapter `matchesFilter` when the kit supplies one, `simpleEqualityMatcher` for flat equality), org-carrying events only reach matching-org subscribers (unless `tenantField: false`), and `applyFieldReadPermissions` masks every payload with the subscriber's roles. FAIL-CLOSED: operator-shaped filters (`$or`/`$in`, e.g. requireGrant list resolutions) without an adapter matcher reject the subscription at connect (501 `arc.realtime.unfilterable` + fix hint) — never unfiltered delivery. Enable via `arcPlugins: { realtime: true }` (or `{ path, heartbeat, resources, operations }`). **Multiplexing (Mercure-style):** `GET /realtime?resources=a,b,c` carries N feeds over ONE connection (cap 20) — each resource authorized independently with its OWN filter snapshot (`evaluateAndApplyPermission` accumulation is isolated per resource — pinned by the multiplex test), any denial rejects the whole subscription. Frames carry SSE-standard `id:` (client `lastEventId` dedup) and a `retry:` hint at connect. Deliberate non-goals: no replay/resume (reconnect = refetch the list; use the outbox for guaranteed delivery), no presence/broadcast (`app.events` + sse cover custom channels). Transport mechanics (hijack/CORS-merge/heartbeat/backpressure-destroy) live in `utils/sseStream.ts`, shared with the sse plugin. Pinned by `tests/plugins/realtime.test.ts`.

## Choosing the push channel: realtime vs websocket vs sse

Three server-push surfaces, three jobs — NOT redundant, but pick deliberately:

| Surface | Direction | Authorization granularity | Use when |
|---|---|---|---|
| `realtime` plugin | server→client (SSE) | **Per-subscriber**: list-permission gate + row filters + field masking per event | Live dashboards/lists/detail views of RESOURCES — the default choice for "keep this screen fresh" |
| `integrations/websocket` | **bidirectional** + rooms | Handshake auth + org-room broadcast (its CRUD bridge does NOT row-filter or field-mask per subscriber) | Client→server messages (commands, typing), GeoRoom tracking, push-ref targeting; org-visible resources only on the CRUD bridge |
| `sse` plugin | server→client (SSE) | Pattern + org scoping + custom filter fn | Raw domain-event firehose for internal tools / event debugging |

Rule of thumb: resource data with per-user visibility → `realtime`; interactivity or geo → `websocket`; event plumbing → `sse`. If a resource has row-level permissions, do NOT expose it through the websocket CRUD bridge — that bridge is org-coarse by design.

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
