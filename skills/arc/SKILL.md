---
name: arc
description: |
  @classytic/arc — Resource-oriented backend framework for Fastify.
  Use when building REST APIs with Fastify, resource CRUD, defineResource, createApp,
  permissions, presets, database adapters, hooks, events, QueryCache, authentication,
  multi-tenant SaaS, OpenAPI, job queues, WebSocket, MCP tools, or production deployment.
  Triggers: arc, fastify resource, defineResource, createApp, BaseController, arc preset,
  arc auth, arc events, arc jobs, arc websocket, arc mcp, arc plugin, arc testing, arc cli,
  arc permissions, arc hooks, arc pipeline, arc factory, arc cache, arc QueryCache.
version: 2.5.3
license: MIT
metadata:
  author: Classytic
  version: "2.5.3"
tags:
  - fastify
  - rest-api
  - resource-framework
  - crud
  - permissions
  - multi-tenant
  - presets
  - typescript
  - cache
  - events
  - openapi
progressive_disclosure:
  entry_point:
    summary: "Resource-oriented Fastify framework: defineResource(), presets, permissions, QueryCache, events, multi-tenant, OpenAPI"
    when_to_use: "Building REST APIs with Fastify, resource CRUD, authentication, presets, caching, events, or production deployment"
    quick_start: "1. npm install @classytic/arc fastify 2. createApp({ preset: 'production', auth: { type: 'jwt', jwt: { secret } } }) 3. defineResource({ name, adapter, presets, permissions })"
  context_limit: 700
---

# @classytic/arc

Resource-oriented backend framework for Fastify. Database-agnostic, tree-shakable, production-ready.

**Requires:** Fastify `^5.7.4` | Node.js `>=22` | ESM only

## Install

```bash
# Install the Arc agent skill (Claude Code / AI agents)
npx skills add classytic/arc

# Install the npm package
npm install @classytic/arc fastify
npm install @classytic/mongokit mongoose    # MongoDB adapter
```

## Quick Start

```typescript
import { createApp } from '@classytic/arc/factory';
import mongoose from 'mongoose';

await mongoose.connect(process.env.DB_URI);

const app = await createApp({
  preset: 'production',
  auth: { type: 'jwt', jwt: { secret: process.env.JWT_SECRET } },
  cors: { origin: process.env.ALLOWED_ORIGINS?.split(',') },
});

await app.register(productResource.toPlugin());
await app.listen({ port: 8040, host: '0.0.0.0' });
```

## defineResource()

Single API to define a full REST resource:

```typescript
import { defineResource, createMongooseAdapter, allowPublic, requireRoles } from '@classytic/arc';

const productResource = defineResource({
  name: 'product',
  adapter: createMongooseAdapter({ model: ProductModel, repository: productRepo }),
  controller: productController,  // optional — auto-created if omitted
  presets: ['softDelete', 'slugLookup', { name: 'multiTenant', tenantField: 'orgId' }],
  permissions: {
    list: allowPublic(),
    get: allowPublic(),
    create: requireRoles(['admin']),
    update: requireRoles(['admin']),
    delete: requireRoles(['admin']),
  },
  cache: { staleTime: 30, gcTime: 300, tags: ['catalog'] },
  additionalRoutes: [
    { method: 'GET', path: '/featured', handler: 'getFeatured', permissions: allowPublic(), wrapHandler: true },
  ],
});

await fastify.register(productResource.toPlugin());
// Auto-generates: GET /, GET /:id, POST /, PATCH /:id, DELETE /:id
```

## Authentication

Auth uses a **discriminated union** with `type` field:

```typescript
// Arc JWT (with optional token extraction and revocation)
auth: {
  type: 'jwt',
  jwt: { secret, expiresIn: '15m', refreshSecret, refreshExpiresIn: '7d' },
  tokenExtractor: (req) => req.cookies?.['auth-token'] ?? null,  // optional
  isRevoked: async (decoded) => redis.sismember('revoked', decoded.jti),  // optional
}

// Better Auth (recommended for SaaS with orgs)
import { createBetterAuthAdapter } from '@classytic/arc/auth';
auth: { type: 'betterAuth', betterAuth: createBetterAuthAdapter({ auth, orgContext: true }) }

// Custom Fastify plugin (must decorate fastify.authenticate)
auth: { type: 'custom', plugin: myAuthPlugin }

// Custom function (decorates fastify.authenticate directly)
auth: { type: 'authenticator', authenticate: async (req, reply) => { ... } }

// Disabled
auth: false
```

**Decorates:** `app.authenticate`, `app.optionalAuthenticate`, `app.authorize`

## Permissions

Function-based. A `PermissionCheck` returns `boolean | { granted, reason?, filters? }`:

```typescript
import {
  allowPublic, requireAuth, requireRoles, requireOwnership,
  requireOrgMembership, requireOrgRole, requireTeamMembership,
  allOf, anyOf, when, denyAll,
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

**Custom permission:**

```typescript
const requirePro = (): PermissionCheck => async (ctx) => {
  if (!ctx.user) return { granted: false, reason: 'Auth required' };
  return { granted: ctx.user.plan === 'pro' };
};
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
permissions: { list: acl.canAction('product', 'read') }
```

## Presets

| Preset | Routes Added | Controller Interface | Config |
|--------|-------------|---------------------|--------|
| `softDelete` | GET /deleted, POST /:id/restore | `ISoftDeleteController` | `{ deletedField }` |
| `slugLookup` | GET /slug/:slug | `ISlugLookupController` | `{ slugField }` |
| `tree` | GET /tree, GET /:parent/children | `ITreeController` | `{ parentField }` |
| `ownedByUser` | none (middleware) | — | `{ ownerField }` |
| `multiTenant` | none (middleware) | — | `{ tenantField }` |
| `audited` | none (middleware) | — | — |
| `bulk` | POST/PATCH/DELETE /bulk | — | `{ operations?, maxCreateItems? }` |

```typescript
presets: ['softDelete', { name: 'multiTenant', tenantField: 'organizationId' }]
// Bulk: presets: ['bulk'] or bulkPreset({ operations: ['createMany', 'updateMany'] })
```

### tenantField — When to Use and When to Disable

Arc defaults `tenantField` to `'organizationId'` on BaseController. This silently adds `{ organizationId: scope.organizationId }` to every query when the user has an org context. Correct for per-org resources, wrong for company-wide resources.

```typescript
// Per-org resource (default) — each org sees only its own data
defineResource({ name: 'invoice', ... });
// → queries auto-scoped: { organizationId: 'org-123' }

// Company-wide resource — ALL orgs share the same data
defineResource({ name: 'account-type', tenantField: false, ... });
// → no org filter applied, all users see all records

// Custom tenant field — your schema uses a different name
defineResource({ name: 'workspace-item', tenantField: 'workspaceId', ... });
// → queries scoped by workspaceId instead of organizationId
```

When to use `tenantField: false`:
- Lookup tables (account types, categories, currencies)
- Platform-wide settings or config
- Cross-org reports or analytics
- Single-tenant apps where org scoping isn't needed

## QueryCache

TanStack Query-inspired server cache with stale-while-revalidate and auto-invalidation on mutations.

```typescript
// Enable globally
const app = await createApp({ arcPlugins: { queryCache: true } });

// Per-resource config
defineResource({
  name: 'product',
  cache: {
    staleTime: 30,      // seconds fresh (no revalidation)
    gcTime: 300,         // seconds stale data kept (SWR window)
    tags: ['catalog'],   // cross-resource grouping
    invalidateOn: { 'category.*': ['catalog'] },  // event pattern → tag targets
    list: { staleTime: 60 },  // per-operation override
    byId: { staleTime: 10 },
  },
});
```

**Auto-invalidation:** POST/PATCH/DELETE bumps resource version. Old cached queries expire naturally via TTL.

**Runtime modes:** `memory` (default, zero-config) | `distributed` (requires `stores.queryCache: RedisCacheStore`)

**Response header:** `x-cache: HIT | STALE | MISS`

## BaseController

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

**IRequestContext:** `{ params, query, body, user, headers, context, metadata, server }` — `user` is `Record<string, unknown> | undefined` (guard with `if (req.user)` on public routes)

**IControllerResponse:** `{ success, data?, error?, status?, meta?, headers? }`

## Adapters (Database-Agnostic)

```typescript
// Mongoose
import { createMongooseAdapter } from '@classytic/arc';
const adapter = createMongooseAdapter({ model: ProductModel, repository: productRepo });

// Custom adapter — implement CrudRepository interface:
interface CrudRepository<TDoc> {
  getAll(params?): Promise<TDoc[] | PaginatedResult<TDoc>>;
  getById(id: string): Promise<TDoc | null>;
  create(data): Promise<TDoc>;
  update(id: string, data): Promise<TDoc | null>;
  delete(id: string): Promise<boolean>;
}
```

## Events

The factory auto-registers `eventPlugin` — no manual setup needed:

```typescript
// createApp() registers eventPlugin automatically (default: MemoryEventTransport)
const app = await createApp({
  stores: { events: new RedisEventTransport(redis) },  // optional, defaults to memory
  arcPlugins: {
    events: {                     // event plugin config (default: true, false to disable)
      logEvents: true,
      retry: { maxRetries: 3, backoffMs: 1000 },
    },
  },
});

await app.events.publish('order.created', { orderId: '123' });
await app.events.subscribe('order.*', async (event) => { ... });
```

CRUD events auto-emit: `{resource}.created`, `{resource}.updated`, `{resource}.deleted`.

**Transports:** Memory (default) | Redis Pub/Sub (fire-and-forget) | Redis Streams (durable, at-least-once, consumer groups, DLQ)

**Event Outbox** — at-least-once delivery via transactional outbox pattern. Arc ships `OutboxStore` interface + `MemoryOutboxStore` (dev). You implement the store for your DB (Mongoose, Drizzle, Knex, etc.). Cleanup via optional `purge()` contract or native DB tools (TTL index, pg_cron, key expiry).

## Factory — createApp()

```typescript
const app = await createApp({
  preset: 'production',            // production | development | testing | edge
  runtime: 'memory',              // memory (default) | distributed
  auth: { type: 'jwt', jwt: { secret } },
  cors: { origin: ['https://myapp.com'] },
  helmet: true,                    // false to disable
  rateLimit: { max: 100 },         // false to disable
  ajv: { keywords: ['x-internal'] }, // custom AJV keywords for schema validation
  arcPlugins: {
    events: true,                  // event plugin (default: true, false to disable)
    emitEvents: true,              // CRUD event emission (default: true)
    queryCache: true,              // server cache (default: false)
    sse: true,                     // SSE streaming (default: false)
    caching: true,                 // ETag + Cache-Control (default: false)
  },
  stores: {                        // required when runtime: 'distributed'
    events: new RedisEventTransport({ client: redis }),
    queryCache: new RedisCacheStore({ client: redis }),
  },
});
```

## Hooks

**Inline on resource (recommended):**

```typescript
defineResource({
  name: 'chat',
  hooks: {
    beforeCreate: async (ctx) => { ctx.data.slug = slugify(ctx.data.name); },
    afterCreate: async (ctx) => { analytics.track('created', { id: ctx.data._id, user: ctx.user?.id }); },
    beforeUpdate: async (ctx) => { console.log('Updating', ctx.meta?.id, 'existing:', ctx.meta?.existing); },
    afterUpdate: async (ctx) => { await invalidateCache(ctx.data._id); },
    beforeDelete: async (ctx) => { if (ctx.data.isProtected) throw new Error('Cannot delete'); },
    afterDelete: async (ctx) => { await cleanupFiles(ctx.meta?.id); },
  },
});
```

`ResourceHookContext`: `{ data, user?, meta? }` — `data` is the document, `meta` has `id` and `existing` (for update/delete).

**App-level (cross-resource):**

```typescript
import { createHookSystem, beforeCreate, afterUpdate } from '@classytic/arc/hooks';

const hooks = createHookSystem();
beforeCreate(hooks, 'product', async (ctx) => { ctx.data.slug = slugify(ctx.data.name); });
afterUpdate(hooks, 'product', async (ctx) => { await invalidateCache(ctx.result._id); });
```

## Pipeline

```typescript
import { guard, transform, intercept } from '@classytic/arc';

defineResource({
  pipe: {
    create: [
      guard('verified', async (ctx) => ctx.user?.verified === true),
      transform('inject', async (ctx) => { ctx.body.createdBy = ctx.user._id; }),
    ],
  },
});
```

## Query Parsing

Arc's default parser handles filters, sort, select, populate, and pagination. Swap in MongoKit's `QueryParser` for $lookup joins.

```
GET /products?page=2&limit=20&sort=-createdAt&select=name,price
GET /products?price[gte]=100&status[in]=active,featured&search=keyword
GET /products?after=<cursor_id>&limit=20                     # keyset pagination
GET /products?populate=category                               # ref-based populate
GET /products?populate[category][select]=name,slug            # populate with field select
GET /products?populate[category][select]=-internal            # exclude fields
GET /products?populate[category][match][isActive]=true        # populate with filter
```

**Lookup/join (no refs — $lookup via MongoKit QueryParser):**

```
GET /products?lookup[cat][from]=categories&lookup[cat][localField]=categorySlug&lookup[cat][foreignField]=slug&lookup[cat][single]=true
GET /products?lookup[cat][from]=categories&...&lookup[cat][select]=name,slug
```

Operators: `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `in`, `nin`, `like`, `regex`, `exists`

**Custom query parser (e.g., MongoKit >=3.4.5 for $lookup, whitelists, MCP auto-derive):**

```typescript
import { QueryParser } from '@classytic/mongokit';

defineResource({
  name: 'product',
  adapter: createMongooseAdapter({ model: ProductModel, repository: productRepo }),
  queryParser: new QueryParser({
    allowedFilterFields: ['status', 'category', 'orgId'],  // whitelist filter fields
    allowedSortFields: ['createdAt', 'price'],              // whitelist sort fields
    allowedOperators: ['eq', 'gte', 'lte', 'in'],          // whitelist operators
  }),
  // MCP auto-derives filterableFields from queryParser — no duplication needed
  schemaOptions: {
    query: {
      allowedPopulate: ['category', 'brand'],
      allowedLookups: ['categories', 'brands'],
    },
  },
});
```

## Error Classes

```typescript
import { ArcError, NotFoundError, ValidationError, createDomainError } from '@classytic/arc';
throw new NotFoundError('Product not found');                      // 404
throw createDomainError('MEMBER_NOT_FOUND', 'Not found', 404);    // domain error with code
throw createDomainError('SELF_REFERRAL', 'Cannot self-refer', 422, { field: 'referralCode' });
```

Error handler catches: `ArcError` → `.statusCode` (Fastify) → `.status` (MongoKit, http-errors) → `errorMap` → Mongoose/MongoDB → fallback 500. DB-agnostic — any error with `.status` or `.statusCode` gets the correct HTTP response.

## Compensating Transaction

In-process rollback for multi-step operations. Not a distributed saga — use Temporal/Streamline for that.

```typescript
import { withCompensation } from '@classytic/arc/utils';

const result = await withCompensation('checkout', [
  { name: 'reserve', execute: reserveStock, compensate: releaseStock },
  { name: 'charge', execute: chargeCard, compensate: refundCard },
  { name: 'notify', execute: sendEmail, fireAndForget: true },  // non-blocking
], { orderId }, {
  onStepComplete: (name, res) => fastify.events.publish(`checkout.${name}.done`, res),
});
// result: { success, completedSteps, results, failedStep?, error?, compensationErrors? }
```

## CLI

```bash
arc init my-api --mongokit --better-auth --ts
arc generate resource product              # standard resource
arc generate resource product --mcp        # resource + MCP tools file
arc generate mcp analytics                 # standalone MCP tools file
arc docs ./openapi.json --entry ./dist/index.js
arc introspect --entry ./dist/index.js
arc doctor
```

Set `"mcp": true` in `.arcrc` to always generate `.mcp.ts` files with resources.

## MCP (AI Agent Tools)

Expose Arc resources as MCP tools for AI agents. Stateless by default — fresh server per request, zero session overhead.

See [mcp reference](references/mcp.md) for full details.

```typescript
import { mcpPlugin } from '@classytic/arc/mcp';

// Stateless (default) — production-ready, scalable
await app.register(mcpPlugin, {
  resources: [productResource, orderResource],
  auth: false,                              // or: getAuth() | custom function
  exclude: ['credential'],
  overrides: { product: { operations: ['list', 'get'] } },
});

// Stateful — when you need server-initiated messages
await app.register(mcpPlugin, { resources, stateful: true, sessionTtlMs: 600000 });
```

Connect Claude CLI: `claude mcp add --transport http my-api http://localhost:3000/mcp`

**Auth** — three modes, user chooses: `false` | `getAuth()` (Better Auth OAuth 2.1) | custom function:

```typescript
auth: async (headers) => {
  if (headers['x-api-key'] !== process.env.MCP_KEY) return null;
  return { userId: 'bot', organizationId: 'org-1', roles: ['admin'] };
},
```

**Guards** for custom tools: `guard(requireAuth, requireOrg, requireRole('admin'), handler)`

**Multi-tenancy**: `organizationId` from auth flows into BaseController org-scoping automatically.

**Permission filters**: `PermissionResult.filters` from resource permissions flow into MCP tools — same as REST. Define once, works everywhere:

```typescript
permissions: {
  list: (ctx) => ({
    granted: !!ctx.user,
    filters: { orgId: ctx.user?.orgId, branchId: ctx.user?.branchId },
  }),
}
// MCP tools automatically scope queries by orgId + branchId
```

**Project structure** — custom MCP tools co-located with resources:

```
src/resources/order/
  order.resource.ts
  order.mcp.ts              ← defineTool('fulfill_order', { ... })
```

Generate: `arc generate resource order --mcp` | Wire: `extraTools: [fulfillOrderTool]`

**Auto-load resources** (v2.5.2) — no barrel files, no manual `toPlugin()`:

```typescript
import { createApp, loadResources } from '@classytic/arc/factory';

const app = await createApp({
  resources: await loadResources('./src/resources'),  // discovers *.resource.ts
  auth: { type: 'jwt', jwt: { secret: process.env.JWT_SECRET } },
});
// loadResources options: exclude, include, suffix, recursive
```

**Unified role check** (v2.5.2) — checks both platform AND org roles:

```typescript
import { roles } from '@classytic/arc/permissions';
permissions: {
  create: roles('admin', 'editor'),  // works with BA org roles + platform roles
  delete: roles('admin'),
}
// Also: requireRoles(['admin'], { includeOrgRoles: true }) for backward compat
```

**DX helpers** (v2.4.4):

```typescript
// Typed request for wrapHandler: false routes — no more (req as any).user
import type { ArcRequest } from '@classytic/arc';
handler: async (req: ArcRequest, reply) => { req.user?.id; req.scope; req.signal; }

// Response envelope — no manual { success, data } wrapping
import { envelope } from '@classytic/arc';
reply.send(envelope(data, { total: 100 }));

// Canonical org extraction — replaces 19 duplicated patterns
import { getOrgContext } from '@classytic/arc/scope';
const { userId, organizationId, roles, orgRoles } = getOrgContext(request);

// Domain errors with auto HTTP status mapping
import { createDomainError } from '@classytic/arc';
throw createDomainError('SELF_REFERRAL', 'Cannot refer yourself', 422);

// Resource lifecycle hook — wire singletons during registration
defineResource({ name: 'notification', onRegister: (f) => setSseManager(f.sseManager) });

// SSE auth — preAuth runs BEFORE auth middleware (EventSource can't set headers)
additionalRoutes: [{ preAuth: [(req) => { req.headers.authorization = `Bearer ${req.query.token}`; }] }]

// SSE streaming — auto headers + bypasses response wrapper
additionalRoutes: [{ streamResponse: true, handler: async (req, reply) => reply.send(stream) }]
```

## Subpath Imports

```typescript
import { defineResource, BaseController, allowPublic } from '@classytic/arc';
import { createApp } from '@classytic/arc/factory';
import { MemoryCacheStore, RedisCacheStore, QueryCache } from '@classytic/arc/cache';
import { createBetterAuthAdapter, extractBetterAuthOpenApi } from '@classytic/arc/auth';
import type { ExternalOpenApiPaths } from '@classytic/arc/docs';
import { eventPlugin } from '@classytic/arc/events';
import { RedisEventTransport } from '@classytic/arc/events/redis';
import { healthPlugin, gracefulShutdownPlugin } from '@classytic/arc/plugins';
import { tracingPlugin } from '@classytic/arc/plugins/tracing';
import { auditPlugin } from '@classytic/arc/audit';
import { idempotencyPlugin } from '@classytic/arc/idempotency';
import { ssePlugin } from '@classytic/arc/plugins';
import { jobsPlugin } from '@classytic/arc/integrations/jobs';
import { websocketPlugin } from '@classytic/arc/integrations/websocket';
import { eventGatewayPlugin } from '@classytic/arc/integrations/event-gateway';
import { createHookSystem } from '@classytic/arc/hooks';
import { createTestApp } from '@classytic/arc/testing';
import { Type, ArcListResponse } from '@classytic/arc/schemas';
import { createStateMachine, CircuitBreaker, withCompensation, defineCompensation } from '@classytic/arc/utils';
import { defineMigration } from '@classytic/arc/migrations';
import { isMember, isElevated, getOrgId, getUserId, getUserRoles } from '@classytic/arc/scope';
import { createTenantKeyGenerator } from '@classytic/arc/scope';
import { createRoleHierarchy } from '@classytic/arc/permissions';
import { createServiceClient } from '@classytic/arc/rpc';
import { metricsPlugin, versioningPlugin } from '@classytic/arc/plugins';
import { webhookPlugin } from '@classytic/arc/integrations/webhooks';
import { mcpPlugin, createMcpServer, defineTool, definePrompt, fieldRulesToZod, resourceToTools } from '@classytic/arc/mcp';
import { EventOutbox, MemoryOutboxStore } from '@classytic/arc/events';
import { bulkPreset } from '@classytic/arc/presets';
```

## References (Progressive Disclosure)

- **[auth](references/auth.md)** — JWT, Better Auth, API key auth, custom auth, multi-tenant
- **[events](references/events.md)** — Domain events, transports, retry, outbox pattern, auto-emission
- **[integrations](references/integrations.md)** — BullMQ jobs, WebSocket, EventGateway, Streamline, Webhooks
- **[mcp](references/mcp.md)** — MCP tools for AI agents, auto-generation from resources, custom tools, Better Auth OAuth 2.1
- **[production](references/production.md)** — Health, audit, idempotency, tracing, metrics, versioning, SSE, QueryCache, bulk ops, saga, RPC schema versioning, tenant rate limiting
- **[testing](references/testing.md)** — Test app, mocks, data factories, in-memory MongoDB
