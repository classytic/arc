# Plugins

**Summary**: Built-in Fastify plugins that augment arc apps. All opt-in via `createApp({ plugins })` except a few that auto-register.
**Sources**: src/plugins/.
**Last updated**: 2026-10-17 (SSE keyed audience routing).

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
| `gracefulShutdown` | Lame duck on SIGTERM: `fastify.shutdownState.draining` flips → `/ready` 503 `draining` → waits `drainDelayMs` (default 0; set > LB deregistration window) → close |
| `schedules` | Recurring in-process jobs (2.21) — see below |
| `usage` | Per-actor per-period usage counters (2.22) — see below |

Also: `audit`, `idempotency`, `organization`, `mcp`, `jobs` (all in separate modules).

## Resource rate limits

A declared HTTP limit refuses boot without `@fastify/rate-limit` registered before resources. Declared resource limits share the host rate-limit plugin store across REST and MCP; explicit custom-route overrides use separate policy buckets. REST returns limit/remaining/reset headers and `Retry-After` on 429. Standalone MCP tools use bounded memory by default and share the anonymous budget when no principal is available; supply a `ResourceRateLimiter` through execution wiring for shared deployments. Capacity pressure refuses new actors rather than clearing active budgets. The MCP runtime declares limiter durability, so a distributed deployment cannot silently use local budgets.

## Metrics

`metricsPlugin` and health duration metrics share a cumulative histogram primitive: `_bucket` (including `+Inf`), `_sum` and `_count`; use `histogram_quantile` for fleet percentiles. Metrics-plugin durations are seconds; health durations remain milliseconds. Route labels use registered templates, with `__unmatched__` for unknown URLs; the metrics endpoint is excluded even with a query string. `maxSeries` bounds each metrics-plugin metric (default 1000) plus one `{overflow="true"}` aggregate, preserving counts when the bound is reached. Labels escape quotes, backslashes and newlines.

## Idempotency completion

HTTP and MCP identities use one canonical operation-scope helper: namespace, operation, principal kind/id, organization, team and custom scope dimensions. Both transports share validated default durations, and MCP inherits the HTTP plugin's configured `ttlMs` and `lockTimeoutMs`. Body fingerprints are separate; reusing a key for a different body is refused. After acquiring a lock, reread completion before executing to close the read/lock handoff race.

Built-in stores fence completion with atomic `setIfLocked(key, requestId, result)`: an expired or replaced owner cannot overwrite a winner's response. HTTP registration and MCP tool wiring refuse custom stores without that capability; `allowUnfencedCompletion: true` is an explicit migration escape that warns. Redis needs `eval`; its response/lock keys share a per-operation Cluster hash tag, and prefix deletion sends separate keys across slots. This protects completion ownership, not the domain effect: an overlong handler can still overlap a takeover, so size leases appropriately or use domain idempotency.

Successful object replies record in `preSerialization`; empty, string and Buffer replies record in `onSend` without setting headers. Buffers use base64 storage plus `bodyEncoding: 'base64'` so JSON-backed stores preserve bytes. The universal `onResponse` hook releases locks. Streaming mutations must use `dedup: 'handler'` with a domain completion record; buffering arbitrary streams is not a supported replay mode. HTTP completion and business effects still have a crash window unless the domain owns their shared transaction or intrinsic deduplication.

The scoped identity and Redis hash-tag key format change prior storage addresses. Deploy a coordinated drain/version transition rather than running old and new instances concurrently against the same mutation traffic. Preserve effect-level uniqueness or reconcile pending retry keys across the transition; blindly replaying legacy records cannot establish their tenant context.

## `schedulesPlugin` (2.21) — recurring jobs without Redis

Interval-based (`every` ms) job loop with optional multi-replica leader safety via any ecosystem `LockAdapter` (`@classytic/mongokit/lock`, sqlitekit, repo-core memory). No overlap by construction (timeout chain, next tick after run settles); fail-open per tick (throwing handler logged, loop survives); lease deliberately NOT released after a run so other replicas skip the same window; timers unref'd + cleared on close with in-flight runs awaited up to `drainTimeoutMs`. All runtime admissions stop before drains and module engine disposal; an over-budget schedule logs abandonment and can continue, so durable callbacks must tolerate restart/retry. `fastify.getScheduleStats()` exposes runs/failures/skippedByLock. Deliberately NOT cron-expression-based — calendar semantics belong to the BullMQ `jobs` integration. Replaces the hand-rolled cron registry + mongo lock layer production hosts grow.

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

`GET /realtime/:resource` (`:resource` = the resource NAME, the registry key) streams that resource's `created/updated/deleted` events over SSE — a per-resource change feed built by composing arc's own primitives (no WAL polling). Gating and filtering reuse the REST machinery exactly: the resource's `list` permission runs at connect (same 401/403 shapes; its row filters snapshot per connection), each event's document is matched against those filters IN PROCESS (adapter `matchesFilter` when the kit supplies one, `simpleEqualityMatcher` for flat equality), org-carrying events only reach matching-org subscribers (unless `tenantField: false`), and `applyFieldReadPermissions` masks every payload with the subscriber's roles. FAIL-CLOSED: operator-shaped filters (`$or`/`$in`, e.g. requireGrant list resolutions) without an adapter matcher reject the subscription at connect (501 `arc.realtime.unfilterable` + fix hint) — never unfiltered delivery. Enable via `arcPlugins: { realtime: true }` (or `{ path, heartbeat, resources, operations }`). **Multiplexing:** `GET /realtime?resources=a,b,c` carries N feeds over ONE connection (cap 20) — each resource authorized independently with its OWN filter snapshot (`evaluateAndApplyPermission` accumulation is isolated per resource — pinned by the multiplex test), any denial rejects the whole subscription. Frames carry SSE-standard `id:` (client `lastEventId` dedup) and a `retry:` hint at connect. Deliberate non-goals: no replay/resume (reconnect = refetch the list; use the outbox for guaranteed delivery), no presence/broadcast (`app.events` + sse cover custom channels). Transport mechanics (hijack/CORS-merge/heartbeat/backpressure-destroy) live in `utils/sseStream.ts`, shared with the sse plugin. Pinned by `tests/plugins/realtime.test.ts`.

## Choosing the push channel: realtime vs websocket vs sse

Three server-push surfaces, three jobs — NOT redundant, but pick deliberately:

| Surface | Direction | Authorization granularity | Use when |
|---|---|---|---|
| `realtime` plugin | server→client (SSE) | **Per-subscriber**: list-permission gate + row filters + field masking per event | Live dashboards/lists/detail views of RESOURCES — the default choice for "keep this screen fresh" |
| `integrations/websocket` | **bidirectional** + rooms | Handshake auth + org-room broadcast (its CRUD bridge does NOT row-filter or field-mask per subscriber) | Client→server messages (commands, typing), GeoRoom tracking, push-ref targeting; org-visible resources only on the CRUD bridge |
| `sse` plugin | server→client (SSE) | Pattern + org scoping + custom filter fn; optional keyed `audience` routing | Raw domain-event firehose for internal tools / event debugging; per-user notifications with `audience` |

Rule of thumb: resource data with per-user visibility → `realtime`; interactivity or geo → `websocket`; event plumbing → `sse`. If a resource has row-level permissions, do NOT expose it through the websocket CRUD bridge — that bridge is org-coarse by design.

## SSE keyed audience

`ssePlugin({ audience })` routes an event to the connections indexed under the keys it returns, instead of running `filter` against every open connection.

- `audience(event) => readonly string[] | null | undefined` — recipient keys. `null`/`undefined` = broadcast: every connection through org-scoping + `filter`, exactly as without the option. A throw or a non-array drops the event (fail-closed, logged).
- `connectionKey(request)` — the key a connection is indexed under; default `getUserId(request.scope)`. A key-less connection (public, service) receives broadcasts only.
- Org-scoping and `filter` still run on every looked-up connection: the audience narrows, it never authorizes. Each payload is serialized once per event.
- With `audience` set the plugin holds ONE shared subscription per pattern (lazily, on the first connection) and an in-process `Map<key, Set<connection>>`. A connection is indexed only after the subscription is live, and a disconnect during that wait never indexes it. Without `audience` the per-connection subscription path is unchanged.
- Multi-replica: every replica receives the event from the transport and resolves keys against its own map; no shared keys.
- `fastify.sseStats()` → `{ connections, keys }`, summed over every `ssePlugin` registration — the connection gauge (the metrics collector has no generic gauge slot).
- Pinned by `tests/plugins/sse-audience.test.ts`; `npm run bench:sse` measures filter-all vs audience.

## The onSend race rule (v2.10.2)

**Plugins set response headers at `onRequest` or `preSerialization`, never `onSend`.**

Why: async `onSend` hooks race with Fastify's `onSendEnd → safeWriteHead` flush path and produce `ERR_HTTP_HEADERS_SENT` under slow responses.

- **`onRequest`** — when header is derivable from request (requestId, versioning).
- **`preSerialization`** — when payload is needed (caching, response-cache, idempotency).
- Arc's own plugins no longer need a reply-committed guard; the former `isReplyCommitted()` helper was removed with the `onSend` paths that needed it. Third-party plugin authors setting headers late should check `reply.sent` themselves.

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
