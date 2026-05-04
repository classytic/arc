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
license: MIT
metadata:
  author: Classytic
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
    summary: "Resource-oriented Fastify framework: defineResource(), presets, permissions, QueryCache, events, multi-tenant, OpenAPI, MCP"
    when_to_use: "Building REST APIs with Fastify, resource CRUD, authentication, presets, caching, events, or production deployment"
    quick_start: "1. arc init my-api --mongokit --jwt --ts  2. defineResource({ name, adapter, presets, permissions })  3. createApp({ preset: 'production', resources, auth })"
---

# @classytic/arc

Resource-oriented backend framework for Fastify. **Fastify ≥5.8.5 · Node ≥22 · ESM only.**

One `defineResource()` call → REST + auth + permissions + events + cache + OpenAPI + MCP. Database-agnostic (Mongoose, Drizzle/sqlitekit, Prisma, custom).

## Scaffold a project

```bash
npx @classytic/arc@latest init my-api --mongokit --jwt --ts
cd my-api && npm install && npm run dev
```

Flags: `--mongokit | --custom`, `--jwt | --better-auth`, `--single | --multi`, `--ts | --js`. The scaffold seeds full `dependencies` + `devDependencies` so `npm install` works without the CLI's pre-pass.

## createApp()

```typescript
import { createApp } from '@classytic/arc/factory';

const app = await createApp({
  preset: 'production',                  // production | development | testing | edge
  runtime: 'memory',                     // memory (default) | distributed
  auth: { type: 'jwt', jwt: { secret: process.env.JWT_SECRET } },
  cors: { origin: ['https://myapp.com'] },
  helmet: true,                          // false to disable
  rateLimit: { max: 100 },               // false to disable
  ajv: { keywords: ['x-internal'] },
  resources: [productResource, orderResource],   // canonical: factory wires them in the right slot
  arcPlugins: {
    events: true,                        // default true — disables CRUD event emission if false
    queryCache: true,                    // default false
    sse: true,                           // default false
    caching: true,                       // ETag + Cache-Control
  },
  stores: {                              // required when runtime: 'distributed'
    events: new RedisEventTransport({ client: redis }),
    queryCache: new RedisCacheStore({ client: redis }),
  },
});

await app.listen({ port: 8040, host: '0.0.0.0' });
```

**Boot sequence:** `plugins` → `bootstrap[]` → `resources` (factory form runs here) → `afterResources` → `onReady`.

**Async-booted engines** — use the factory form for `resources` so it runs after `bootstrap[]`:

```typescript
resources: async (fastify) => {
  const engine = await ensureCatalogEngine();
  return [buildProductResource(engine), buildCategoryResource(engine)];
}
```

**Auto-discover resources:**

```typescript
import { loadResources } from '@classytic/arc/factory';

resources: await loadResources(import.meta.url),                          // discovers *.resource.ts
resources: await loadResources(import.meta.url, { context: { engine } }), // threads ctx into (ctx) => defineResource(...)
```

Pass `import.meta.url` for dev/prod parity (resolves `src/` in dev, `dist/` in prod). Discovers `default` export, `export const resource`, OR any named export with `.toPlugin()`. Works with relative imports + Node `#` subpath imports — **NOT** tsconfig path aliases (`@/*` are compile-time only).

## defineResource()

```typescript
import { defineResource, allowPublic, requireRoles } from '@classytic/arc';
import { createMongooseAdapter } from '@classytic/mongokit/adapter';
import { buildCrudSchemasFromModel } from '@classytic/mongokit';

const productResource = defineResource({
  name: 'product',
  adapter: createMongooseAdapter({
    model: ProductModel,
    repository: productRepo,
    schemaGenerator: buildCrudSchemasFromModel,   // required (no built-in fallback)
  }),
  controller: productController,        // optional — auto-built if omitted

  presets: ['softDelete', 'slugLookup', { name: 'multiTenant', tenantField: 'orgId' }],

  permissions: {
    list: allowPublic(),
    get: allowPublic(),
    create: requireRoles(['admin']),
    update: requireRoles(['admin']),
    delete: requireRoles(['admin']),
  },

  cache: { staleTime: 30, gcTime: 300, tags: ['catalog'] },

  routeGuards: [orgGuard.preHandler],   // applied to ALL routes (CRUD + custom + preset)

  schemaOptions: {
    fieldRules: {
      name: { minLength: 2, maxLength: 200 },
      sku: { pattern: '^[A-Z]{3}-\\d{3}$' },
      status: { enum: ['draft', 'active', 'archived'] },
      deletedAt: { systemManaged: true },     // arc stamps it; strip from body + required[]
      priceMode: { nullable: true },          // widen JSON-Schema type to accept null
    },
  },

  routes: [
    { method: 'GET', path: '/featured', handler: 'getFeatured', permissions: allowPublic() },
    { method: 'POST', path: '/webhook', handler: webhookFn, raw: true, permissions: requireAuth() },
  ],

  actions: {                            // single POST /:id/action endpoint, discriminated on `action`
    approve: async (id, data, req) => service.approve(id, req.user._id),
    cancel: {
      handler: async (id, data, req) => service.cancel(id, data.reason, req.user._id),
      permissions: requireRoles('admin'),
      schema: { reason: { type: 'string' } },
    },
  },
  actionPermissions: requireAuth(),     // fallback gate for actions without per-action perm
});
```

**Generated routes:** `GET /`, `GET /:id`, `POST /`, `PATCH /:id`, `DELETE /:id`. Presets add `/deleted` + `/:id/restore` (softDelete), `/slug/:slug` (slugLookup), etc.

## Active behavior to know about

- **Field-write reject (default).** Requests carrying non-writable fields → 403 with denied list. Opt into silent strip: `defineResource({ onFieldWriteDenied: 'strip' })`.
- **multiTenant injects org on UPDATE.** Body `organizationId` is overwritten with caller's scope (closes tenant-hop).
- **MCP tools fail-closed.** A resource action without per-action perm + no `actionPermissions` + no `permissions.update` fallback → throws at tool generation. Declare `allowPublic()` to opt into unauthenticated.
- **`systemManaged` fields** auto-strip from `required[]` so AJV doesn't reject before arc's framework injection runs.
- **`request.user`** is `Record<string, unknown> | undefined` — guard with `if (req.user)` on public routes.
- **Arc's permission engine reads singular `user.role`** (string, comma-separated, or array). Don't use plural `roles` on the model.
- **`verifySignature(body, ...)`** throws on parsed body — pass `req.rawBody`.
- **Upload `sanitizeFilename`** strict by default; pass `false` / `'*'` / fn to relax.

## Authentication

Discriminated union on `type`:

```typescript
// Arc JWT (with optional revocation + custom token extractor)
auth: {
  type: 'jwt',
  jwt: { secret, expiresIn: '15m', refreshSecret, refreshExpiresIn: '7d' },
  tokenExtractor: (req) => req.cookies?.['auth-token'] ?? null,
  isRevoked: async (decoded) => redis.sismember('revoked', decoded.jti),
}

// Better Auth (recommended for SaaS with orgs)
import { createBetterAuthAdapter } from '@classytic/arc/auth';
auth: { type: 'betterAuth', betterAuth: createBetterAuthAdapter({ auth, orgContext: true }) }

// Custom Fastify plugin / function
auth: { type: 'custom', plugin: myAuthPlugin }
auth: { type: 'authenticator', authenticate: async (req, reply) => { ... } }

// Disabled
auth: false
```

Decorates `app.authenticate`, `app.optionalAuthenticate`, `app.authorize`.

**Better Auth — arc is plugin-agnostic.** `auth.$context.tables` introspection lets the kit overlays read whatever plugins you've enabled — no per-plugin code in arc/mongokit/sqlitekit. Tested combinations: `organization`, `twoFactor`, `admin`, `bearer` (built-in), plus `apiKey` from the **separate** `@better-auth/api-key` package.

```typescript
import { betterAuth } from 'better-auth';
import { mongodbAdapter } from '@better-auth/mongo-adapter';
import { organization, twoFactor, admin, bearer } from 'better-auth/plugins';
import { apiKey } from '@better-auth/api-key';                        // ← separate npm package
import { createBetterAuthOverlay, registerBetterAuthStubs } from '@classytic/mongokit/better-auth';

const auth = betterAuth({
  database: mongodbAdapter(mongoose.connection.getClient().db()),
  emailAndPassword: { enabled: true },
  plugins: [organization(), twoFactor(), admin(), bearer(), apiKey({ enableSessionForAPIKeys: true })],
});

// Bulk-register populate() stubs. extraCollections covers tables not in the plugin map (apikey, passkey, …).
registerBetterAuthStubs(mongoose, { plugins: ['organization'], extraCollections: ['apikey'] });

// Per-resource overlay — DataAdapter ready for defineResource. Async (reads BA's resolved schema once at boot).
const orgAdapter    = await createBetterAuthOverlay({ auth, mongoose, collection: 'organization' });
const apiKeyAdapter = await createBetterAuthOverlay({ auth, mongoose, collection: 'apikey' });

// Sqlitekit is symmetric: { auth, db, collection } + additionalColumns instead of additionalFields.
```

**Multi-role members**: BA stores `member.role = "admin,recruiter,viewer"` (comma-separated string). Arc splits it into `scope.orgRoles = ['admin', 'recruiter', 'viewer']`; `requireOrgRole('admin')` matches. Filtering by exact `?role=admin` will NOT match — use `role[like]=admin`.

**API key flow**: client sends `x-api-key: ak_live_...` + `x-organization-id: org_abc` (header required because API-key sessions have no `activeOrganizationId`). Arc adds `apiKeyAuth` to OpenAPI security only when the plugin is active.

**Bearer plugin** (`bearer()` from `better-auth/plugins`): SPA / mobile clients use `Authorization: Bearer <session>` instead of cookies — same `auth.api.getSession()` path, no arc config change. Enable both for hybrid apps.

Full overlay recipes (Tier 1 hand-roll vs Tier 2 factory), plugin matrix, `registerBetterAuthStubs` options, multi-plugin merge, write path, and CLI scaffolding flags → [references/auth.md](references/auth.md). Live end-to-end smoke: [`playground/better-auth/mongo/`](../../playground/better-auth/mongo/) · [`playground/better-auth/sqlite/`](../../playground/better-auth/sqlite/).

## Permissions

A `PermissionCheck` returns `boolean | { granted, reason?, filters?, scope? }`. `filters` propagate into the repo query (row-level ABAC). `scope` stamps attributes downstream.

```typescript
import {
  allowPublic, requireAuth, requireRoles, requireOwnership,
  requireOrgMembership, requireOrgRole, requireTeamMembership,
  requireServiceScope,           // OAuth-style API-key scopes
  requireScopeContext,           // app-defined dimensions (branch, project, region)
  requireOrgInScope,             // parent-child org hierarchy
  allOf, anyOf, when, denyAll,
  createDynamicPermissionMatrix, // DB-managed ACL
} from '@classytic/arc';

permissions: {
  list: allowPublic(),
  create: requireRoles(['admin', 'editor']),
  update: anyOf(requireOwnership('userId'), requireRoles(['admin'])),
  delete: allOf(requireAuth(), requireRoles(['admin'])),

  // Mixed human + machine
  bulkImport: anyOf(requireOrgRole('admin'), requireServiceScope('jobs:bulk-write')),
}
```

**Custom check:**

```typescript
const requirePro = (): PermissionCheck => async (ctx) => {
  if (!ctx.user) return { granted: false, reason: 'Auth required' };
  return { granted: ctx.user.plan === 'pro' };
};
```

**Field-level:**

```typescript
import { fields } from '@classytic/arc';
fields: {
  password: fields.hidden(),
  salary: fields.visibleTo(['admin', 'hr']),
  role: fields.writableBy(['admin']),
  email: fields.redactFor(['viewer'], '***'),
}
```

**Dynamic ACL (DB-backed):**

```typescript
const acl = createDynamicPermissionMatrix({
  resolveRolePermissions: async (ctx) => aclService.getRoleMatrix(ctx.user.orgId),
  cacheStore: new RedisCacheStore({ client: redis, prefix: 'acl:' }),
});
permissions: { list: acl.canAction('product', 'read') }
```

`requireRoles()` checks BOTH platform roles (`user.role`) and org roles (`scope.orgRoles`). `requireOrgRole()` is human-only — use `anyOf(requireOrgRole(...), requireServiceScope(...))` for mixed routes.

### RequestScope — the auth context

Five kinds, populated by your auth function. **Always read via accessors from `@classytic/arc/scope`, never direct property access.**

```typescript
type RequestScope =
  | { kind: 'public' }
  | { kind: 'authenticated'; userId?; userRoles? }
  | { kind: 'member';   userId?; userRoles; organizationId; orgRoles; teamId?; context?; ancestorOrgIds? }
  | { kind: 'service';  clientId; organizationId; scopes?; context?; ancestorOrgIds? }
  | { kind: 'elevated'; userId?; organizationId?; elevatedBy; context?; ancestorOrgIds? };
```

| Helper | `member` | `service` | `elevated` |
|---|---|---|---|
| `requireOrgMembership()` | ✅ | ✅ | ✅ |
| `requireOrgRole(roles)` | role match | ❌ deny | ✅ bypass |
| `requireServiceScope(scopes)` | ❌ | scope match | ✅ bypass |
| `requireScopeContext(...)` | key match | key match | ✅ bypass |
| `requireTeamMembership()` | `teamId` set | n/a | ✅ bypass |
| `requireOrgInScope(target)` | target in chain | target in chain | ✅ bypass |

```typescript
import {
  isMember, isService, isElevated, hasOrgAccess,
  getOrgId, getUserId, getUserRoles, getOrgRoles, getServiceScopes,
  getScopeContext, getAncestorOrgIds, isOrgInScope,
} from '@classytic/arc/scope';

if (hasOrgAccess(scope))                               // member | service | elevated
const branch = getScopeContext(scope, 'branchId');
isOrgInScope(scope, 'acme-holding');                   // pure predicate (no elevated bypass)
```

### Multi-level tenancy + parent-child org hierarchy

Populate `scope.context` and `scope.ancestorOrgIds` in your auth function (arc takes no position on the source — load from headers / JWT / BA session / your org table):

```typescript
authFn: async (request) => {
  const session = await myAuth.getSession(request);
  const ancestors = await orgRepo.findAncestors(session.orgId);   // closest-first
  request.scope = {
    kind: 'member',
    userId: session.userId,
    userRoles: session.userRoles,
    organizationId: session.orgId,
    orgRoles: session.orgRoles,
    context: { branchId: request.headers['x-branch-id'], projectId: request.headers['x-project-id'] },
    ancestorOrgIds: ancestors.map(a => a.id),   // ['acme-eu', 'acme-holding']
  };
}

// Gate routes by context dimensions / org hierarchy
permissions: {
  branchAdmin: allOf(requireOrgRole('admin'), requireScopeContext('branchId')),
  euOnly: requireScopeContext('region', 'eu'),
  list: requireOrgInScope((ctx) => ctx.request.params.orgId),
}

// Auto-filter resource queries across all dimensions
defineResource({
  name: 'job',
  presets: [multiTenantPreset({
    tenantFields: [
      { field: 'organizationId', type: 'org' },
      { field: 'branchId', contextKey: 'branchId' },
      { field: 'projectId', contextKey: 'projectId' },
    ],
  })],
});
```

Fail-closed: missing dimensions → 403 with the specific missing field name. **No automatic ancestor inheritance** — sibling subsidiaries don't see each other's data naturally.

Full multi-tenancy guide → [references/multi-tenancy.md](references/multi-tenancy.md).

## fieldRules — OpenAPI + AJV in one place

| Flag | Effect |
|---|---|
| `systemManaged` | Strip from body, drop from `required[]`. Framework stamps the value. |
| `preserveForElevated` | Elevated admins keep the field on ingest (cross-tenant writes). |
| `immutable` / `immutableAfterCreate` | Omit from update body. |
| `optional` | Strip from `required[]` without touching `properties`. |
| `nullable` | Widen JSON-Schema `type` to include null. |
| `hidden` | Block from response projection + OpenAPI. |
| `minLength` / `maxLength` / `min` / `max` / `pattern` / `enum` | Map to AJV + OpenAPI. |
| `description` | OpenAPI `description`. |

Mongoose model-level constraints take precedence; `fieldRules` supplements what the model doesn't declare.

## routeGuards + defineGuard

Apply guards to **every** route on a resource:

```typescript
import { defineGuard } from '@classytic/arc/utils';

// Typed guard — resolve once, extract anywhere
const orgGuard = defineGuard({
  name: 'org',
  resolve: (req) => {
    const orgId = req.headers['x-org-id'] as string;
    if (!orgId) throw new Error('Missing x-org-id');
    return { orgId, actorId: req.user?.id ?? 'system' };
  },
});

defineResource({
  name: 'procurement',
  routeGuards: [orgGuard.preHandler],
  routes: [{
    method: 'GET', path: '/summary', raw: true, permissions: requireAuth(),
    handler: async (req, reply) => {
      const { orgId } = orgGuard.from(req);     // typed, no re-computation
      reply.send({ orgId });
    },
  }],
});
```

**Order:** auth → permissions → cache/idempotency → `routeGuards` → per-route `preHandler`.

## Presets

| Preset | Routes added | Config |
|---|---|---|
| `softDelete` | `GET /deleted`, `POST /:id/restore` | `{ deletedField }` |
| `slugLookup` | `GET /slug/:slug` | `{ slugField }` |
| `tree` | `GET /tree`, `GET /:parent/children` | `{ parentField }` |
| `ownedByUser` | none (middleware) | `{ ownerField }` |
| `multiTenant` | none (middleware) | `{ tenantField }` OR `{ tenantFields: TenantFieldSpec[] }` |
| `audited` | none (middleware) | — |
| `bulk` | `POST/PATCH/DELETE /bulk` | `{ operations?, maxCreateItems? }` |
| `filesUpload` | `POST /upload`, `GET /:id`, `DELETE /:id` | `{ storage, sanitizeFilename?, allowedMimeTypes?, maxFileSize? }` |
| `search` | `POST /search`, `/search-similar`, `/embed` | `{ repository?, search?, similar?, embed?, routes? }` |

```typescript
presets: ['softDelete', { name: 'multiTenant', tenantField: 'organizationId' }]
```

### tenantField — when to use, when to disable

Default `'organizationId'` silently scopes queries to the caller's org. Correct for per-org resources, **wrong** for company-wide:

```typescript
defineResource({ name: 'invoice' });                                // → { organizationId: scope.orgId }
defineResource({ name: 'account-type', tenantField: false });       // company-wide lookup
defineResource({ name: 'workspace-item', tenantField: 'workspaceId' });
```

Use `tenantField: false` for lookup tables, platform settings, cross-org reports, single-tenant apps. **2.12 auto-inference:** if the Mongoose model has no `organizationId` path (and no other tenant field is configured), arc auto-infers `tenantField: false` instead of generating queries that filter on a non-existent column.

### idField — custom primary key

Default `'_id'`. Override for business identifiers (UUID, slug, `ORD-2026-0001`):

```typescript
defineResource({ name: 'job', adapter, idField: 'jobId' });
// GET /jobs/job-5219f346-a4d → controller queries { jobId: 'job-5219f346-a4d' }
```

Auto-derived from `repository.idField` if your kit declares one. URL segment is **always** `:id` and `req.params.id` is **always** named `id` — `idField` controls the *lookup field*, not the URL parameter (Stripe / GitHub convention).

**404 confusion pattern.** A 404 on `PATCH /agents/sadman` when `GET /agents/sadman` works isn't usually an `idField` bug — check whether your update permission returns `filters`. Arc merges those into the lookup (`{ slug: 'sadman', ...filters }`); an excluding filter returns null.

### searchPreset (text + vector + embed)

Backend-agnostic for Elasticsearch / OpenSearch / Algolia / Typesense / Atlas `$vectorSearch` / Pinecone / Qdrant.

```typescript
import { searchPreset } from '@classytic/arc/presets/search';

// A — auto-wire from a repo with search/searchSimilar/embed methods
searchPreset({ repository: productRepo, search: true, similar: true })

// B — external backends
searchPreset({
  search: {
    path: '/full-text',
    schema: { body: z.object({ q: z.string().min(1) }) },
    handler: (req) => elastic.search({ index: 'products', q: req.body.q }),
  },
  similar: { handler: (req) => pinecone.query({ vector: req.body.vector, topK: 10 }), mcp: false },
})
```

Defaults: search/similar inherit `list` perms → `allowPublic()`. Embed → `requireAuth()`. Zod v4 schemas auto-convert. MCP tools namespaced as `{op}_{resource}`.

## Adapters

In arc 2.12 the cross-framework adapter contract lives in `@classytic/repo-core/adapter`. Every kit-specific adapter ships from its kit's `/adapter` subpath; arc has zero kit-bound adapters in `src/`.

```typescript
// Mongoose — from mongokit
import { createMongooseAdapter } from '@classytic/mongokit/adapter';
import { buildCrudSchemasFromModel } from '@classytic/mongokit';

const adapter = createMongooseAdapter({
  model: ProductModel,
  repository: productRepo,
  schemaGenerator: buildCrudSchemasFromModel,    // no cast needed
});

// Drizzle — from sqlitekit
import { createDrizzleAdapter } from '@classytic/sqlitekit/adapter';
import { buildCrudSchemasFromTable } from '@classytic/sqlitekit';

createDrizzleAdapter({ table, repository, schemaGenerator: buildCrudSchemasFromTable });

// Prisma — from prismakit
import { createPrismaAdapter } from '@classytic/prismakit/adapter';
```

Custom kits implementing `DataAdapter<TDoc>` from `@classytic/repo-core/adapter` plug in identically. Kit factories accept `AdapterRepositoryInput<TDoc>` — kit-native repos plug in **without** `as RepositoryLike` casts.

**Custom adapter** — implement `DataAdapter` / `MinimalRepo` from `@classytic/repo-core/adapter`:

```typescript
import type {
  DataAdapter, RepositoryLike, AdapterRepositoryInput,
} from '@classytic/repo-core/adapter';
import type { MinimalRepo } from '@classytic/repo-core/repository';
// MinimalRepo<TDoc>  = 5-method floor (getAll, getById, create, update, delete)
// StandardRepo<TDoc> = MinimalRepo + optional batch ops, CAS, soft-delete, …
// Arc feature-detects optional methods at call sites.
```

## Controllers

`BaseController` is mixin-composed; declaration-merged interfaces thread `TDoc` through every CRUD + preset method.

```typescript
import { BaseController } from '@classytic/arc';
import type { IRequestContext, IControllerResponse } from '@classytic/arc';

class ProductController extends BaseController<Product> {
  // When you pass your own controller, arc CANNOT thread tenantField /
  // schemaOptions / idField / cache / onFieldWriteDenied into it. Forward
  // them via super() and pass them to defineResource() too:
  constructor(opts: { tenantField?: string | false; idField?: string } = {}) {
    super(productRepo, { resourceName: 'product', ...opts });
  }

  async getFeatured(req: IRequestContext): Promise<IControllerResponse<Product[]>> {
    const products = await this.repository.getAll({ filters: { isFeatured: true } });
    return { data: products };
  }
}

defineResource({ name: 'product', controller: new ProductController({ tenantField: '_id' }), tenantField: '_id' });
```

Presets that inject controller fields (slugLookup → slugField, softDelete, tree) only reach arc's auto-built `BaseController`. With a custom controller + such a preset, drop the preset OR extend `BaseController` so arc auto-builds it.

**Slim CRUD-only base** (no soft-delete/tree/slug/bulk):

```typescript
import { BaseCrudController, SoftDeleteMixin, BulkMixin } from '@classytic/arc';
class ReportController extends BaseCrudController<Report> {}
class OrderController extends SoftDeleteMixin(BulkMixin(BaseCrudController)) {}
```

Mixin surface: `SoftDeleteMixin` · `TreeMixin` · `SlugMixin` · `BulkMixin`. Protected helpers on `BaseCrudController`: `meta(req)`, `getHooks(req)`, `tenantRepoOptions(req)`, `resolveRepoId(id, existing)`, `notFoundResponse(reason)`, `resolveCacheConfig(op)`, `cacheScope(req)`.

`IRequestContext` = `{ params, query, body, user, headers, context, metadata, server }`.
`IControllerResponse` = `{ success, data?, error?, status?, meta?, headers? }`.

## Hooks

Inline on resource — `ResourceHookContext` = `{ data, user?, meta? }`; `meta` has `id` and `existing` for update/delete:

```typescript
defineResource({
  name: 'chat',
  hooks: {
    beforeCreate: async (ctx) => { ctx.data.slug = slugify(ctx.data.name); },
    afterCreate: async (ctx) => { analytics.track('created', { id: ctx.data._id }); },
    beforeUpdate: async (ctx) => { /* ctx.meta.existing has the pre-image */ },
    afterUpdate: async (ctx) => { await invalidateCache(ctx.data._id); },
    beforeDelete: async (ctx) => { if (ctx.data.isProtected) throw new Error('Cannot delete'); },
    afterDelete: async (ctx) => { await cleanupFiles(ctx.meta?.id); },
  },
});
```

App-level (cross-resource):

```typescript
import { createHookSystem, beforeCreate, afterUpdate } from '@classytic/arc/hooks';

const hooks = createHookSystem();
beforeCreate(hooks, 'product', async (ctx) => { ctx.data.slug = slugify(ctx.data.name); });
afterUpdate(hooks, 'product', async (ctx) => { await invalidateCache(ctx.result._id); });
```

## Pipeline

```typescript
import { guard, transform, intercept } from '@classytic/arc/pipeline';

defineResource({
  pipe: {
    create: [
      guard('verified', async (ctx) => ctx.user?.verified === true),
      transform('inject', async (ctx) => { ctx.body.createdBy = ctx.user._id; }),
    ],
  },
});
```

## Query parsing

Default parser handles filters, sort, select, populate, pagination.

```
GET /products?page=2&limit=20&sort=-createdAt&select=name,price
GET /products?price[gte]=100&status[in]=active,featured&search=keyword
GET /products?after=<cursor_id>&limit=20                            # keyset pagination
GET /products?populate=category
GET /products?populate[category][select]=name,slug
GET /products?populate[category][match][isActive]=true
```

Operators: `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `in`, `nin`, `like`, `regex`, `exists`.

**MongoKit `$lookup` joins:**

```
GET /products?lookup[cat][from]=categories&lookup[cat][localField]=categorySlug&lookup[cat][foreignField]=slug&lookup[cat][single]=true
```

**Custom parser (whitelists, MCP auto-derive):**

```typescript
import { QueryParser } from '@classytic/mongokit';

defineResource({
  name: 'product',
  adapter,
  queryParser: new QueryParser({
    allowedFilterFields: ['status', 'category', 'orgId'],
    allowedSortFields: ['createdAt', 'price'],
    allowedOperators: ['eq', 'gte', 'lte', 'in'],
  }),
  schemaOptions: {
    query: { allowedPopulate: ['category', 'brand'], allowedLookups: ['categories', 'brands'] },
  },
});
```

MCP auto-derives `filterableFields` from `queryParser`.

## QueryCache

TanStack Query-style server cache, stale-while-revalidate, auto-invalidation on mutations.

```typescript
const app = await createApp({ arcPlugins: { queryCache: true } });

defineResource({
  name: 'product',
  cache: {
    staleTime: 30,
    gcTime: 300,
    tags: ['catalog'],
    invalidateOn: { 'category.*': ['catalog'] },     // event pattern → tag targets
    list: { staleTime: 60 },                          // per-operation override
    byId: { staleTime: 10 },
  },
});
```

POST/PATCH/DELETE bumps resource version. Modes: `memory` (default) | `distributed` (requires `stores.queryCache: RedisCacheStore`). Response header: `x-cache: HIT | STALE | MISS`.

## Events

`createApp` auto-registers `eventPlugin` (default: `MemoryEventTransport`).

```typescript
const app = await createApp({
  stores: { events: new RedisEventTransport(redis) },     // optional
  arcPlugins: { events: { logEvents: true, retry: { maxRetries: 3, backoffMs: 1000 } } },
});

await app.events.publish('order.created', { orderId: '123' });
await app.events.subscribe('order.*', async (event) => { ... });
```

CRUD events auto-emit: `{resource}.created` / `{resource}.updated` / `{resource}.deleted`.

**Transports:** Memory · Redis Pub/Sub (fire-and-forget) · Redis Streams (durable, at-least-once, consumer groups, DLQ).

**EventMeta:** `id`, `timestamp`, optional `schemaVersion`, `correlationId`, `causationId`, `partitionKey`, `source`, `idempotencyKey`, `resource`, `resourceId`, `userId`, `organizationId`, `aggregate: { type, id }`. Import event types from `@classytic/primitives/events` (`EventMeta`, `DomainEvent`, `EventHandler`, `EventTransport`, `DeadLetteredEvent`, `PublishManyResult`, `createEvent`, `createChildEvent`, `matchEventPattern`); arc re-exports the runtime `MemoryEventTransport` only. Use `createChildEvent(parent, ...)` to inherit correlation/causation/source/idempotencyKey.

Calling both `app.events.publish('order.placed', ...)` *and* a notification helper that internally publishes the same logical event triggers a one-shot dev-mode warning ("dual-publish"). Pick one path: manual publish OR `eventStrategy: 'auto'`.

**Event Outbox** — at-least-once via transactional outbox. Production: `new EventOutbox({ repository: outboxRepo, transport })` (multi-worker claim, session-threaded writes). Dev: `new EventOutbox({ store: new MemoryOutboxStore(), transport })`. `EventOutbox.store()` auto-maps `meta.idempotencyKey` → `dedupeKey`. `failurePolicy` centralises retry/DLQ.

Full event recipes → [references/events.md](references/events.md).

## Errors

```typescript
import { ArcError, NotFoundError, ValidationError, createDomainError } from '@classytic/arc';

throw new NotFoundError('Product not found');                                       // 404
throw createDomainError('SELF_REFERRAL', 'Cannot self-refer', 422, { field: 'referralCode' });
```

Resolution: `ArcError` → `.statusCode` (Fastify) → `.status` (MongoKit, http-errors) → user `errorMap` → Mongoose/MongoDB → 500. Any error with `.status` or `.statusCode` gets the correct HTTP response.

`ArcError` implements the `HttpError` throwable contract from `@classytic/repo-core/errors` (`status` getter mirrors `statusCode`, `meta` getter mirrors `details`). Wire envelope: `{ code, message, status, meta?, correlationId? }` — HTTP status code is the success/error discriminator, no redundant `success` field. For non-Arc errors, `toErrorContract(err)` (from `@classytic/repo-core/errors`) serialises any `HttpError` to the canonical `ErrorContract` wire shape; `statusToErrorCode(status)` maps numeric status to canonical `ErrorCode`.

**Class-based mappers:**

```typescript
const app = await createApp({
  errorHandler: {
    errorMappers: [{
      type: AccountingError,
      toResponse: (err) => ({ status: err.status, code: err.code, message: err.message }),
    }],
  },
});
```

## Compensating transaction

In-process rollback for multi-step operations (not a distributed saga — use Temporal / Streamline for that):

```typescript
import { withCompensation } from '@classytic/arc/utils';

const result = await withCompensation('checkout', [
  { name: 'reserve', execute: reserveStock, compensate: releaseStock },
  { name: 'charge', execute: chargeCard, compensate: refundCard },
  { name: 'notify', execute: sendEmail, fireAndForget: true },
], { orderId });
// result: { success, completedSteps, results, failedStep?, error?, compensationErrors? }
```

## Testing

```typescript
import { createTestApp, expectArc } from '@classytic/arc/testing';

const ctx = await createTestApp({
  resources: [productResource],
  authMode: 'jwt',                  // 'jwt' | 'better-auth' | 'none'
  connectMongoose: true,            // in-memory Mongo + Mongoose connect
});
ctx.auth.register('admin', { user: { id: '1', role: 'admin' }, orgId: 'org-1' });

const res = await ctx.app.inject({
  method: 'POST', url: '/products',
  headers: ctx.auth.as('admin').headers,
  payload: { name: 'Widget' },
});
expectArc(res).ok().hidesField('password');

await ctx.close();
```

Three entry points: `createTestApp` (custom scenarios), `createHttpTestHarness` (~16 auto-generated CRUD/permission/validation tests per resource), `runStorageContract` (adapter conformance).

Full testing recipes → [references/testing.md](references/testing.md).

## CLI

```bash
arc init my-api --mongokit --jwt --ts          # scaffold (also: --custom, --better-auth, --multi)
arc generate resource product                   # generate a resource
arc generate resource product --mcp             # + MCP tools file
arc generate mcp analytics                      # standalone MCP tools file
arc docs ./openapi.json --entry ./dist/index.js # emit OpenAPI
arc introspect --entry ./dist/index.js
arc doctor
```

Set `"mcp": true` in `.arcrc` to always generate `.mcp.ts` alongside resources.

## MCP (AI agent tools)

Resources auto-generate Model Context Protocol tools — same permissions, same field rules. Stateless by default (fresh server per request, scalable).

```typescript
import { mcpPlugin } from '@classytic/arc/mcp';

await app.register(mcpPlugin, {
  resources: [productResource, orderResource],
  auth: false,                              // or: getAuth() | custom function
  exclude: ['credential'],
  overrides: { product: { operations: ['list', 'get'] } },
});

// Stateful — when you need server-initiated messages
await app.register(mcpPlugin, { resources, stateful: true, sessionTtlMs: 600000 });
```

Connect Claude CLI: `claude mcp add --transport http my-api http://localhost:3000/mcp`.

**Auth modes** — `false` | `getAuth()` (Better Auth OAuth 2.1) | custom function:

```typescript
// Human user
auth: async (headers) => {
  if (headers['x-api-key'] !== process.env.MCP_KEY) return null;
  return { userId: 'bot', organizationId: 'org-1', roles: ['admin'] };
},

// Service / machine — produces kind: "service" scope
auth: async (headers) => ({
  clientId: 'ingestion-pipeline',
  organizationId: 'org-1',
  scopes: ['read:products', 'write:events'],
}),
```

`auth: false` → `ctx.user` null, `scope.kind: "public"`. `clientId` set → `kind: "service"` works with `requireServiceScope()`. `PermissionResult.filters` flow into MCP tools — same as REST.

**Custom tools** — co-locate with resources (`order.mcp.ts`), wire via `extraTools: [fulfillOrderTool]`. Generate: `arc generate resource order --mcp`.

**AI SDK bridge** — expose AI SDK `tool()` definitions over MCP without duplicating glue:

```typescript
import { buildMcpToolsFromBridges, getUserId, hasOrg, type McpBridge } from '@classytic/arc/mcp';

export const triggerJobBridge: McpBridge = {
  name: 'trigger_job',
  description: 'Start a job.',
  inputSchema: { phase: z.enum(['investigate', 'fix']) },
  annotations: { destructiveHint: true },
  buildTool: (ctx) => buildTriggerJobTool(getUserId(ctx) ?? ''),
  guard: (ctx) => (hasOrg(ctx) ? null : 'Organization scope required'),
};

await app.register(mcpPlugin, {
  resources,
  extraTools: buildMcpToolsFromBridges([triggerJobBridge]),
});
```

Full MCP recipes → [references/mcp.md](references/mcp.md).

## Audit per-resource opt-in

```typescript
await fastify.register(auditPlugin, { autoAudit: { perResource: true } });

defineResource({ name: 'order', audit: true });
defineResource({ name: 'payment', audit: { operations: ['delete'] } });
defineResource({ name: 'product' });   // not audited

// Manual custom() for MCP tools / read auditing
app.post('/orders/:id/refund', async (req) => {
  await app.audit.custom('order', req.params.id, 'refund', { reason }, { user });
});
```

## DX helpers

```typescript
import type { ArcRequest } from '@classytic/arc';
import { envelope, createDomainError } from '@classytic/arc';
import { getOrgContext } from '@classytic/arc/scope';
import { roles } from '@classytic/arc/permissions';

// Typed request for raw routes — no `(req as any).user`
handler: async (req: ArcRequest, reply) => { req.user?.id; req.scope; req.signal; }

// Response envelope
reply.send(envelope(data, { total: 100 }));

// Canonical org extraction
const { userId, organizationId, roles: userRoles, orgRoles } = getOrgContext(request);

// Unified role check — platform AND org roles
permissions: { create: roles('admin', 'editor'), delete: roles('admin') }
```

**Reply helpers** — opt-in via `createApp({ replyHelpers: true })`. Arc has no `{ success, data }` envelope: HTTP status discriminates, single-doc handlers `return doc` or `reply.send(doc)`, errors throw `ArcError` (the global handler serialises to `ErrorContract`). The two decorators cover the cases that DO need framework support:

```typescript
return reply.sendList({ method: 'offset', data, total, page, limit, pages, hasNext, hasPrev });
return reply.sendList(canonicalListResult);                   // any kit-shaped paginated/array result
return reply.stream(csvReadable, { contentType: 'text/csv', filename: 'export.csv' });
```

`reply.sendList()` accepts a bare `T[]` or any kit pagination result (`OffsetPaginationResult` / `KeysetPaginationResult` / `AggregatePaginationResult`) and routes through `toCanonicalList` from `@classytic/repo-core/pagination` so the server and the typed `@classytic/arc-next` client share one declaration — `method` as the discriminant cannot drift between them.

**BigInt serialization** — `createApp({ serializeBigInt: true })` converts BigInt → Number in JSON.

**Multipart body middleware** — opt-in file upload (no-op for JSON requests, safe to always add):

```typescript
import { multipartBody } from '@classytic/arc/middleware';

defineResource({
  name: 'product',
  middlewares: { create: [multipartBody({ allowedMimeTypes: ['image/png'], maxFileSize: 5 * 1024 * 1024 })] },
  hooks: {
    'before:create': async (data) => {
      if (data._files?.image) { data.imageUrl = await uploadToS3(data._files.image); delete data._files; }
      return data;
    },
  },
});
```

**SSE auth + streaming** — `preAuth` runs before auth (EventSource can't set headers); `raw: true` streams the response:

```typescript
routes: [
  { preAuth: [(req) => { req.headers.authorization = `Bearer ${req.query.token}`; }] },
  { method: 'GET', path: '/stream', raw: true, handler: async (req, reply) => reply.send(stream) },
]
```

**Per-resource opt-out of `resourcePrefix`** — for webhooks, admin routes:

```typescript
defineResource({ name: 'webhook', prefix: '/hooks', skipGlobalPrefix: true })
// Registers at /hooks even with createApp({ resourcePrefix: '/api/v1' })
```

## Enterprise auth (2.13)

Three opt-in surfaces close the procurement-gate gaps without forcing parallel infrastructure. Sessions / refresh / OAuth flows stay in Better Auth's hands.

### SCIM 2.0 — IdP provisioning (`@classytic/arc/scim`)

Auto-derived `/scim/v2/Users` + `/scim/v2/Groups` from existing arc resources. Okta / Azure AD / Google Workspace / JumpCloud / OneLogin out of the box. No shadow tables.

```typescript
import { scimPlugin } from '@classytic/arc/scim';

await app.register(scimPlugin, {
  users: { resource: userResource },
  groups: { resource: orgResource },
  bearer: process.env.SCIM_TOKEN,        // or: verify: async (req) => …
});
```

Mounts `GET/POST/PUT/PATCH/DELETE /scim/v2/Users[/:id]`, same for `Groups`, plus `ServiceProviderConfig` / `ResourceTypes` / `Schemas` discovery. SCIM filter language → arc query DSL. RFC 7644 PatchOp translates to canonical operators (`$set`/`$unset`/`$push`/`$pull`) and flows through `repo.findOneAndUpdate(...)`; PUT goes through `repo.bulkWrite([{ replaceOne }])`. SCIM does **not** run arc's HTTP controller pipeline — audit / multi-tenant / field-policy compose at the kit-plugin layer (`repo.use(...)`) and fire identically for arc REST + SCIM because both surfaces hit the same repository methods. → [references/scim.md](references/scim.md).

### Agent-auth helpers — DPoP + capability mandates

For AI-agent flows on protected resources (AP2 / Stripe x402 / MCP authorization). Three new helpers in `@classytic/arc/permissions`:

```typescript
import { requireAgentScope, requireMandate, requireDPoP } from '@classytic/arc/permissions';

defineResource({
  name: 'invoice',
  actions: {
    pay: {
      handler: payInvoice,
      permissions: requireAgentScope({
        capability: 'payment.charge',
        scopes: ['payment.write'],
        requireDPoP: true,                                  // RFC 9449 sender-constrained
        audience: (ctx) => `invoice:${ctx.params?.id}`,    // mandate must bind to this resource
        validateAmount: (ctx, m) => (ctx.data as { amount: number }).amount <= (m.cap ?? 0),
      }),
    },
  },
});
```

`RequestScope.service` gains optional `mandate` + `dpopJkt` fields. Your `authenticate` callback verifies the mandate JWT (one `jose.jwtVerify()` call) + DPoP proof (one `jose.dpop.verify()` call) and populates them. Arc validates *what's already proved* against the action — no peer-deps on `jose`. → [references/agent-auth.md](references/agent-auth.md).

### Auth-event audit bridge (`@classytic/arc/auth/audit`)

BA's `databaseHooks` + endpoint hooks routed through the existing `auditPlugin` — one canonical row shape for resource AND auth events. Single query for "everything user X did".

```typescript
import { wireBetterAuthAudit } from '@classytic/arc/auth/audit';

const audit = wireBetterAuthAudit({
  events: ['session.*', 'user.*', 'mfa.*', 'org.invite.*'],
});

const auth = betterAuth({
  hooks: audit.hooks,                  // endpoint hooks (MFA, OAuth, password reset)
  databaseHooks: audit.databaseHooks,  // sign-in/up/out via session.create/delete
  // ...
});

const app = await createApp({ ... });
audit.attach(app);                      // drains boot-time buffer + connects live logger
```

Buffered until `attach(app)` is called — works for hosts that build BA before Fastify. Manual `audit.emit({ name, subjectId, ... })` for non-BA flows (webhook signature failures, custom MFA).

### What's NOT in arc 2.13

SAML / SCIM-EnterpriseUser / device trust / SOC2 attestations / session storage. Reasons + workarounds → [references/enterprise-auth.md](references/enterprise-auth.md). Compliance control matrix → [`docs/compliance/{soc2,hipaa}.md`](../../docs/compliance/).

## Subpath imports

The most common imports — full enumeration in [references/api-reference.md](references/api-reference.md).

```typescript
import { defineResource, BaseController, allowPublic } from '@classytic/arc';
import { createApp, loadResources } from '@classytic/arc/factory';
import { createMongooseAdapter } from '@classytic/mongokit/adapter';     // or sqlitekit/adapter, prismakit/adapter
import type { DataAdapter, RepositoryLike } from '@classytic/repo-core/adapter';
import { getUserId, getOrgId, requireOrgId } from '@classytic/arc/scope';
import { mcpPlugin } from '@classytic/arc/mcp';
import { createTestApp, expectArc } from '@classytic/arc/testing';
```

## References

- **[api-reference](references/api-reference.md)** — full subpath import map (every plugin, helper, type)
- **[auth](references/auth.md)** — JWT, Better Auth, API key, custom auth
- **[scim](references/scim.md)** — SCIM 2.0 plugin (Okta / Azure AD / Google Workspace provisioning)
- **[agent-auth](references/agent-auth.md)** — DPoP + capability mandates (AP2 / x402 / MCP authorization)
- **[enterprise-auth](references/enterprise-auth.md)** — what's in vs out of the box for enterprise auth
- **[events](references/events.md)** — Domain events, transports, retry, outbox
- **[integrations](references/integrations.md)** — BullMQ jobs, WebSocket, EventGateway, Streamline, Webhooks
- **[mcp](references/mcp.md)** — MCP tools, custom tools, Better Auth OAuth 2.1
- **[multi-tenancy](references/multi-tenancy.md)** — Scope ladder, `tenantField`, `PermissionResult.scope`, API key auth
- **[production](references/production.md)** — Health, audit, idempotency, tracing, metrics, versioning, SSE, QueryCache, bulk ops
- **[testing](references/testing.md)** — Test app, mocks, data factories, in-memory MongoDB
