# Production: health, request id, metrics, tracing

`createApp` registers request id, health and graceful shutdown by default; metrics and versioning are opt-in under `arcPlugins`.

## Health

```typescript
const app = await createApp({
  arcPlugins: {
    health: {
      prefix: '/_health',
      version: '1.0.0',
      checks: [
        { name: 'mongo', check: () => mongoose.connection.readyState === 1 },
        { name: 'redis', check: async () => (await redis.ping()) === 'PONG', timeout: 3000 },
        { name: 'search', check: async () => search.isReady(), critical: false },
      ],
    },
  },
});
```

Manual: `fastify.register(healthPlugin, opts)` from `@classytic/arc/plugins`; `checks` run with an `AbortSignal`.

| Route | Response |
|---|---|
| `GET /_health` and `/_health/live` | 200 `{ status: 'ok', timestamp, version? }` |
| `GET /_health/ready` | 200 `{ status: 'ready', timestamp, checks: [{ name, healthy, duration }] }`; error text goes to the log only |
| ready, critical check failed | 503 `status: 'not_ready'` |
| ready, shutdown draining | 503 `status: 'draining'` (liveness stays 200) |

- `critical` defaults to true; only critical failures return 503.
- Health-check names must be unique across the app (duplicates throw at boot).
- Modules contribute checks with `defineModule({ healthChecks })` (static; resolve deps lazily inside `check`).
- At ready, every check runs once and one `[arc] boot health: N/M passing ...` line is logged; never fatal. Under `production` with no critical check, the line says so.
- Import `HealthCheck` from `@classytic/arc/plugins`.
- `metrics: true` adds `/_health/metrics` with process metrics; `metricsCollector` replaces the body.

## Request id

```typescript
import { requestIdPlugin } from '@classytic/arc/plugins';
await fastify.register(requestIdPlugin, { header: 'x-request-id', setResponseHeader: true, generator: () => crypto.randomUUID() });
```

Incoming ids are sanitized (max 128 chars, safe charset; repeated headers rejected). The id is echoed on the response and carried in logs.

## Metrics

```typescript
const app = await createApp({ arcPlugins: { metrics: { path: '/_metrics', prefix: 'arc', maxSeries: 1000, onCollect: (m) => pushToOtlp(m) } } });
// GET /_metrics: Prometheus text
```

| Series (prefix `arc`) | Type |
|---|---|
| `arc_http_requests_total`, `arc_http_request_duration_seconds` | HTTP by method, route, status |
| `arc_crud_operations_total`, `arc_crud_operation_duration_seconds` | CRUD |
| `arc_cache_hits_total`, `arc_cache_misses_total` | cache |
| `arc_events_published_total`, `arc_events_consumed_total` | events |
| `arc_circuit_breaker_state` | breakers |

Programmatic: `fastify.metrics.recordOperation(resource, op, status, durationMs)`, `.recordCacheHit(resource)`, `.recordEventPublish(type)`, `.collect()`, `.reset()`. `maxSeries` bounds label cardinality per metric.

## Tracing (OpenTelemetry)

Explicit opt-in, OpenTelemetry JS SDK 3.x. Core (else a no-op with one warning, `isTracingAvailable()` false):

```bash
npm i @opentelemetry/api@^1.10.0 @opentelemetry/sdk-trace@^3.1.1 @opentelemetry/resources@^3.1.1 @opentelemetry/semantic-conventions@^1.45.0
npm i @opentelemetry/exporter-trace-otlp-http@^0.301.2 @opentelemetry/context-async-hooks@^3.1.1   # export + async context
```

Each other package loads on its own and is named once when missing: the OTLP exporter (warn: spans not exported), `context-async-hooks` (warn: request span not active across `await`), `@opentelemetry/core` (warn: incoming `traceparent` not joined; installed with the SDK), instrumentations `auto-instrumentations-node`, else `instrumentation-http` / `instrumentation-mongodb` (debug). A tracer provider, context manager or propagator the host registered first (e.g. `NodeSDK`) is kept and used.

Request spans are named `{METHOD} {route template}` (`GET /products/:id`), or `{METHOD}` when no route matched; never the raw URL. Attributes are the stable semantic-convention constants: `http.request.method`, `http.route`, `http.response.status_code`, `url.path`, `url.scheme`, `server.address`, `user_agent.original`, and `error.type` on 5xx. The query string is not recorded (it can carry tokens). `traced()` sets `db.operation.name`.

```typescript
import { tracingPlugin, createSpan, traced } from '@classytic/arc/plugins/tracing';

await fastify.register(tracingPlugin, {
  serviceName: 'my-api',
  exporterUrl: 'http://localhost:4318/v1/traces',   // default
  sampleRate: 0.1,                                   // default 1.0
  autoInstrumentation: true,
});

// Custom span; span is null when tracing is off
return createSpan(req, 'processPayment', async (span) => {
  span?.setAttribute('orderId', order.id);
  return processPayment(order);
});
```

`traced(spanName?)` decorates a method that receives the request as an argument. Use `getTraceHeaders` from `@classytic/arc/context` to propagate trace context into outbox rows.
