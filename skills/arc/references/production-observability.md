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
| `GET /_health/ready` | 200 `{ status: 'ready', timestamp, checks: [{ name, healthy, duration, error? }] }` |
| ready, critical check failed | 503 `status: 'not_ready'` |
| ready, shutdown draining | 503 `status: 'draining'` (liveness stays 200) |

- `critical` defaults to true; only critical failures return 503.
- Health-check names must be unique across the app (duplicates throw at boot).
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

Needs `@opentelemetry/api` plus the SDK and OTLP exporter packages; without them tracing is a no-op (`isTracingAvailable()`).

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
