# Arc Production Features

Health checks, audit trail, idempotency, tracing, SSE, caching, graceful shutdown.

## Health Plugin

Kubernetes-ready liveness/readiness probes:

```typescript
import { healthPlugin } from '@classytic/arc/plugins';

await fastify.register(healthPlugin, {
  prefix: '/_health',
  version: '1.0.0',
  checks: [
    { name: 'mongodb', check: () => mongoose.connection.readyState === 1, critical: true },
    { name: 'redis', check: async () => await redis.ping() === 'PONG', timeout: 3000 },
  ],
});

// GET /_health/live  → { status: 'ok', timestamp, version }
// GET /_health/ready → { status: 'ok', checks: { mongodb: { status: 'ok', latency: 5 } } }
// Returns 503 if critical check fails
```

## Request ID Plugin

```typescript
import { requestIdPlugin } from '@classytic/arc/plugins';

await fastify.register(requestIdPlugin, {
  header: 'x-request-id',
  setResponseHeader: true,
  generator: () => crypto.randomUUID(),
});
```

## Graceful Shutdown Plugin

```typescript
import { gracefulShutdownPlugin } from '@classytic/arc/plugins';

await fastify.register(gracefulShutdownPlugin, {
  timeout: 30000,
  signals: ['SIGTERM', 'SIGINT'],
  logEvents: true,
  onShutdown: async () => {
    await mongoose.disconnect();
    await redis.quit();
  },
});

// Sequence: receive signal → stop accepting connections → wait for in-flight
// → run onShutdown → close Fastify → exit process
```

## Audit Plugin

Change tracking with pluggable storage:

```typescript
import { auditPlugin } from '@classytic/arc/audit';

// Development
await fastify.register(auditPlugin, { enabled: true, stores: ['memory'] });

// Production
await fastify.register(auditPlugin, {
  enabled: true,
  stores: ['mongodb'],
  mongoConnection: mongoose.connection,
  mongoCollection: 'audit_logs',
  ttlDays: 90,     // Auto-cleanup via TTL index
});

// Usage
await fastify.audit.create('product', product._id, product, request.auditContext);
await fastify.audit.update('product', id, beforeDoc, afterDoc, request.auditContext);
await fastify.audit.delete('product', id, deletedDoc, request.auditContext);
await fastify.audit.custom('product', id, 'price_changed', { oldPrice: 100, newPrice: 150 }, ctx);

// Query
const entries = await fastify.audit.query({
  resource: 'product', documentId: 'prod-123',
  action: 'update', from: new Date('2024-01-01'), limit: 100,
});
```

**Audit entry:**

```typescript
interface AuditEntry {
  id: string; timestamp: Date;
  action: 'create' | 'update' | 'delete' | 'restore' | 'custom';
  resource: string; documentId: string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  context: { user?; organizationId?; requestId?; ipAddress?; userAgent?; };
}
```

**Custom store:** Implement `AuditStore` interface (`log`, `query`, `close`).

## Idempotency Plugin

Exactly-once semantics for mutating operations:

```typescript
import { idempotencyPlugin } from '@classytic/arc/idempotency';

await fastify.register(idempotencyPlugin, {
  enabled: true,
  headerName: 'idempotency-key',   // Default
  ttlMs: 86400000,                  // 24 hours
  lockTimeoutMs: 30000,
  methods: ['POST', 'PUT', 'PATCH'],
  include: [/\/orders/],            // Only these routes
  exclude: [/\/health/],
  retryAfterSeconds: 1,
});
```

**Client:**

```typescript
fetch('/api/orders', {
  method: 'POST',
  headers: { 'Idempotency-Key': 'order-abc123-uuid' },
  body: JSON.stringify({ items: [...] }),
});
// First request: processes, caches response
// Retry: returns cached response + x-idempotency-replayed: true
// Concurrent: returns 409 Conflict + Retry-After: 1
```

**Storage backends:**

```typescript
// Memory (default, dev)
import { MemoryIdempotencyStore } from '@classytic/arc/idempotency';

// Redis (production, multi-instance)
import { RedisIdempotencyStore } from '@classytic/arc/idempotency/redis';
store: new RedisIdempotencyStore({ client: redis, prefix: 'idem:', ttlMs: 86400000 })

// MongoDB (production, no Redis)
import { MongoIdempotencyStore } from '@classytic/arc/idempotency/mongodb';
store: new MongoIdempotencyStore({ connection: mongoose.connection, collection: 'arc_idempotency', createIndex: true })
```

**IdempotencyStore interface:**

```typescript
interface IdempotencyStore {
  readonly name: string;
  get(key: string): Promise<IdempotencyResult | undefined>;
  set(key: string, result): Promise<void>;
  tryLock(key: string, requestId: string, ttlMs: number): Promise<boolean>;
  unlock(key: string, requestId: string): Promise<void>;
  isLocked(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
  close?(): Promise<void>;
}
```

## OpenTelemetry Tracing

```typescript
import { tracingPlugin } from '@classytic/arc/plugins/tracing';

await fastify.register(tracingPlugin, {
  serviceName: 'my-api',
  exporterUrl: 'http://localhost:4318/v1/traces',
  sampleRate: 0.1,  // Trace 10% of requests
});

// Custom spans
import { createSpan } from '@classytic/arc/plugins/tracing';

return createSpan(req, 'processPayment', async (span) => {
  span.setAttribute('orderId', order._id);
  return await processPayment(order);
});
```

## QueryCache (Server Cache)

TanStack Query-inspired server cache with stale-while-revalidate and auto-invalidation on mutations.

```typescript
// Enable globally
const app = await createApp({
  arcPlugins: { queryCache: true },  // Memory store, zero config
});

// Per-resource config
defineResource({
  name: 'product',
  cache: {
    staleTime: 30,      // seconds fresh (no revalidation)
    gcTime: 300,         // seconds stale data kept (SWR window)
    tags: ['catalog'],   // cross-resource grouping
    invalidateOn: { 'category.*': ['catalog'] },  // event → tag invalidation
  },
});
```

**How it works:**
- `GET` → cached with `x-cache: HIT | STALE | MISS` header
- `POST/PATCH/DELETE` → auto-bumps resource version, invalidating cached queries
- Cross-resource: category mutation bumps `catalog` tag → products cache invalidated
- Multi-tenant safe: cache keys scoped by userId + orgId

**Runtime modes:**

| Mode | Store | Config |
|------|-------|--------|
| `memory` (default) | `MemoryCacheStore` (50 MiB budget) | Zero config |
| `distributed` | `RedisCacheStore` | `stores: { queryCache: new RedisCacheStore({ client: redis }) }` |

## Response Cache Plugin

```typescript
import { responseCachePlugin } from '@classytic/arc/plugins/response-cache';

await fastify.register(responseCachePlugin, {
  // ETag generation + Cache-Control headers per route
});
```

**Note:** When QueryCache is active for a resource, response-cache is automatically skipped for that resource's GET routes.

## SSE Plugin (Server-Sent Events)

Bridges Arc domain events to SSE streams. Requires `eventPlugin` (auto-registered by factory).

```typescript
// Via factory (recommended)
const app = await createApp({
  arcPlugins: {
    sse: {
      path: '/events/stream',       // SSE endpoint (default: '/events/stream')
      requireAuth: true,            // Fail-closed auth (default: true)
      patterns: ['order.*', 'product.*'],  // Event patterns to stream (default: ['*'])
      orgScoped: false,             // Filter events by org from request.scope (default: false)
      heartbeat: 30000,             // Heartbeat interval in ms (default: 30000)
    },
  },
});

// Manual registration
import { ssePlugin } from '@classytic/arc/plugins';
await fastify.register(ssePlugin, { requireAuth: true, orgScoped: true });
```

**Fail-closed auth:** When `requireAuth: true` (default), throws at registration if `fastify.authenticate` is missing — prevents exposing SSE without auth.

**Org-scoped:** When `orgScoped: true`, events with `organizationId` are only sent to clients whose `request.scope` matches. Prevents cross-tenant leakage.

## Error Handler Plugin

```typescript
import { errorHandlerPlugin } from '@classytic/arc/plugins';

// Global error handling — catches all errors, logs, formats response
// Auto-registered by createApp()
```

## Migrations

```typescript
import { defineMigration, MigrationRunner } from '@classytic/arc/migrations';

const v2 = defineMigration({
  version: 2,
  resource: 'product',
  up: async (db) => {
    await db.collection('products').updateMany({}, { $rename: { oldField: 'newField' } });
  },
  down: async (db) => {
    await db.collection('products').updateMany({}, { $rename: { newField: 'oldField' } });
  },
});

const runner = new MigrationRunner(mongoose.connection.db);
await runner.up([v2]);
```

## Policies

Query-level authorization — modify queries based on user:

```typescript
import { createAccessControlPolicy } from '@classytic/arc/policies';

const editorPolicy = createAccessControlPolicy({
  statements: [
    { resource: 'product', action: ['create', 'update'] },
    { resource: 'order', action: ['read'] },
  ],
});

defineResource({
  permissions: {
    create: editorPolicy,
    update: editorPolicy,
  },
});
```

## OpenAPI & External Paths

Arc auto-generates OpenAPI 3.0 specs from resource definitions. External integrations (auth adapters, custom routes) inject their paths via `ExternalOpenApiPaths`.

```typescript
import type { ExternalOpenApiPaths } from '@classytic/arc/docs';

const externalPaths: ExternalOpenApiPaths = {
  paths: { '/api/auth/sign-in': { post: { summary: 'Sign in', ... } } },
  schemas: { User: { type: 'object', properties: { ... } } },
  securitySchemes: {
    cookieAuth: { type: 'apiKey', in: 'cookie', name: 'session_token' },
  },
  tags: [{ name: 'Authentication' }],
  // Declare additional security alternatives for Arc resource paths
  resourceSecurity: [{ apiKeyAuth: [], orgHeader: [] }],
};
```

**`resourceSecurity`** — declarative registration of auth alternatives for resource paths:
- Each array item is **OR**'d with `bearerAuth` (the default)
- Keys within the same object are **AND**'d (all required together)
- Example: `[{ apiKeyAuth: [], orgHeader: [] }]` → "bearer OR (api-key AND org-header)"

Arc's Better Auth adapter (`extractBetterAuthOpenApi`) auto-populates `resourceSecurity` when the `apiKey()` plugin is detected — no manual configuration needed.

**Security scheme definitions:**

| Scheme | Type | Source | Always present? |
|--------|------|--------|-----------------|
| `bearerAuth` | HTTP Bearer | Arc core | Yes |
| `orgHeader` | API Key (`x-organization-id`) | Arc core | Yes (multi-tenant) |
| `cookieAuth` | API Key (cookie) | Better Auth adapter | When Better Auth active |
| `apiKeyAuth` | API Key (`x-api-key`) | Better Auth adapter | When `apiKey()` plugin active |

## Deployment

Arc requires Node.js APIs (`node:crypto`, `AsyncLocalStorage`). Use `toFetchHandler()` for serverless/edge.

| Environment | Preset | Handler | Notes |
|-------------|--------|---------|-------|
| Docker/K8s | `production` | `app.listen()` | Full production |
| Google Cloud Run | `production` | `app.listen()` | Set min-instances > 0 for WebSocket |
| Railway/Render/Fly.io | `production` | `app.listen()` | Works with zero config |
| AWS Lambda | `edge` | `toFetchHandler()` | Node.js runtime |
| Vercel Serverless | `edge` | `toFetchHandler()` | Node.js runtime |
| Cloudflare Workers | `edge` | `toFetchHandler()` | Enable `nodejs_compat` in wrangler.toml |

**Edge handler:**
```typescript
import { createApp, toFetchHandler } from '@classytic/arc/factory';
const app = await createApp({ preset: 'edge', auth: { type: 'jwt', jwt: { secret } } });
export default { fetch: toFetchHandler(app) };  // Cloudflare Workers / any fetch-based runtime
```

**Production checklist:**

```typescript
// Validate env vars at startup
if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) throw new Error('...');

const app = await createApp({
  preset: 'production',
  auth: { type: 'jwt', jwt: { secret: process.env.JWT_SECRET } },
  cors: { origin: process.env.ALLOWED_ORIGINS?.split(',') ?? [], credentials: true },
  rateLimit: { max: 100, timeWindow: '1 minute' },
  arcPlugins: { queryCache: true },
});

process.on('SIGTERM', () => app.close());
process.on('SIGINT', () => app.close());
```

## Distributed Runtime

`runtime: 'distributed'` only validates stores you actually enable:

- `stores.events` — always required
- `stores.cache` — only when `arcPlugins.caching` enabled
- `stores.queryCache` — only when `arcPlugins.queryCache` enabled
- `stores.idempotency` — never validated (per-resource opt-in)

## Under-Pressure

Production preset: `maxEventLoopDelay: 3000` (avoids false 503s on Render/Railway/Fly.io). Override: `underPressure: { maxEventLoopDelay: 500 }`. Disable: `underPressure: false`.

## CORS

Production warns (not throws) when origin missing. `origin: '*'` from env is allowed. Smart CORS auto-converts `credentials: true` + `origin: '*'` to `origin: true`.

## Metrics Plugin

Prometheus-compatible metrics endpoint — zero external dependencies:

```typescript
import { metricsPlugin } from '@classytic/arc/plugins';

await fastify.register(metricsPlugin, {
  path: '/_metrics',       // default
  prefix: 'arc',           // metric name prefix (default: 'arc')
  onCollect: (metrics) => pushToOTLP(metrics),  // optional OTLP push
});

// GET /_metrics → Prometheus text format
```

**Built-in counters**: `arc_http_requests_total`, `arc_http_request_duration_seconds`, `arc_crud_operations_total`, `arc_cache_hits_total`, `arc_cache_misses_total`, `arc_events_published_total`, `arc_events_consumed_total`, `arc_circuit_breaker_state`.

**Programmatic access**: `fastify.metrics.recordOperation(resource, op, status, durationMs)`, `.recordCacheHit(resource)`, `.recordEventPublish(type)`, `.reset()`.

## API Versioning Plugin

Header-based or URL prefix-based versioning with deprecation warnings:

```typescript
import { versioningPlugin } from '@classytic/arc/plugins';

// Header-based: clients send Accept-Version: 2
await fastify.register(versioningPlugin, {
  type: 'header',
  deprecated: ['1'],
  sunset: '2025-12-01',
});

// Prefix-based: /v2/products
await fastify.register(versioningPlugin, { type: 'prefix' });
```

**Headers set**: `x-api-version` on every response. `Deprecation: true` + `Sunset` for deprecated versions. Access via `request.apiVersion`.

## Per-Tenant Rate Limiting

Scope-aware rate limit key generator — isolates rate limits by org, user, or IP:

```typescript
import { createTenantKeyGenerator } from '@classytic/arc/scope';

const app = await createApp({
  rateLimit: {
    max: 100,
    timeWindow: '1 minute',
    keyGenerator: createTenantKeyGenerator(),
  },
});
```

**Key resolution**: `member` → `organizationId`, `authenticated` → `userId`, `elevated` → `organizationId ?? userId`, `public` → IP. Custom strategy: `createTenantKeyGenerator({ strategy: (ctx) => ctx.ip })`.

## Event Outbox

Transactional outbox pattern — at-least-once delivery even if transport is down:

```typescript
import { EventOutbox, MemoryOutboxStore } from '@classytic/arc/events';

const outbox = new EventOutbox({
  store: new MemoryOutboxStore(),  // or MongoOutboxStore for production
  transport: redisTransport,
});

// In business logic (same DB transaction)
await outbox.store(event);

// Relay cron (runs every few seconds)
const relayed = await outbox.relay();  // publishes pending → transport
```

**OutboxStore interface**: `save(event)`, `getPending(limit)`, `acknowledge(eventId)`.

## RPC Service Client — Schema Versioning

The service client supports a `schemaVersion` option for contract compatibility between services:

```typescript
import { createServiceClient } from '@classytic/arc/rpc';

const catalog = createServiceClient({
  baseUrl: 'http://catalog:3000',
  schemaVersion: '1.2.0',  // sent as x-arc-schema-version header
  correlationId: () => request.id,
  retry: { maxRetries: 2 },
});

const products = await catalog.resource('product').list();
```

Receiving services can check `request.headers['x-arc-schema-version']` to detect version mismatches.

## Bulk Operations Preset

Adds bulk CRUD routes — repository must provide `createMany`, `updateMany`, `deleteMany`:

```typescript
defineResource({
  name: 'product',
  adapter: createMongooseAdapter({ model, repository }),
  presets: ['bulk'],  // adds POST/PATCH/DELETE /{resource}/bulk
});

// Or with options
presets: [bulkPreset({ operations: ['createMany', 'updateMany'], maxCreateItems: 500 })]
```

**Routes**: `POST /bulk` (body: `{ items }`) → `createMany`, `PATCH /bulk` (body: `{ filter, data }`) → `updateMany`, `DELETE /bulk` (body: `{ filter }`) → `deleteMany`. Permissions inherit from `create`/`update`/`delete`.

## Compensating Transaction

In-process rollback primitive — runs steps in order, compensates in reverse on failure.
For distributed sagas across services, use Temporal, Inngest, or Streamline.

```typescript
import { withCompensation } from '@classytic/arc/utils';

const result = await withCompensation('place-order', [
  {
    name: 'reserve-inventory',
    execute: async (ctx) => {
      const res = await inventoryService.reserve(ctx.items);
      ctx.reservationId = res.id;
      return res;
    },
    compensate: async (_ctx, result) => {
      await inventoryService.release(result.id);
    },
  },
  {
    name: 'charge-payment',
    execute: async (ctx) => await paymentService.charge(ctx.total),
    compensate: async (_ctx, result) => await paymentService.refund(result.chargeId),
  },
  {
    name: 'send-confirmation',
    execute: async (ctx) => await emailService.send(ctx.email),
    // No compensate — emails can't be unsent
  },
], { items: cart.items, total: cart.total, email: user.email });

if (!result.success) {
  console.error(`Saga failed at ${result.failedStep}: ${result.error}`);
  // Compensation already ran for completed steps
}
```

**`defineCompensation()`** — reusable definition:

```typescript
const placeOrder = defineCompensation('place-order', steps);
await placeOrder.execute({ items, total, email });
```

**Fire-and-forget steps** — don't block, don't compensate, errors swallowed:

```typescript
await withCompensation('checkout', [
  { name: 'save-order', execute: saveOrder, compensate: cancelOrder },
  { name: 'send-email', execute: sendEmail, fireAndForget: true }, // non-blocking
  { name: 'charge', execute: chargeCard, compensate: refundCard },
]);
// 'charge' runs immediately after 'save-order' — doesn't wait for email
```

**Lifecycle hooks** — wire to Arc events, logging, or metrics:

```typescript
await withCompensation('checkout', steps, { orderId }, {
  onStepComplete: (stepName, result) => {
    fastify.events.publish(`checkout.${stepName}.completed`, result);
  },
  onStepFailed: (stepName, error) => {
    fastify.events.publish(`checkout.${stepName}.failed`, { error: error.message });
  },
  onCompensate: (stepName) => {
    fastify.log.warn(`Compensated: ${stepName}`);
  },
});
```

**In an additionalRoute with Arc auth:**

```typescript
defineResource({
  name: 'order',
  additionalRoutes: [{
    method: 'POST',
    path: '/:id/checkout',
    permissions: requireAuth(),
    wrapHandler: false,
    handler: async (request, reply) => {
      const result = await withCompensation('checkout', steps, { orderId: request.params.id });
      if (!result.success) return reply.code(422).send({ error: result.error });
      return reply.send({ success: true, data: result.results });
    },
  }],
});
```

**Compensation errors**: collected in `result.compensationErrors[]` without stopping rollback. **Context**: mutable `Record<string, unknown>` shared across all steps.

**Scope**: In-process primitive. Process crash = no compensation. For durable distributed workflows, use Temporal, Inngest, or `@classytic/streamline`.
