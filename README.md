# @classytic/arc

Database-agnostic resource framework for Fastify. Define resources, get CRUD routes, permissions, presets, caching, events, and OpenAPI — without boilerplate.

**Requires:** Fastify 5+ | Node.js 22+ | ESM only

## Install

```bash
npm install @classytic/arc fastify
npm install @classytic/mongokit mongoose   # MongoDB adapter
```

## Quick Start

```typescript
import mongoose from 'mongoose';
import { createApp } from '@classytic/arc/factory';

await mongoose.connect(process.env.DB_URI);

const app = await createApp({
  preset: 'production',
  auth: { type: 'jwt', jwt: { secret: process.env.JWT_SECRET } },
  cors: { origin: process.env.ALLOWED_ORIGINS?.split(',') },
});

await app.register(productResource.toPlugin());
await app.listen({ port: 8040, host: '0.0.0.0' });
```

## defineResource

Single API for a full REST resource with routes, permissions, and behaviors:

```typescript
import { defineResource, createMongooseAdapter, allowPublic, requireRoles } from '@classytic/arc';

const productResource = defineResource({
  name: 'product',
  adapter: createMongooseAdapter({ model: ProductModel, repository: productRepo }),
  presets: ['softDelete', 'slugLookup', { name: 'multiTenant', tenantField: 'orgId' }],
  permissions: {
    list: allowPublic(),
    get: allowPublic(),
    create: requireRoles(['admin']),
    update: requireRoles(['admin']),
    delete: requireRoles(['admin']),
  },
  cache: { staleTime: 30, gcTime: 300, tags: ['catalog'] }, // QueryCache (opt-in)
  additionalRoutes: [
    { method: 'GET', path: '/featured', handler: 'getFeatured', permissions: allowPublic(), wrapHandler: true },
  ],
});

// Auto-generates: GET /, GET /:id, POST /, PATCH /:id, DELETE /:id
// Plus preset routes: GET /deleted, POST /:id/restore, GET /slug/:slug
```

## Authentication

Auth uses a discriminated union — pick a `type`:

```typescript
// Arc JWT
auth: { type: 'jwt', jwt: { secret: process.env.JWT_SECRET, expiresIn: '15m' } }

// Better Auth (recommended for SaaS with orgs)
import { createBetterAuthAdapter } from '@classytic/arc/auth';
auth: { type: 'betterAuth', betterAuth: createBetterAuthAdapter({ auth, orgContext: true }) }

// Custom plugin
auth: { type: 'custom', plugin: myAuthPlugin }

// Custom function
auth: { type: 'authenticator', authenticate: async (req, reply) => { ... } }

// Disabled
auth: false
```

**Decorates:** `app.authenticate`, `app.optionalAuthenticate`, `app.authorize`

### Token Revocation

Arc provides the `isRevoked` primitive — you implement the store (Redis, DB, Better Auth):

```typescript
auth: {
  type: 'jwt',
  jwt: { secret: process.env.JWT_SECRET },
  isRevoked: async (decoded) => {
    // Redis set, DB lookup, or any async check
    return await redis.sismember('revoked-tokens', decoded.jti ?? decoded.id);
  },
}
```

Fail-closed: if the revocation check throws, the token is rejected.

## Permissions

Function-based, composable:

```typescript
import {
  allowPublic, requireAuth, requireRoles, requireOwnership,
  requireOrgMembership, requireOrgRole, allOf, anyOf, denyAll,
  createDynamicPermissionMatrix,
} from '@classytic/arc';

permissions: {
  list: allowPublic(),
  get: requireAuth(),
  create: requireRoles(['admin', 'editor']),
  update: anyOf(requireOwnership('userId'), requireRoles(['admin'])),
  delete: allOf(requireAuth(), requireRoles(['admin'])),
}
```

**Field-level permissions:**

```typescript
import { fields } from '@classytic/arc';

fields: {
  password: fields.hidden(),
  salary: fields.visibleTo(['admin', 'hr']),
  role: fields.writableBy(['admin']),
  email: fields.redactFor(['viewer'], '***'),
}
```

**Dynamic ACL (DB-managed):**

```typescript
const acl = createDynamicPermissionMatrix({
  resolveRolePermissions: async (ctx) => aclService.getRoleMatrix(orgId),
  cacheStore: new RedisCacheStore({ client: redis, prefix: 'acl:' }),
});

permissions: {
  list: acl.canAction('product', 'read'),
  create: acl.canAction('product', 'create'),
}
```

## Presets

Composable resource behaviors:

| Preset | Effect | Config |
|--------|--------|--------|
| `softDelete` | `GET /deleted`, `POST /:id/restore`, `deletedAt` field | `{ deletedField }` |
| `slugLookup` | `GET /slug/:slug` | `{ slugField }` |
| `tree` | `GET /tree`, `GET /:parent/children` | `{ parentField }` |
| `ownedByUser` | Auto-checks `createdBy` on update/delete | `{ ownerField }` |
| `multiTenant` | Auto-filters all queries by tenant | `{ tenantField }` |
| `audited` | Sets `createdBy`/`updatedBy` from user | — |

```typescript
presets: ['softDelete', { name: 'multiTenant', tenantField: 'organizationId' }]
```

## QueryCache

TanStack Query-inspired server cache with stale-while-revalidate and auto-invalidation:

```typescript
// Enable globally
const app = await createApp({
  arcPlugins: { queryCache: true },  // Memory store by default
});

// Per-resource config
defineResource({
  name: 'product',
  cache: {
    staleTime: 30,    // seconds fresh
    gcTime: 300,      // seconds stale data kept (SWR window)
    tags: ['catalog'],
    invalidateOn: { 'category.*': ['catalog'] }, // cross-resource
  },
});
```

**How it works:**
- `GET` requests: cached with `x-cache: HIT | STALE | MISS` header
- `POST/PATCH/DELETE`: auto-bumps resource version, invalidating all cached queries
- Cross-resource: category mutation bumps `catalog` tag, invalidates product cache
- Multi-tenant safe: cache keys scoped by userId + orgId

**Runtime modes:**

| Mode | Store | Config |
|------|-------|--------|
| `memory` (default) | `MemoryCacheStore` (50 MiB budget) | Zero config |
| `distributed` | `RedisCacheStore` | `stores: { queryCache: new RedisCacheStore({ client: redis }) }` |

## BaseController

Override only what you need:

```typescript
import { BaseController } from '@classytic/arc';
import type { IRequestContext, IControllerResponse } from '@classytic/arc';

class ProductController extends BaseController<Product> {
  constructor() { super(productRepo); }

  async getFeatured(req: IRequestContext): Promise<IControllerResponse> {
    const products = await this.repository.getAll({ filters: { isFeatured: true } });
    return { success: true, data: products };
  }
}
```

## Events

Domain event pub/sub with pluggable transports. The factory auto-registers `eventPlugin` — no manual setup needed:

```typescript
// createApp() registers eventPlugin automatically (default: MemoryEventTransport)
// Transport is sourced from stores.events if provided
const app = await createApp({
  stores: { events: new RedisEventTransport(redis) },  // optional, defaults to memory
  arcPlugins: {
    events: {                     // event plugin config (default: true)
      logEvents: true,
      retry: { maxRetries: 3, backoffMs: 1000 },
    },
  },
});

await app.events.publish('order.created', { orderId: '123' });
await app.events.subscribe('order.*', async (event) => { ... });
```

CRUD events (`product.created`, `product.updated`, `product.deleted`) emit automatically.

### defineEvent — Typed Events with Schema Validation

Declare events with schemas for runtime validation and introspection:

```typescript
import { defineEvent, createEventRegistry } from '@classytic/arc/events';

// Define typed events
const OrderCreated = defineEvent({
  name: 'order.created',
  version: 1,
  description: 'Emitted when an order is placed',
  schema: {
    type: 'object',
    properties: {
      orderId: { type: 'string' },
      total: { type: 'number' },
      currency: { type: 'string' },
    },
    required: ['orderId', 'total'],
  },
});

// Type-safe event creation
const event = OrderCreated.create({ orderId: 'o-1', total: 100 }, { userId: 'user-1' });
await app.events.publish(event.type, event.payload, event.meta);
```

**Event Registry** — catalog + auto-validation on publish:

```typescript
const registry = createEventRegistry();
registry.register(OrderCreated);
registry.register(OrderShipped);

// Wire into eventPlugin — validates payloads on publish
const app = await createApp({
  arcPlugins: {
    events: { registry, validateMode: 'warn' },
    // 'warn' (default): log warning, still publish
    // 'reject': throw error, do NOT publish
    // 'off': registry is introspection-only
  },
});

// Introspect at runtime
app.events.registry?.catalog();
// → [{ name: 'order.created', version: 1, schema: {...} }, ...]
```

Export the registry alongside resources for `arc describe` to auto-detect:

```typescript
// src/events.ts
export const eventRegistry = createEventRegistry();
eventRegistry.register(OrderCreated);
eventRegistry.register(OrderShipped);
```

### Event Transports

| Transport | Import | Use Case |
|-----------|--------|----------|
| `MemoryEventTransport` | `@classytic/arc/events` | Development, testing, single-instance |
| `RedisEventTransport` | `@classytic/arc/events/redis` | Multi-instance pub/sub (fan-out) |
| `RedisStreamTransport` | `@classytic/arc/events/redis-stream` | Ordered events with consumer groups |

```typescript
// Redis Pub/Sub
import { RedisEventTransport } from '@classytic/arc/events/redis';
const transport = new RedisEventTransport(redis, { channel: 'arc-events' });

// Redis Streams (ordered, durable)
import { RedisStreamTransport } from '@classytic/arc/events/redis-stream';
const transport = new RedisStreamTransport(redis, { stream: 'arc-events' });
```

**Behavioral contract:**
- **Memory**: Handlers execute sequentially (ordered, awaited)
- **Redis Pub/Sub**: Handlers fire-and-forget (unordered, fan-out)
- **Redis Streams**: Ordered delivery with consumer group acknowledgment

### Retry & Dead Letter Queue

```typescript
import { withRetry, createDeadLetterPublisher } from '@classytic/arc/events';

// Per-handler retry with exponential backoff
await app.events.subscribe('order.created', withRetry(
  async (event) => { await sendConfirmationEmail(event.payload); },
  {
    maxRetries: 3,
    backoffMs: 1000,
    onDead: createDeadLetterPublisher(app.events), // publishes to $deadLetter channel
  },
));

// Or configure auto-retry for ALL handlers via plugin
const app = await createApp({
  arcPlugins: {
    events: {
      retry: { maxRetries: 3, backoffMs: 1000 },
      deadLetterQueue: { store: async (event, errors) => { /* custom DLQ */ } },
    },
  },
});
```

## Factory — createApp()

```typescript
const app = await createApp({
  preset: 'production',           // production | development | testing | edge
  runtime: 'memory',             // memory (default) | distributed (requires Redis)
  auth: { type: 'jwt', jwt: { secret } },
  cors: { origin: ['https://myapp.com'] },
  helmet: true,                   // false to disable
  rateLimit: { max: 100 },        // false to disable
  arcPlugins: {
    events: true,                 // event plugin (default: true, false to disable)
    emitEvents: true,             // CRUD event emission (default: true)
    queryCache: true,             // server cache (default: false)
    sse: true,                    // server-sent events (default: false)
    caching: true,                // ETag + Cache-Control (default: false)
  },
  stores: {                       // required when runtime: 'distributed'
    events: new RedisEventTransport({ client: redis }),
    cache: new RedisCacheStore({ client: redis }),
    queryCache: new RedisCacheStore({ client: redis, prefix: 'arc:qc:' }),
  },
});
```

**Arc plugins defaults:**

| Plugin | Default | Status |
|--------|---------|--------|
| `events` | `true` | opt-out — registers `eventPlugin` (provides `fastify.events`) |
| `emitEvents` | `true` | opt-out — CRUD operations emit domain events |
| `requestId` | `true` | opt-out |
| `health` | `true` | opt-out |
| `gracefulShutdown` | `true` | opt-out |
| `caching` | `false` | opt-in — ETag + Cache-Control headers |
| `queryCache` | `false` | opt-in — TanStack Query-inspired server cache |
| `sse` | `false` | opt-in — Server-Sent Events streaming |

| Preset | Logging | Rate Limit | Security |
|--------|---------|------------|----------|
| production | info | 100/min | full |
| development | debug | 1000/min | relaxed |
| testing | silent | disabled | minimal |
| edge | warn | disabled | none (API GW handles) |

## Real-Time

SSE and WebSocket with fail-closed auth (throws at registration if auth missing):

```typescript
// SSE — via factory
const app = await createApp({
  arcPlugins: { sse: { path: '/events', requireAuth: true, orgScoped: true } },
});

// WebSocket — separate plugin
import { websocketPlugin } from '@classytic/arc/integrations/websocket';
await app.register(websocketPlugin, {
  auth: true,                       // fail-closed: throws if authenticate not registered
  resources: ['product', 'order'],
  roomPolicy: (client, room) => ['product', 'order'].includes(room),
  reauthInterval: 300000,           // re-validate token every 5 min (0 = disabled)
  maxMessageBytes: 16384,           // 16KB message size cap
  maxSubscriptionsPerClient: 100,   // prevent resource exhaustion
});

// EventGateway — unified SSE + WebSocket with shared config
import { eventGatewayPlugin } from '@classytic/arc/integrations/event-gateway';
await app.register(eventGatewayPlugin, {
  auth: true, orgScoped: true,
  roomPolicy: (client, room) => allowedRooms.includes(room),
  sse: { path: '/api/events', patterns: ['order.*'] },
  ws: { path: '/ws', resources: ['product', 'order'] },
});
```

## Pipeline — Guards, Transforms, Interceptors

Functional composition for cross-cutting concerns:

```typescript
import { pipe, guard, transform, intercept } from '@classytic/arc';

const isActive = guard('isActive', (ctx) => ctx.query?.filters?.isActive !== false);
const slugify = transform('slugify', (ctx) => ({ ...ctx, body: { ...ctx.body, slug: toSlug(ctx.body.name) } }));
const timing = intercept('timing', async (ctx, next) => {
  const start = Date.now();
  const result = await next();
  console.log(`${ctx.resource}.${ctx.operation}: ${Date.now() - start}ms`);
  return result;
});

defineResource({
  name: 'product',
  pipe: pipe(isActive, slugify, timing),
  // or per-operation: pipe: { create: pipe(slugify), list: pipe(timing) }
});
```

## Utilities

```typescript
// Circuit Breaker — fault tolerance for external service calls
import { createCircuitBreaker } from '@classytic/arc/utils';
const paymentBreaker = createCircuitBreaker(
  async (amount) => stripe.charges.create({ amount }),
  { name: 'stripe', failureThreshold: 5, resetTimeout: 30000, fallback: async () => cached },
);

// State Machine — workflow validation
import { createStateMachine } from '@classytic/arc/utils';
const orderState = createStateMachine('Order', {
  approve: ['pending', 'draft'],
  cancel: ['pending', 'approved'],
  fulfill: { from: ['approved'], to: 'fulfilled', guard: ({ data }) => data.paid },
});
orderState.assert('approve', currentStatus); // throws if invalid transition
```

## Integrations

All separate subpath imports — only loaded when used:

```typescript
// Job Queue (BullMQ)
import { jobsPlugin, defineJob } from '@classytic/arc/integrations/jobs';

// WebSocket (room-based, CRUD auto-broadcast)
import { websocketPlugin } from '@classytic/arc/integrations/websocket';

// EventGateway (unified SSE + WebSocket)
import { eventGatewayPlugin } from '@classytic/arc/integrations/event-gateway';

// Streamline Workflows
import { streamlinePlugin } from '@classytic/arc/integrations/streamline';

// Audit Trail
import { auditPlugin } from '@classytic/arc/audit';

// Idempotency (exactly-once mutations)
import { idempotencyPlugin } from '@classytic/arc/idempotency';

// OpenTelemetry Tracing
import { tracingPlugin } from '@classytic/arc/plugins/tracing';
```

## CLI

```bash
npx @classytic/arc init my-api --mongokit --better-auth --ts   # Scaffold project
npx @classytic/arc generate resource product                    # Generate resource files
npx @classytic/arc describe ./dist/index.js                     # Resource metadata (JSON)
npx @classytic/arc docs ./openapi.json --entry ./dist/index.js  # Export OpenAPI
npx @classytic/arc introspect --entry ./dist/index.js           # Show resources
npx @classytic/arc doctor                                        # Health check
```

`arc describe` auto-detects exported `EventRegistry` and includes the event catalog in output:

```json
{
  "$schema": "arc-describe/v1",
  "resources": [...],
  "eventCatalog": [
    { "name": "order.created", "version": 1, "hasSchema": true, "schemaFields": ["orderId", "total"], "requiredFields": ["orderId", "total"] }
  ],
  "stats": { "totalResources": 5, "totalRoutes": 28, "totalCatalogedEvents": 3 }
}
```

## Subpath Imports

| Import | Purpose |
|--------|---------|
| `@classytic/arc` | Core: `defineResource`, `BaseController`, permissions, errors |
| `@classytic/arc/factory` | `createApp()`, presets |
| `@classytic/arc/cache` | `MemoryCacheStore`, `RedisCacheStore`, `QueryCache` |
| `@classytic/arc/auth` | Auth plugin, Better Auth adapter, session manager |
| `@classytic/arc/events` | Event plugin, transports, `defineEvent`, `createEventRegistry` |
| `@classytic/arc/events/redis` | Redis Pub/Sub event transport |
| `@classytic/arc/events/redis-stream` | Redis Streams event transport |
| `@classytic/arc/plugins` | Health, graceful shutdown, request ID, SSE, caching |
| `@classytic/arc/plugins/tracing` | OpenTelemetry |
| `@classytic/arc/permissions` | All permission functions, role hierarchy |
| `@classytic/arc/scope` | Request scope helpers (`isMember`, `isElevated`, `getOrgId`) |
| `@classytic/arc/org` | Organization module |
| `@classytic/arc/hooks` | Lifecycle hooks |
| `@classytic/arc/presets` | Preset functions + interfaces |
| `@classytic/arc/audit` | Audit trail |
| `@classytic/arc/idempotency` | Idempotency |
| `@classytic/arc/policies` | Policy engine |
| `@classytic/arc/schemas` | TypeBox helpers |
| `@classytic/arc/utils` | Errors, circuit breaker, state machine, query parser |
| `@classytic/arc/testing` | Test utilities, mocks, in-memory DB |
| `@classytic/arc/migrations` | Schema migrations |
| `@classytic/arc/integrations/jobs` | BullMQ job queue |
| `@classytic/arc/integrations/websocket` | WebSocket |
| `@classytic/arc/integrations/event-gateway` | Unified SSE + WebSocket gateway |
| `@classytic/arc/integrations/streamline` | Workflow orchestration |
| `@classytic/arc/docs` | OpenAPI generation |
| `@classytic/arc/cli` | CLI commands (programmatic) |

## License

MIT
