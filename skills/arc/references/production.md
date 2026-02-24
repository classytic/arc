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

## Response Cache Plugin

```typescript
import { responseCachePlugin } from '@classytic/arc/plugins/response-cache';

await fastify.register(responseCachePlugin, {
  // ETag generation + Cache-Control headers per route
});
```

## SSE Plugin (Server-Sent Events)

```typescript
import { ssePlugin } from '@classytic/arc/plugins';

await fastify.register(ssePlugin);
// Requires eventPlugin to be registered — bridges Arc events to SSE streams
```

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

## Deployment

| Environment | Plugins | Notes |
|-------------|---------|-------|
| Docker/K8s | health + gracefulShutdown + tracing | Full production |
| AWS Lambda | edge preset (no heavy plugins) | Use @fastify/aws-lambda |
| Google Cloud Run | health + gracefulShutdown | Set min-instances > 0 for WebSocket |
| Vercel | edge preset | Serverless functions adapter |
| Railway/Render | production preset | Works with zero config |

**Production checklist:**

```typescript
// Validate env vars at startup
if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) throw new Error('...');

const app = await createApp({
  preset: 'production',
  auth: { jwt: { secret: process.env.JWT_SECRET } },
  cors: { origin: process.env.ALLOWED_ORIGINS?.split(',') ?? [], credentials: true },
  rateLimit: { max: 300, timeWindow: '1 minute' },
});

process.on('SIGTERM', () => app.close());
process.on('SIGINT', () => app.close());
```
