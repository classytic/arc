---
name: arc
description: |
  @classytic/arc — Resource-oriented backend framework for Fastify.
  Use when building REST APIs with Fastify, resource CRUD, defineResource, createApp,
  permissions, presets (softDelete, multiTenant, tree, slugLookup, ownedByUser, audited),
  database adapters, hooks, events, job queues, WebSocket, workflows, authentication,
  multi-tenant SaaS, OpenAPI generation, or production deployment.
  Triggers: arc, fastify resource, defineResource, createApp, BaseController, arc preset,
  arc auth, arc events, arc jobs, arc websocket, arc plugin, arc testing, arc cli,
  arc permissions, arc hooks, arc pipeline, arc factory, arc migration, arc idempotency.
version: 2.0.0
license: MIT
metadata:
  author: Classytic
  version: "2.0.0"
tags:
  - fastify
  - rest-api
  - resource-framework
  - crud
  - permissions
  - multi-tenant
  - presets
  - typescript
  - mongodb
  - prisma
  - events
  - jobs
  - websocket
  - openapi
  - tree-shakable
progressive_disclosure:
  entry_point:
    summary: "Resource-oriented Fastify framework: defineResource(), presets, permissions, events, jobs, WebSocket, multi-tenant, OpenAPI"
    when_to_use: "Building REST APIs with Fastify, resource CRUD, authentication, presets, events, jobs, WebSocket, multi-tenant, or production deployment"
    quick_start: "1. npm install @classytic/arc fastify 2. createApp({ preset: 'production', auth: { jwt: { secret } } }) 3. defineResource({ name, adapter, presets, permissions })"
  context_limit: 700
---

# @classytic/arc

Resource-oriented backend framework for Fastify. Database-agnostic, tree-shakable, production-ready.

**Requires:** Fastify `^5.0.0` | Node.js `>=20` | ESM only

## Installation

```bash
npm install @classytic/arc fastify
# Database kit (choose one):
npm install @classytic/mongokit mongoose    # MongoDB
# npm install @classytic/prismakit          # PostgreSQL/MySQL/SQLite (coming soon)
```

## Quick Start

```typescript
import { createApp } from '@classytic/arc/factory';
import mongoose from 'mongoose';

await mongoose.connect(process.env.DB_URI);

const app = await createApp({
  preset: 'production',    // or 'development', 'testing', 'edge'
  auth: { jwt: { secret: process.env.JWT_SECRET } },
  cors: { origin: process.env.ALLOWED_ORIGINS?.split(',') },
});

await app.register(productResource.toPlugin());
await app.listen({ port: 8040, host: '0.0.0.0' });
```

## Core Pattern — defineResource()

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
    create: requireRoles(['admin', 'editor']),
    update: requireRoles(['admin']),
    delete: requireRoles(['admin']),
    deleted: requireRoles(['admin']),    // softDelete preset
    restore: requireRoles(['admin']),    // softDelete preset
    getBySlug: allowPublic(),            // slugLookup preset
  },
  additionalRoutes: [
    { method: 'GET', path: '/featured', handler: 'getFeatured', permissions: allowPublic(), wrapHandler: true },
  ],
});

await fastify.register(productResource.toPlugin());
// Auto-generates: GET /, GET /:id, POST /, PATCH /:id, DELETE /:id
// Plus preset routes: GET /deleted, POST /:id/restore, GET /slug/:slug
```

## BaseController

Framework-agnostic CRUD with auto-wiring. Override only what you need:

```typescript
import { BaseController } from '@classytic/arc';
import type { IRequestContext, IControllerResponse } from '@classytic/arc';
import type { ISoftDeleteController, ISlugLookupController } from '@classytic/arc/presets';

class ProductController extends BaseController<Product>
  implements ISoftDeleteController<Product>, ISlugLookupController<Product> {

  constructor() {
    super(productRepository);
  }

  // Custom method — receives Arc context, not Fastify request
  async getFeatured(req: IRequestContext): Promise<IControllerResponse> {
    const products = await this.repository.getAll({
      filters: { isFeatured: true, organizationId: req.organizationId },
    });
    return { success: true, data: products };
  }

  // Required by ISoftDeleteController
  async getDeleted(req: IRequestContext): Promise<IControllerResponse> { ... }
  async restore(req: IRequestContext): Promise<IControllerResponse> { ... }

  // Required by ISlugLookupController
  async getBySlug(req: IRequestContext): Promise<IControllerResponse> { ... }
}
```

**IRequestContext shape:**

```typescript
interface IRequestContext {
  params: Record<string, string>;
  query: Record<string, unknown>;
  body: unknown;
  user: UserBase | null;
  headers: Record<string, string | undefined>;
  organizationId?: string;
  teamId?: string;
  metadata?: Record<string, unknown>;   // _policyFilters, middleware data
}
```

**IControllerResponse shape:**

```typescript
interface IControllerResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  status?: number;         // 200, 201, 400, 401, 403, 404, 500
  meta?: Record<string, unknown>;
}
```

## Presets

Composable resource behaviors. String or object form:

| Preset | Routes Added | Controller Interface | Notes |
|--------|-------------|---------------------|-------|
| `softDelete` | GET /deleted, POST /:id/restore | `ISoftDeleteController` | Adds `deletedAt` field |
| `slugLookup` | GET /slug/:slug | `ISlugLookupController` | Configurable `slugField` |
| `tree` | GET /tree, GET /:parent/children | `ITreeController` | Hierarchical data |
| `ownedByUser` | none | none (middleware) | Auto-checks `createdBy` on update/delete |
| `multiTenant` | none | none (middleware) | Auto-filters by `organizationId` |
| `audited` | none | none (middleware) | Sets `createdBy`/`updatedBy` from user |

```typescript
presets: [
  'softDelete',
  { name: 'softDelete', deletedField: 'archivedAt' },          // custom field
  { name: 'ownedByUser', ownerField: 'authorId', bypassRoles: ['admin'] },
  { name: 'multiTenant', tenantField: 'organizationId' },
  { name: 'tree', parentField: 'parentCategory' },
]
```

**Custom presets:**

```typescript
import { registerPreset } from '@classytic/arc/presets';

registerPreset('timestamped', (options) => ({
  name: 'timestamped',
  middlewares: { create: [setCreatedAt], update: [setUpdatedAt] },
}));
```

## Permissions

Function-based, not string arrays. A `PermissionCheck` is any function matching:

```typescript
type PermissionCheck = (ctx: PermissionContext) => boolean | PermissionResult | Promise<boolean | PermissionResult>;

interface PermissionContext {
  user: UserBase | null;
  request: FastifyRequest;
  resource: string;
  action: string;
  resourceId?: string;
  organizationId?: string;
  data?: Record<string, unknown>;
}

interface PermissionResult {
  granted: boolean;
  reason?: string;                      // Shown in error response
  filters?: Record<string, unknown>;    // Injected into query (ownership)
}
```

### Built-in Permission Functions

```typescript
import {
  allowPublic, requireAuth, requireRoles, requireOwnership,
  requireOrgMembership, requireOrgRole, requireTeamMembership,
  allOf, anyOf, when, denyAll,
} from '@classytic/arc';

allowPublic()                                         // No auth
requireAuth()                                         // Any authenticated user
requireRoles(['admin', 'editor'])                     // At least one role matches
requireOwnership('userId', { bypassRoles: ['admin'] })  // Returns scoping filter
requireOrgMembership()                                // Must be member of active org
requireOrgRole('admin', 'owner')                      // Must have org-level role
requireTeamMembership()                               // Must have active team
denyAll('Maintenance mode')                           // Always deny

// Composite
allOf(requireAuth(), requireRoles(['admin']))          // AND — all must pass
anyOf(requireRoles(['admin']), requireOwnership('userId'))  // OR — any can pass
when(ctx => ctx.request.query.public === 'true')        // Conditional — returns PermissionCheck
```

### Custom Permissions

Just write a function that returns `boolean` or `{ granted, reason?, filters? }`:

```typescript
import type { PermissionCheck } from '@classytic/arc/permissions';

// Custom — check subscription tier
const requirePro = (): PermissionCheck => async (ctx) => {
  if (!ctx.user) return { granted: false, reason: 'Authentication required' };
  if (ctx.user.plan !== 'pro') return { granted: false, reason: 'Pro plan required' };
  return { granted: true };
};

// Custom — time-based role check
const requireActiveEditor = (): PermissionCheck => async (ctx) => {
  if (!ctx.user) return false;
  return ctx.user.roles?.includes('editor') && ctx.user.status === 'active';
};

// Mix custom + built-in
defineResource({
  name: 'report',
  permissions: {
    list: requireAuth(),
    get: requireAuth(),
    create: requirePro(),
    update: anyOf(requireActiveEditor(), requireRoles(['admin'])),
    delete: requireRoles(['admin']),
  },
});
```

### Preset Permission Shortcuts

```typescript
import { publicRead, adminOnly, ownerWithAdminBypass, authenticated } from '@classytic/arc';

defineResource({
  permissions: publicRead(),          // list/get: public, create/update/delete: requireAuth()
  // or: adminOnly(), authenticated(), ownerWithAdminBypass(), publicReadAdminWrite()
});
```

### Field-Level Permissions

```typescript
import { fields } from '@classytic/arc';

defineResource({
  fields: {
    password: fields.hidden(),                    // Never in responses, not writable
    salary: fields.visibleTo(['admin', 'hr']),    // Only visible to these roles
    role: fields.writableBy(['admin']),            // Only writable by admin
    email: fields.redactFor(['viewer'], '***'),   // Redacted for these roles
  },
});
```

## Adapters (Database-Agnostic)

```typescript
interface DataAdapter<TDoc> {
  repository: CrudRepository<TDoc>;     // Your CRUD impl
  type: string;                         // 'mongoose', 'prisma', 'custom'
  name: string;                         // Display name
  generateSchemas?(): Record<string, unknown>;  // OpenAPI
  getSchemaMetadata?(): FieldMetadata[];         // Field introspection
}

// Mongoose
import { createMongooseAdapter } from '@classytic/arc';
const adapter = createMongooseAdapter({ model: ProductModel, repository: productRepo });

// Custom
const customAdapter: DataAdapter<Product> = {
  repository: myCustomRepo,
  type: 'custom',
  name: 'Product',
};
```

**CrudRepository interface** (what your repo must implement):

```typescript
interface CrudRepository<TDoc> {
  getAll(params?: QueryOptions): Promise<TDoc[] | PaginatedResult<TDoc>>;
  getById(id: string, options?): Promise<TDoc | null>;
  create(data: Partial<TDoc>, options?): Promise<TDoc>;
  update(id: string, data: Partial<TDoc>, options?): Promise<TDoc | null>;
  delete(id: string, options?): Promise<boolean | { success }>;
}
```

## Request Flow

```
HTTP Request → onRequest (AsyncLocalStorage) → authenticate → permission check
→ org scope → custom middlewares → Pipeline (guards → transforms → interceptors)
→ Controller method → before hooks → Repository operation → after hooks
→ Event emission → Response
```

## Hooks

Instance-scoped lifecycle hooks with dependency resolution:

```typescript
import { createHookSystem, beforeCreate, afterUpdate, defineHook } from '@classytic/arc/hooks';

const hooks = createHookSystem();

// Shortcut functions
beforeCreate(hooks, 'product', async (ctx) => { ctx.data.slug = slugify(ctx.data.name); });
afterUpdate(hooks, 'product', async (ctx) => { await invalidateCache(ctx.result._id); });

// Full API with priority + dependencies
const hook = defineHook({
  name: 'slugify',
  resource: 'product',
  operation: 'create',
  phase: 'before',
  handler: async (ctx) => { ctx.data.slug = slugify(ctx.data.name); },
  priority: 5,             // lower = earlier (default: 10)
  dependsOn: ['validate'],  // topological sort
});
hook.register(hooks);       // returns unregister function
```

## Pipeline (Guards / Transforms / Interceptors)

Advanced request processing — runs after auth/permissions, before controller:

```typescript
import { guard, transform, intercept } from '@classytic/arc';

defineResource({
  pipe: {
    create: [
      guard('verifiedOnly', async (ctx) => ctx.user?.verified === true),
      transform('injectCreator', async (ctx) => { ctx.body.createdBy = ctx.user._id; }),
      intercept('timing', async (ctx, next) => {
        const start = Date.now();
        const result = await next();
        console.log(`Took ${Date.now() - start}ms`);
        return result;
      }),
    ],
  },
});
```

## Factory — createApp()

Production app factory with opt-out security:

```typescript
import { createApp } from '@classytic/arc/factory';

const app = await createApp({
  preset: 'production',      // production | development | testing | edge
  auth: {
    jwt: { secret, expiresIn: '7d' },  // Arc JWT (default)
    // betterAuth: betterAuthAdapter,   // Better Auth (recommended for multi-org)
    // plugin: myCustomAuthPlugin,       // Bring your own (Passport, Clerk, Auth0)
    // authenticate: async (req) => user, // Custom function
    // false,                            // Disable auth
  },
  cors: { origin: ['https://myapp.com'] },
  helmet: true,              // default: true (set false to disable)
  rateLimit: { max: 300, timeWindow: '1 minute' },
  underPressure: true,       // default: true
  typeProvider: 'typebox',   // optional TypeBox integration
  arcPlugins: {
    health: true,
    gracefulShutdown: true,
    requestId: true,
  },
});
```

**Presets:**

| Preset | Logging | CORS | Rate Limit | Security | Health |
|--------|---------|------|------------|----------|--------|
| production | info | strict | 100/min | full | yes |
| development | debug | permissive | 1000/min | relaxed | yes |
| testing | silent | none | disabled | minimal | no |
| edge | warn | none (API GW) | none | none | no |

## Query Parsing

Built-in parser or pluggable:

```
GET /products?page=2&limit=20&sort=-createdAt,name&select=name,price
GET /products?price[gte]=100&price[lte]=500&status=active
GET /products?status[in]=active,featured&name[regex]=^Pro
GET /products?search=keyword&populate=category,brand
GET /products?populate[author][select]=name,email   # MongoKit parser
```

```typescript
// Use MongoKit's advanced parser
import { QueryParser } from '@classytic/mongokit';

defineResource({
  queryParser: new QueryParser({ maxLimit: 100, maxFilterDepth: 5 }),
});
```

## Error Classes

```typescript
import {
  ArcError, NotFoundError, ValidationError, UnauthorizedError, ForbiddenError,
} from '@classytic/arc';
import { ConflictError, ServiceUnavailableError } from '@classytic/arc/utils';

// All extend ArcError, have statusCode and toJSON()
throw new NotFoundError('Product not found');        // 404
throw new ValidationError('Invalid email format');   // 400
throw new ForbiddenError('Insufficient permissions'); // 403
```

## State Machine

```typescript
import { createStateMachine } from '@classytic/arc/utils';

const orderFSM = createStateMachine('order', {
  submit: { from: ['draft'], to: 'pending', guard: ({ data }) => data.items.length > 0 },
  approve: { from: ['pending'], to: 'approved' },
  ship: { from: ['approved'], to: 'shipped' },
  cancel: { from: ['draft', 'pending'], to: 'cancelled' },
}, { trackHistory: true });

orderFSM.can('submit', 'draft');          // true
orderFSM.getAvailableActions('pending');  // ['approve', 'cancel']
```

## Circuit Breaker

```typescript
import { CircuitBreaker } from '@classytic/arc/utils';

const breaker = new CircuitBreaker(
  async (amount) => stripe.charges.create({ amount }),
  { failureThreshold: 5, resetTimeout: 30000, fallback: async (amt) => queuePayment(amt) }
);
```

## CLI

### Initialize a Project

```bash
arc init my-api                                    # Interactive prompts
arc init my-api --mongokit --better-auth --single --ts  # Non-interactive (all flags)
arc init my-api --mongokit --jwt --single --js     # JWT auth, JavaScript
arc init my-api --mongokit --multi --ts            # Multi-tenant
arc init my-api --edge --skip-install              # Edge/serverless target
```

**Init flags:**

| Flag | Description |
|------|-------------|
| `--mongokit` | MongoKit adapter (default, recommended) |
| `--custom` | Custom adapter (empty template) |
| `--better-auth` | Better Auth (default, recommended) |
| `--jwt` | Arc built-in JWT auth (`@fastify/jwt` v10) |
| `--multi-tenant`, `--multi` | Multi-tenant mode (adds org scoping) |
| `--single-tenant`, `--single` | Single-tenant mode (default) |
| `--ts`, `--typescript` | TypeScript (default) |
| `--js`, `--javascript` | JavaScript |
| `--edge`, `--serverless` | Target edge/serverless environments |
| `--force`, `-f` | Overwrite existing directory |
| `--skip-install` | Skip `npm install` after scaffolding |

### Generate Resources

```bash
arc generate resource product    # Full resource (model, repo, controller, schemas, resource def)
arc g r invoice                  # Shorthand
arc g controller auth            # Controller only
arc g model order                # Model only
arc g repository payment         # Repository only
arc g schemas ticket             # Schemas only
```

**Scaffolded structure** (for `arc g r product`):

```
src/resources/product/
├── product.model.ts
├── product.repository.ts
├── product.controller.ts
├── product.schemas.ts
├── product.resource.ts
└── product.test.ts
```

Auto-detects TypeScript/JavaScript from `tsconfig.json`.

### Introspect & Describe

```bash
arc introspect --entry ./dist/index.js            # Show all registered resources
arc describe ./dist/resources.js                  # JSON metadata (arc-describe/v1)
arc describe ./dist/resources.js product --json   # Single resource
arc docs ./docs/openapi.json --entry ./dist/index.js  # Export OpenAPI spec
```

`arc describe` outputs machine-readable JSON with fields, permissions, pipeline, routes, and events per resource — designed for AI agent consumption.

## Subpath Imports (Tree-Shaking)

```typescript
import { defineResource } from '@classytic/arc';                    // Core
import { createApp } from '@classytic/arc/factory';                 // Factory
import { allowPublic, requireRoles, requireOrgMembership, requireTeamMembership } from '@classytic/arc/permissions'; // Permissions
import { eventPlugin } from '@classytic/arc/events';                // Events
import { RedisEventTransport } from '@classytic/arc/events/redis';  // Redis transport
import { jobsPlugin, defineJob } from '@classytic/arc/integrations/jobs'; // BullMQ
import { websocketPlugin } from '@classytic/arc/integrations/websocket'; // WebSocket
import { streamlinePlugin } from '@classytic/arc/integrations/streamline'; // Workflows
import { authPlugin } from '@classytic/arc/auth';                   // Auth
import { healthPlugin, gracefulShutdownPlugin } from '@classytic/arc/plugins'; // Plugins
import { tracingPlugin } from '@classytic/arc/plugins/tracing';     // OpenTelemetry
import { auditPlugin } from '@classytic/arc/audit';                 // Audit trail
import { idempotencyPlugin } from '@classytic/arc/idempotency';     // Idempotency
import { organizationPlugin } from '@classytic/arc/org';            // Multi-tenant
import { createHookSystem, beforeCreate } from '@classytic/arc/hooks'; // Hooks
import { createAccessControlPolicy } from '@classytic/arc/policies'; // Policies
import { ResourceRegistry } from '@classytic/arc/registry';         // Introspection
import { createTestApp, TestHarness } from '@classytic/arc/testing'; // Testing
import { Type, ArcListResponse } from '@classytic/arc/schemas';     // TypeBox
import { defineMigration } from '@classytic/arc/migrations';        // Migrations
import { requestContext } from '@classytic/arc';                     // AsyncLocalStorage
```

## Related Skills

Arc uses MongoKit as its default database adapter. Install its skill for MongoDB repository patterns, plugins, pagination, caching, and query parsing:

```bash
npx skills add classytic/mongokit
```

## References (Progressive Disclosure)

For detailed documentation on specific subsystems, see:

- **[events](references/events.md)** — Domain events, transports (Memory/Redis/Streams), injectable logger, retry, auto-emission
- **[integrations](references/integrations.md)** — BullMQ jobs, WebSocket, Streamline workflows
- **[auth](references/auth.md)** — JWT, Better Auth (plugins, teams, Redis, microservice gateway), custom auth, multi-tenant auth
- **[production](references/production.md)** — Health checks, audit trail, idempotency, tracing, SSE, caching
- **[testing](references/testing.md)** — Test app creation, mocks, data factories, in-memory MongoDB
