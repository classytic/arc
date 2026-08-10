# @classytic/arc

[![Sponsor](https://img.shields.io/github/sponsors/classytic?style=flat-square&label=Sponsor&logo=GitHub&color=EA4AAA)](https://github.com/sponsors/classytic)

Database-agnostic resource framework for Fastify. One `defineResource()` call -> REST + auth + permissions + events + caching + OpenAPI + MCP tools.

Fastify 5+ | Node.js 22+ | ESM only

```bash
npm install @classytic/arc fastify

# Security defaults createApp() loads (each opt-out via `cors: false` etc.)
npm install @fastify/cors @fastify/helmet @fastify/rate-limit @fastify/under-pressure @fastify/sensible

# Storage adapter — pick one (kits ship their own adapters under `/adapter`)
npm install @classytic/mongokit mongoose             # MongoDB → @classytic/mongokit/adapter
# OR @classytic/sqlitekit drizzle-orm better-sqlite3 # → @classytic/sqlitekit/adapter
# OR @classytic/prismakit @prisma/client             # → @classytic/prismakit/adapter
# OR implement DataAdapter / RepositoryLike from @classytic/repo-core/adapter
```

---

## Why arc

| | |
|---|---|
| **One call, full REST** | `defineResource({ name, adapter, presets, permissions })` → `GET /`, `GET /:id`, `POST /`, `PATCH /:id`, `DELETE /:id` + custom routes + actions |
| **DB-agnostic** | Mongoose (`@classytic/mongokit/adapter`), Drizzle/SQLite (`@classytic/sqlitekit/adapter`), Prisma (`@classytic/prismakit/adapter`), or any `RepositoryLike` impl — swap backends without rewriting routes. Adapter contract lives in `@classytic/repo-core/adapter`; arc 2.12 ships zero kit-specific adapters. |
| **Multi-tenant by default** | Tenant-field auto-injected, scope-aware queries, per-org cache keys, elevation events. |
| **Tree-shakable subpaths** | `@classytic/arc/auth`, `/events`, `/cache`, `/mcp`, `/integrations/jobs` — pay only for what you import. |
| **MCP tools, free** | Resources auto-generate Model Context Protocol tools for AI agents. Same permissions, same field rules. |

---

## Quick start

```typescript
import mongoose from 'mongoose';
import { createApp, loadResources } from '@classytic/arc/factory';

await mongoose.connect(process.env.DB_URI);

// Fail fast on missing CORS env — silent `undefined` here drops to surprising
// browser defaults. Browser apps: declare an explicit allowlist (below).
// Server-to-server / API-key services: `cors: { origin: '*', credentials: false }`
// or `cors: false` to disable entirely (CORS is a browser-only concern).
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS;
if (!ALLOWED_ORIGINS) throw new Error('ALLOWED_ORIGINS env is required');

const app = await createApp({
  preset: 'production',
  resourcePrefix: '/api/v1',
  resources: await loadResources(import.meta.url),  // auto-discover *.resource.ts
  auth: { type: 'jwt', jwt: { secret: process.env.JWT_SECRET } },
  cors: { origin: ALLOWED_ORIGINS.split(','), credentials: true },
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

`loadResources({ context })` threads engine handles into resources whose default export is `(ctx) => defineResource(...)`. No parallel factory files, no `exclude: [...]` bookkeeping.

---

## Define a resource

```typescript
import { defineResource } from '@classytic/arc';
import { allowPublic, requireRoles, requireAuth } from '@classytic/arc/permissions';
import { createMongooseAdapter } from '@classytic/mongokit/adapter';
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
  // mcp: false,    // opt out of MCP tool generation for this resource
});
```

Auto-generates: `GET /products`, `GET /products/:id`, `POST /products`, `PATCH /products/:id`, `DELETE /products/:id` + softDelete adds `GET /products/deleted`, `POST /products/:id/restore` + slugLookup adds `GET /products/slug/:slug` + custom routes + `POST /products/:id/action`.

### Resource shorthands

```typescript
// Reference data — read-only list+get, fetch-all limits (1000), 5min/10min cache.
defineResource({ name: 'currency', adapter, referenceData: true });

// Service resource — custom routes only, no adapter, no auto-CRUD, no registry entry.
defineResource({
  name: 'health',
  customRoutesOnly: true,
  routes: [{ method: 'GET', path: '/ping', permissions: allowPublic(), handler: () => ({ ok: true }) }],
});

// Tune pagination caps inline (no custom queryParser needed).
defineResource({ name: 'pipeline', adapter, defaultLimit: 200, maxLimit: 500 });
```

A `?limit=` above the cap is **clamped to it** and served, not rejected (changed in 2.33). Rejecting made the documented clamp unreachable and turned a benign over-ask into a 400 that callers commonly render as an empty list. The effective cap is carried in the OpenAPI parameter description, and the response's own `limit` reports what was applied.

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

## Aggregations

Add `aggregations: { … }` to a resource and arc registers `GET /:prefix/aggregations/:name` per entry. Each runs a portable `$match → $group → $project → $sort → $limit` pipeline against the kit's `repo.aggregate(req, options)` — same shape across mongokit / sqlitekit / prismakit, so dashboards work unchanged across backends.

```typescript
import { defineResource, defineAggregation } from '@classytic/arc';

defineResource({
  name: 'transaction',
  adapter,
  presets: [multiTenantPreset({ tenantField: 'organizationId' })],
  permissions: { list: canViewRevenue() },

  aggregations: {
    byPaymentMethod: defineAggregation({
      groupBy: 'method',
      measures: { total: 'sum:amount', count: 'count' },
      sort: { total: -1 },
      cache: { staleTime: 60, swr: true, tags: ['revenue'] },
      permissions: canViewRevenue(),
    }),
    byDay: defineAggregation({
      dateBuckets: { day: { field: 'createdAt', interval: 'day' } },
      groupBy: 'flow',
      measures: { total: 'sum:amount', count: 'count' },
      requireDateRange: { field: 'createdAt', maxRangeDays: 365 },
      cache: { staleTime: 60, swr: true, tags: ['revenue'] },
      permissions: canViewRevenue(),
    }),
  },
});
```

Caller filters via query string compose with the declaration:

```
GET /api/transactions/aggregations/byPaymentMethod?status=verified
GET /api/transactions/aggregations/byDay?createdAt[gte]=2026-01-01&createdAt[lt]=2026-02-01
```

Tenant scope flows through `repo.aggregate(req, options)` — the kit's multi-tenant plugin handles type-coercion (string → ObjectId for mongokit `fieldType: 'objectId'`, UUID/text for sqlitekit, etc.). Arc itself stays out of the filter slot because it's DB-agnostic. Safety guards on the declaration: `requireFilters`, `requireDateRange { maxRangeDays }`, `maxGroups`. SWR cache + tag invalidation tie aggregations to CRUD writes. Every aggregation auto-exports as an MCP tool with the same permissions and filter validation.

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

Better Auth + arc resources over BA tables: the kit owns the bridge. `@classytic/mongokit/better-auth` ships `createBetterAuthOverlay()` (per-collection `DataAdapter` for `defineResource`) and `registerBetterAuthStubs()` (bulk stub models for `populate()`). Sqlitekit users hand-roll the Drizzle table — see [auth.md](skills/arc/references/auth.md).

---

## Subpath imports

Tree-shake by importing only the subpath you need:

| Subpath | Purpose |
|---|---|
| `@classytic/arc` | `defineResource`, `BaseController`, error classes |
| `@classytic/repo-core/adapter` | Adapter contract types: `DataAdapter`, `RepositoryLike`, `AdapterRepositoryInput`, `asRepositoryLike`, `isRepository`. **Imported from repo-core directly** — arc deliberately does not re-export the contract to keep one source of truth. |
| `@classytic/arc/factory` | `createApp`, `loadResources`, presets |
| `@classytic/arc/auth` | JWT + Better Auth adapters |
| `@classytic/mongokit/better-auth` | BA overlay for Mongoose: `createBetterAuthOverlay`, `registerBetterAuthStubs` (kit-owned) |
| `@classytic/repo-core/better-auth` | BA collection registry shared by every kit's overlay |
| `@classytic/arc/permissions` | All permission helpers |
| `@classytic/arc/scope` | `RequestScope` accessors (`isMember`, `isElevated`, `getOrgId`, …) |
| `@classytic/arc/cache` | `QueryCache`, transports, plugin |
| `@classytic/arc/events` | Event plugin, `MemoryEventTransport`, outbox (event types live in `@classytic/primitives/events`) |
| `@classytic/arc/events/redis` · `/redis-stream` | Redis Pub/Sub + Streams transports (opt-in) |
| `@classytic/arc/plugins` | Health, request-id, versioning, tracing, response-cache |
| `@classytic/arc/integrations/jobs` | BullMQ job dispatcher |
| `@classytic/arc/integrations/websocket` | WebSocket integration |
| `@classytic/arc/mcp` | Model Context Protocol tools + `createMcpAuthFromBetterAuthApiKey` (Better Auth API-key resolver), `resolveToolCollisions` |
| `@classytic/arc/utils` | `pipeUIMessageStreamToReply`, `UI_MESSAGE_STREAM_HEADERS` (Vercel AI SDK → Fastify reply); errors, query parser, circuit breaker |
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
ctx.auth.register('admin', { user: { id: '1', role: 'admin' }, orgId: 'org-1' });

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


## Trademark

The code is MIT-licensed. **"Classytic", "arc", and the logos are trademarks of
Classytic LLC** and are **not** licensed under MIT — see [TRADEMARK.md](TRADEMARK.md).
Forks must be renamed; the license covers the code, not the brand.
