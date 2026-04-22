# Plugins

**Summary**: Built-in Fastify plugins that augment arc apps. All opt-in via `createApp({ plugins })` except a few that auto-register.
**Sources**: src/plugins/.
**Last updated**: 2026-04-21.

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

Also: `audit`, `idempotency`, `organization`, `mcp`, `jobs` (all in separate modules).

## The onSend race rule (v2.10.2)

**Plugins set response headers at `onRequest` or `preSerialization`, never `onSend`.**

Why: async `onSend` hooks race with Fastify's `onSendEnd → safeWriteHead` flush path and produce `ERR_HTTP_HEADERS_SENT` under slow responses.

- **`onRequest`** — when header is derivable from request (requestId, versioning).
- **`preSerialization`** — when payload is needed (caching, response-cache, idempotency).
- `isReplyCommitted()` in [src/utils/reply-guards.ts](../src/utils/reply-guards.ts) remains for third-party plugin authors; arc's own plugins no longer need it.

Fixed across 5 plugins in v2.9.2, fully swept in v2.10.3. See [[changelog-v2.10]].

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
