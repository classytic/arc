# @classytic/arc

Database-agnostic resource framework for Fastify. One `defineResource()` call → REST + auth + permissions + events + caching + OpenAPI + MCP tools — without boilerplate.

**v2.11** · Fastify 5+ · Node.js 22+ · ESM only

```bash
# Core
npm install @classytic/arc fastify

# Security defaults that createApp() enables out of the box
npm install @fastify/cors @fastify/helmet @fastify/rate-limit @fastify/under-pressure @fastify/sensible
# (each is opt-out via `cors: false` / `helmet: false` / etc.)

# Pick a storage adapter
npm install @classytic/mongokit mongoose          # MongoDB (most common)
# OR @classytic/sqlitekit drizzle-orm better-sqlite3 (sqlite)
# OR bring your own: implement RepositoryLike from @classytic/repo-core
```

---

## Why arc

| | |
|---|---|
| **One call, full REST** | `defineResource({ name, adapter, presets, permissions })` → `GET /`, `GET /:id`, `POST /`, `PATCH /:id`, `DELETE /:id` + custom routes + actions |
| **DB-agnostic** | Mongoose, Drizzle/sqlitekit, or any `RepositoryLike` impl — swap backends without rewriting routes. (Prisma adapter is experimental: implemented, no integration tests yet.) |
| **Multi-tenant by default** | Tenant-field auto-injected, scope-aware queries, per-org cache keys, elevation events. |
| **Tree-shakable subpaths** | `@classytic/arc/auth`, `/events`, `/cache`, `/mcp`, `/integrations/jobs` — pay only for what you import. |
| **MCP tools, free** | Resources auto-generate Model Context Protocol tools for AI agents. Same permissions, same field rules. |

---

## Quick start

```typescript
import mongoose from 'mongoose';
import { createApp, loadResources } from '@classytic/arc/factory';

await mongoose.connect(process.env.DB_URI);

const app = await createApp({
  preset: 'production',
  resourcePrefix: '/api/v1',
  resources: await loadResources(import.meta.url),  // auto-discover *.resource.ts
  auth: { type: 'jwt', jwt: { secret: process.env.JWT_SECRET } },
  cors: { origin: process.env.ALLOWED_ORIGINS?.split(',') },
});

await app.listen({ port: 8040, host: '0.0.0.0' });
```

Resources can be a static array, an async factory (engine-bound), or auto-discovered from disk:

```typescript
// Auto-discover (recommended for >5 resources)
resources: await loadResources(import.meta.url),

// Explicit list
resources: [productResource, orderResource],

// Async factory — runs after `bootstrap[]`, before route wiring
resources: async () => {
  const [catalog, flow] = await Promise.all([ensureCatalogEngine(), ensureFlowEngine()]);
  return loadResources(import.meta.url, { context: { catalog, flow } });
},
```

`loadResources({ context })` (2.11.1+) threads engine handles into resources whose default export is `(ctx) => defineResource(...)`. No parallel factory files, no `exclude: [...]` bookkeeping.

---

## Define a resource

```typescript
import { defineResource, createMongooseAdapter } from '@classytic/arc';
import { allowPublic, requireRoles, requireAuth } from '@classytic/arc/permissions';
import { buildCrudSchemasFromModel } from '@classytic/mongokit';
import ProductModel from './product.model.js';
import productRepository from './product.repository.js';

export default defineResource({
  name: 'product',
  adapter: createMongooseAdapter({
    model: ProductModel,
    repository: productRepository,
    schemaGenerator: buildCrudSchemasFromModel,    // auto-derives CRUD schemas
  }),
  presets: ['softDelete', 'slugLookup', { name: 'multiTenant', tenantField: 'organizationId' }],
  permissions: {
    list: allowPublic(),
    get: allowPublic(),
    create: requireRoles(['admin']),
    update: requireRoles(['admin']),
    delete: requireRoles(['admin']),
  },
  schemaOptions: {
    fieldRules: {
      name: { minLength: 2, maxLength: 200 },
      sku: { pattern: '^[A-Z]{3}-\\d{3}$' },
      status: { enum: ['draft', 'active', 'archived'] },
      priceMode: { nullable: true },                          // accept null for round-trips
      organizationId: { systemManaged: true, preserveForElevated: true },
    },
    query: {
      allowedPopulate: ['category', 'createdBy'],             // populate whitelist
      filterableFields: { status: { type: 'string' } },
    },
  },
  cache: { staleTime: 30, gcTime: 300, tags: ['catalog'] },
  routes: [
    { method: 'GET', path: '/featured', handler: 'getFeatured', permissions: allowPublic() },
  ],
  actions: {
    approve: { handler: approveOrder, permissions: requireRoles(['admin']) },
  },
});
```

Auto-generates: `GET /products`, `GET /products/:id`, `POST /products`, `PATCH /products/:id`, `DELETE /products/:id` + softDelete adds `GET /products/deleted`, `POST /products/:id/restore` + slugLookup adds `GET /products/by-slug/:slug` + custom routes + `POST /products/:id/action`.

---

## Permissions

Function-based — RBAC, ABAC, ReBAC, or any combination.

```typescript
import {
  allowPublic, requireAuth, requireRoles, requireOwnership,
  requireOrgMembership, requireOrgRole, requireServiceScope,
  requireScopeContext, requireOrgInScope,
  allOf, anyOf, when, denyAll,
  createDynamicPermissionMatrix,
} from '@classytic/arc/permissions';

permissions: {
  list: allowPublic(),
  get: requireAuth(),
  create: requireRoles(['admin', 'editor']),
  update: anyOf(requireOwnership('userId'), requireRoles(['admin'])),
  delete: allOf(requireAuth(), requireRoles(['admin'])),
}
```

Custom checks return `{ granted, reason?, filters?, scope? }` — `filters` propagate into the repo query (row-level ABAC), `scope` stamps attributes downstream.

---

## Authentication

Discriminated union on `type`:

```typescript
// JWT (with optional revocation + custom token extractor)
auth: { type: 'jwt', jwt: { secret, expiresIn: '15m' } }

// Better Auth (recommended for SaaS with orgs)
import { createBetterAuthAdapter } from '@classytic/arc/auth';
auth: { type: 'betterAuth', betterAuth: createBetterAuthAdapter({ auth: getAuth(), orgContext: true }) }

// Custom Fastify plugin
auth: { type: 'custom', plugin: myAuthPlugin }

// Disabled (e.g. internal services)
auth: false
```

Better Auth + Mongoose `populate()`: import `registerBetterAuthMongooseModels` from `@classytic/arc/auth/mongoose` to register `strict: false` stub models for BA collections. Subpath gate keeps Mongoose out of Prisma/Drizzle bundles.

---

## Subpath imports

Tree-shake by importing only the subpath you need:

| Subpath | Purpose |
|---|---|
| `@classytic/arc` | `defineResource`, `BaseController`, `createMongooseAdapter`, error classes |
| `@classytic/arc/factory` | `createApp`, `loadResources`, presets |
| `@classytic/arc/auth` | JWT + Better Auth adapters |
| `@classytic/arc/auth/mongoose` | Better Auth Mongoose stub models (opt-in) |
| `@classytic/arc/permissions` | All permission helpers |
| `@classytic/arc/scope` | `RequestScope` accessors (`isMember`, `isElevated`, `getOrgId`, …) |
| `@classytic/arc/cache` | `QueryCache`, transports, plugin |
| `@classytic/arc/events` | Event plugin, transports, outbox |
| `@classytic/arc/events/redis` · `/redis-stream` | Redis Pub/Sub + Streams transports (opt-in) |
| `@classytic/arc/plugins` | Health, request-id, versioning, tracing, response-cache |
| `@classytic/arc/integrations/jobs` | BullMQ job dispatcher |
| `@classytic/arc/integrations/websocket` | WebSocket integration |
| `@classytic/arc/mcp` | Model Context Protocol tools |
| `@classytic/arc/testing` | `createTestApp`, `expectArc`, `TestAuthProvider`, `createTestFixtures` |
| `@classytic/arc/types` | Type-only barrel (zero runtime cost) |

---

## Testing

```typescript
import { createTestApp, expectArc } from '@classytic/arc/testing';
import productResource from './product.resource.js';

const ctx = await createTestApp({
  resources: [productResource],
  authMode: 'jwt',
  connectMongoose: true,           // in-memory Mongo + Mongoose connect
});
ctx.auth.register('admin', { user: { id: '1', roles: ['admin'] }, orgId: 'org-1' });

const res = await ctx.app.inject({
  method: 'POST',
  url: '/products',
  headers: ctx.auth.as('admin').headers,
  payload: { name: 'Widget' },
});
expectArc(res).ok().hidesField('password');

await ctx.close();
```

Three entry points: `createTestApp` (custom scenarios), `createHttpTestHarness` (~16 auto-generated CRUD/permission/validation tests per resource), `runStorageContract` (adapter conformance).

---

## CLI

```bash
arc init my-api --mongokit --better-auth --ts    # scaffold a new project
arc generate resource product                    # generate a resource
arc generate resource product --mcp              # + MCP tools file
arc docs ./openapi.json --entry ./dist/index.js  # emit OpenAPI
arc introspect --entry ./dist/index.js           # introspect resources
arc doctor                                       # diagnose env
```

---

## Documentation

- **Skill** for AI agents: `npx skills add classytic/arc` — wires arc into Claude Code / agentic flows.
- **Concept reference**: [wiki/index.md](wiki/index.md) — short, interlinked pages.
- **Guides**: [docs/](docs/) — getting-started, framework-extension, production-ops, testing, ecosystem.
- **Release notes**: [changelog/v2.md](changelog/v2.md).

---

## License

MIT
