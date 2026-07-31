---
name: arc
description: |
  @classytic/arc — Resource-oriented backend framework for Fastify.
  Use when building REST APIs with Fastify, resource CRUD, defineResource, createApp,
  permissions, presets, database adapters, hooks, events, QueryCache, authentication,
  multi-tenant SaaS, OpenAPI, job queues, WebSocket, MCP tools, or production deployment.
  Triggers: arc, fastify resource, defineResource, createApp, BaseController, arc preset,
  arc auth, arc events, arc jobs, arc websocket, arc mcp, arc plugin, arc testing, arc cli,
  arc permissions, arc hooks, arc factory, arc cache.
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
---

# @classytic/arc

Resource-oriented backend framework for Fastify. **Fastify ≥5.8 · Node ≥22 · ESM only.**

One `defineResource()` call → REST + auth + permissions + events + cache + OpenAPI + MCP. Database-agnostic (Mongoose, Drizzle/sqlite, Prisma, custom).

## Install

```bash
# Scaffold
npx @classytic/arc@latest init my-api --mongokit --better-auth --single --ts

# Or add to an existing project
npm install @classytic/arc fastify
npm install @fastify/cors @fastify/helmet @fastify/rate-limit @fastify/sensible @fastify/under-pressure
npm install @classytic/mongokit mongoose                # or sqlitekit / prismakit / custom
```

`init` flags: `--mongokit | --custom`, `--better-auth | --jwt`, `--single | --multi`, `--ts | --js`, `--edge`, `--force`, `--skip-install`.

## Boot

```typescript
import { createApp, loadResources } from '@classytic/arc/factory';

const app = await createApp({
  preset: 'production',                         // production | development | testing | edge
  runtime: 'memory',                            // memory | distributed
  resourcePrefix: '/api/v1',
  auth: { type: 'jwt', jwt: { secret: process.env.JWT_SECRET } },
  cors: { origin: process.env.ALLOWED_ORIGINS!.split(','), credentials: true },
  resources: await loadResources(import.meta.url),    // auto-discovers *.resource.ts
  arcPlugins: { events: true, queryCache: false, sse: false, caching: true },
  stores: {                                     // required when runtime: 'distributed'
    events: new RedisEventTransport({ client: redis }),
    queryCache: new RedisCacheStore({ client: redis }),
  },
});

await app.listen({ port: 8040, host: '0.0.0.0' });
```

**Boot order (fixed):** `beforeBoot` → modules resolve → `plugins` → `bootstrap[]` → `resources` → `afterResources` → `onReady`.

`beforeBoot()` (2.21) runs before Fastify exists and before module thunks / resource files import — connect the DB there instead of dynamic-import ordering hacks.

For async-booted engines, pass `resources` as a factory so it runs after `bootstrap[]`:

```typescript
resources: async (fastify) => {
  const engine = await ensureCatalogEngine();
  return [buildProductResource(engine)];
}
```

`loadResources(import.meta.url)` resolves `src/` in dev and `dist/` in prod. Use `loadResources(import.meta.url, { context: { engine } })` to thread engine handles into `(ctx) => defineResource(...)` default exports. `{ filter: (absPath) => boolean }` (2.21) gates files BEFORE they're imported — feature-flag manifests become one callback.

## defineResource()

```typescript
import { defineResource, allowPublic, requireRoles, requireAuth } from '@classytic/arc';
import { createMongooseAdapter } from '@classytic/mongokit/adapter';

export default defineResource({
  name: 'product',
  // mongokit >=3.21 defaults schemaGenerator to buildCrudSchemasFromModel;
  // pass `schemaGenerator: false` to opt out.
  adapter: createMongooseAdapter({ model: ProductModel, repository: productRepo }),

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
      deletedAt: { systemManaged: true },         // framework stamps; strip from body
      priceMode: { nullable: true },              // accept null
      organizationId: { systemManaged: true, preserveForElevated: true },
    },
    query: {
      allowedPopulate: ['category', 'createdBy'],
      filterableFields: { status: { type: 'string' } },
    },
  },

  cache: { staleTime: 30, gcTime: 300, tags: ['catalog'] },

  routes: [
    { method: 'GET',  path: '/featured', handler: 'getFeatured', permissions: allowPublic() },
    { method: 'POST', path: '/webhook',  rawHandler: webhookFn, permissions: requireAuth() },
  ],
  actions: {
    approve: { handler: approveOrder, permissions: requireRoles(['admin']) },
  },
});
```

**Auto-generated:** `GET /`, `GET /:id`, `POST /`, `PATCH /:id`, `DELETE /:id`. Presets add their own routes (see table below).

### Custom routes: `handler` vs `rawHandler`

A route declares its execution model by WHICH FIELD it fills — there is no `raw` flag (removed in 2.31).

| Field | Signature | Behaviour |
|---|---|---|
| `handler` | `(ctx: IRequestContext)` or a controller-method name | Arc pipeline: envelope shaping, field-write permissions, MCP tool by default |
| `rawHandler` | `(request, reply)` or a controller-method name | Fastify-native: owns the response, no pipeline, no MCP unless `mcpHandler` is set |
| `controllerMethod` | `(c: MyController) => c.method` | Typed ref for the pipeline — TS catches typos |

Declaring both `handler` and `rawHandler` throws at boot. `streamResponse: true` requires `rawHandler` (the handler is invoked with `(request, reply)` and owns the socket).

Inline `rawHandler` parameters infer — no `req: FastifyRequest` annotation — and typed generics (`FastifyRequest<{ Body: CreateBody }>`) assign without a cast.

**Resource shorthands:**

```typescript
// "fetch-all" reference data — read-only crud (list+get), defaultLimit/maxLimit=1000,
// cache { staleTime: 300, gcTime: 600 }. Explicit narrow flags still win.
defineResource({ name: 'currency', adapter, referenceData: true });

// Service resource — no adapter, no auto-CRUD, no validation, no registry entry.
// Equivalent to disableDefaultRoutes + skipValidation + skipRegistry.
defineResource({ name: 'health', customRoutesOnly: true, routes: [...] });

// Resource-level pagination knobs (no custom queryParser needed):
defineResource({ name: 'pipeline', adapter, defaultLimit: 200, maxLimit: 500 });
```

400s on `?limit=` violations include the cap: `message: "Query parameter 'limit' must be <= 500 (got 800) (cap is 500)"` + `meta: { field: 'limit', cap: 500 }`.

## fieldRules

| Flag | Effect |
|---|---|
| `systemManaged` | Strip from body, drop from `required[]`. Framework stamps the value. |
| `preserveForElevated` | Elevated admins keep the field on ingest (cross-tenant writes). |
| `immutable` / `immutableAfterCreate` | Omit from update body. |
| `optional` | Strip from `required[]` without touching `properties`. |
| `nullable` | Widen JSON-Schema `type` to include null. |
| `hidden` | Block from response projection + OpenAPI. |
| `minLength` · `maxLength` · `min` · `max` · `pattern` · `enum` · `description` | Map to AJV + OpenAPI. |

Mongoose model constraints take precedence; `fieldRules` supplements what the model doesn't declare.

## Presets

| Preset | Routes added | Config |
|---|---|---|
| `softDelete` | `GET /deleted`, `POST /:id/restore` | `{ deletedField }` |
| `slugLookup` | `GET /slug/:slug` | `{ slugField }` |
| `tree` | `GET /tree`, `GET /:parent/children` | `{ parentField }` |
| `ownedByUser` | (middleware only) | `{ ownerField }` |
| `multiTenant` | (middleware only) | `{ tenantField }` or `{ tenantFields: [...] }` |
| `audited` | (middleware only) | — |
| `bulk` | `POST/PATCH/DELETE /bulk` | `{ operations?, maxCreateItems? }` |
| `filesUpload` | `POST /upload`, `GET /:id`, `DELETE /:id` | `{ storage, sanitizeFilename?, allowedMimeTypes?, maxFileSize? }` |
| `search` | `POST /search`, `/search-similar`, `/embed` | `{ repository?, search?, similar?, embed? }` |

```typescript
presets: ['softDelete', { name: 'multiTenant', tenantField: 'organizationId' }]
```

**`tenantField: false`** disables the silent org filter — use it for lookup tables, platform settings, cross-org reports.

**`idField`** picks the lookup column for `:id` (default `_id`). URL segment is always `:id`. A 404 on `PATCH /agents/foo` when `GET` works is usually a permission `filters` clause excluding the row — not an `idField` bug.

## Permissions

A `PermissionCheck` returns `boolean | { granted, reason?, filters?, scope? }`. `filters` propagate into the repo query (row-level ABAC). `scope` stamps attributes downstream.

```typescript
import {
  allowPublic, requireAuth, requireRoles, requireOwnership,
  requireOrgMembership, requireOrgRole, requireTeamMembership,
  requireServiceScope, requireScopeContext, requireOrgInScope,
  allOf, anyOf, when, denyAll,
  createDynamicPermissionMatrix,
} from '@classytic/arc/permissions';

permissions: {
  list:   allowPublic(),
  create: requireRoles(['admin', 'editor']),
  update: anyOf(requireOwnership('userId'), requireRoles(['admin'])),
  delete: allOf(requireAuth(), requireRoles(['admin'])),
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
import { fields } from '@classytic/arc/permissions';
fields: {
  password: fields.hidden(),
  salary:   fields.visibleTo(['admin', 'hr']),
  role:     fields.writableBy(['admin']),
  email:    fields.redactFor(['viewer'], '***'),
}
```

**Dynamic ACL (DB-backed):**

```typescript
const acl = createDynamicPermissionMatrix({
  resolveRolePermissions: (ctx) => aclService.getRoleMatrix(ctx.user.orgId),
  cacheStore: new RedisCacheStore({ client: redis, prefix: 'acl:' }),
});
permissions: { list: acl.canAction('product', 'read') }
```

`requireRoles()` checks BOTH platform roles (`user.role`) and org roles (`scope.orgRoles`). For mixed human + machine routes, combine with `requireServiceScope(...)` via `anyOf(...)`.

## RequestScope

Five kinds, populated by your auth function. **Always read via accessors from `@classytic/arc/scope`** — never direct property access.

```typescript
type RequestScope =
  | { kind: 'public' }
  | { kind: 'authenticated'; userId?; userRoles? }
  | { kind: 'member';        userId?; userRoles; organizationId; orgRoles; teamId?; context?; ancestorOrgIds? }
  | { kind: 'service';       clientId;  organizationId; scopes?; context?; ancestorOrgIds?; mandate?; dpopJkt? }
  | { kind: 'elevated';      userId?;   organizationId?; elevatedBy; context?; ancestorOrgIds? };

import {
  isMember, isService, isElevated, hasOrgAccess,
  getOrgId, getUserId, getUserRoles, getOrgRoles, getServiceScopes,
  getScopeContext, getAncestorOrgIds, isOrgInScope,
  requireOrgId, requireUserId,           // throwing accessors for handler boundaries
} from '@classytic/arc/scope';
```

| Helper | `member` | `service` | `elevated` |
|---|---|---|---|
| `requireOrgMembership()` | ✅ | ✅ | ✅ |
| `requireOrgRole(roles)` | role match | ❌ | bypass |
| `requireServiceScope(scopes)` | ❌ | scope match | bypass |
| `requireTeamMembership()` | `teamId` set | n/a | bypass |
| `requireOrgInScope(target)` | target in chain | target in chain | bypass |

Populate `scope.context` / `scope.ancestorOrgIds` in your auth function for branch/region scoping and parent-child org chains. Then `multiTenantPreset({ tenantFields: [...] })` auto-filters by every dimension. → [references/multi-tenancy.md](references/multi-tenancy.md)

## Authentication

Discriminated union on `type`:

```typescript
auth: { type: 'jwt', jwt: { secret, expiresIn: '15m' } }                   // arc JWT
auth: { type: 'betterAuth', betterAuth: createBetterAuthAdapter({ auth }) } // Better Auth
auth: { type: 'custom', plugin: myAuthPlugin }                              // any Fastify plugin
auth: { type: 'authenticator', authenticate: async (req, reply) => { … } }  // ad-hoc fn
auth: false                                                                 // internal services
```

Decorates `app.authenticate` / `app.optionalAuthenticate` / `app.authorize`.

**Better Auth** is arc's recommended path for SaaS with orgs. Kit overlays read whatever BA plugins you enabled (`organization`, `twoFactor`, `admin`, `bearer`, `apiKey` from `@better-auth/api-key`). Bulk-stub populate models with `registerBetterAuthStubs(mongoose, { plugins, extraCollections })`; per-resource overlay with `createBetterAuthOverlay({ auth, mongoose, collection })`. Sqlitekit is symmetric. Full recipes (multi-plugin matrix, API-key flow, write path) → [references/auth.md](references/auth.md).

## Authoritative gotchas

- **Field-write reject (default).** Requests carrying non-writable fields → 403 with denied list. Opt into silent strip: `defineResource({ onFieldWriteDenied: 'strip' })`.
- **multiTenant injects org on UPDATE.** Body `organizationId` is overwritten with caller's scope (closes tenant-hop).
- **`request.user`** is `Record<string, unknown> | undefined`. Guard with `if (req.user)` on public routes.
- **Arc reads singular `user.role`** (string, comma-separated, or array). Don't put a plural `roles` field on the model.
- **`verifySignature(body, …)`** throws on parsed body — pass `req.rawBody`.
- **MCP tools fail-closed.** A resource action without per-action perm + no `actionPermissions` + no `permissions.update` fallback → throws at tool generation. Declare `allowPublic()` to opt into unauthenticated.
- **Better Auth roles.** BA stores `member.role = "admin,recruiter"` (comma-separated). Arc splits into `scope.orgRoles = ['admin', 'recruiter']`; `?role=admin` won't match — use `role[like]=admin`.

## routeGuards + defineGuard

Apply guards to **every** route on a resource (CRUD + custom + preset):

```typescript
import { defineGuard } from '@classytic/arc/utils';

const tenantGuard = defineGuard({
  name: 'tenant',
  resolve: (req) => {
    const orgId = req.headers['x-org-id'] as string;
    if (!orgId) throw new Error('Missing x-org-id');
    return { orgId, actorId: req.user?.id ?? 'system' };
  },
});

defineResource({
  name: 'procurement',
  routeGuards: [tenantGuard.preHandler],
  routes: [{
    method: 'GET', path: '/summary', permissions: requireAuth(),
    rawHandler: async (req, reply) => {
      const { orgId } = tenantGuard.from(req);
      reply.send({ orgId });
    },
  }],
});
```

**Order:** auth → permissions → cache/idempotency → `routeGuards` → per-route `preHandler`.

## Query parsing

```
GET /products?page=2&limit=20&sort=-createdAt&select=name,price
GET /products?price[gte]=100&status[in]=active,featured&search=keyword
GET /products?after=<cursor_id>&limit=20                           # keyset
GET /products?populate[category][select]=name,slug
GET /products?filter[status]=active&filter[price][gte]=100         # bracket envelope (2.16)
```

Operators: `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `in`, `nin`, `like`, `regex`, `exists`.

**Whitelisted parser (MCP filter auto-derive):**

```typescript
import { QueryParser } from '@classytic/mongokit';

defineResource({
  queryParser: new QueryParser({
    allowedFilterFields: ['status', 'category', 'orgId'],
    allowedSortFields:   ['createdAt', 'price'],
    allowedOperators:    ['eq', 'gte', 'lte', 'in'],
  }),
  schemaOptions: { query: { allowedPopulate: ['category'], allowedLookups: ['categories'] } },
});
```

## Aggregations

`GET /:prefix/aggregations/:name` per entry. Portable `$match → $group → $project → $sort → $limit` against `repo.aggregate(req, options)` — same shape across kits.

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
      permissions: canViewRevenue(),
    }),
  },
});
```

Safety guards on the declaration: `requireFilters`, `requireDateRange { field, maxRangeDays }`, `maxGroups`. Caller query-string filters compose with `groupBy` / measures. SWR + `tags` invalidation tie aggregations to CRUD writes. Every aggregation auto-exports as an MCP tool.

Tenant scope flows through `options` (second arg), NOT into `aggReq.filter`. The kit's multi-tenant plugin handles type coercion (string → ObjectId, UUID/text, etc.). **Aggregation-only resources** (`disableDefaultRoutes: true` + no controller) work — arc falls back to the adapter's repo. If aggregations exist without a repo AND without `materialized`, `defineResource()` throws at boot.

### `materialized` hook — escape hatch + footgun

When a kit can't express your aggregation in the portable IR (`$graphLookup`, window functions, custom SQL), declare a `materialized` hook to own dispatch yourself:

```typescript
defineAggregation({
  measures: { count: 'count' },
  permissions: canViewRevenue(),
  materialized: async (ctx) => {
    // ctx = { filter, orgId, userId, requestId, query }
    // ⚠️  ctx.filter contains ONLY the declaration filter + caller query string.
    //     Tenant scope is in ctx.orgId, NOT in ctx.filter. Soft-delete is NOT merged.
    //     Bypassing repo.aggregate() means bypassing the kit's hook pipeline.

    // ✅ Right (mongokit) — route through repo.aggregatePipeline so the kit's
    //    multi-tenant + soft-delete + audit hooks all run:
    const rows = await orderRepo.aggregatePipeline(
      [{ $group: { _id: '$flow', total: { $sum: '$amount' } } }],
      { organizationId: ctx.orgId, userId: ctx.userId, requestId: ctx.requestId },
    );
    return { rows };

    // ❌ Wrong — Model.aggregate(...) bypasses kit plugins; tenant + soft-delete
    //    leak across orgs. Never call the driver directly in a materialized hook.
  },
});
```

For sqlitekit / custom adapters without an `aggregatePipeline` equivalent, **you** must inject tenant + soft-delete clauses into the SQL before executing — `ctx.filter` is not sufficient. Prefer the portable `repo.aggregate(req, options)` path whenever the IR can express your shape.

## QueryCache

TanStack-Query-style server cache with SWR + auto-invalidation on mutations:

```typescript
const app = await createApp({ arcPlugins: { queryCache: true } });

defineResource({
  cache: {
    staleTime: 30, gcTime: 300, tags: ['catalog'],
    invalidateOn: { 'category.*': ['catalog'] },     // event pattern → tag targets
    list: { staleTime: 60 },
    byId: { staleTime: 10 },
  },
});
```

POST/PATCH/DELETE bumps resource version. Response header: `x-cache: HIT | STALE | MISS`. `runtime: 'distributed'` requires `stores.queryCache: RedisCacheStore`.

## Events

CRUD events auto-emit: `{resource}.created` / `{resource}.updated` / `{resource}.deleted`. Manual publish:

```typescript
await app.events.publish('order.created', { orderId: '123' });
await app.events.subscribe('order.*', async (event) => { … });
```

Transports: Memory · Redis Pub/Sub (fire-and-forget) · Redis Streams (durable, consumer groups, DLQ). Event types live in `@classytic/primitives/events` (`createEvent`, `createChildEvent`, `matchEventPattern`, …); arc re-exports the runtime `MemoryEventTransport` only.

**Outbox** (at-least-once via transactional outbox):

```typescript
const outbox = new EventOutbox({ repository: outboxRepo, transport });
// Dev: { store: new MemoryOutboxStore(), transport }
```

Full event recipes (retry, DLQ, dual-publish warnings, idempotency keys) → [references/events.md](references/events.md).

## Hooks

Inline on resource. `ResourceHookContext` = `{ data, user?, meta? }`; `meta` has `id` and `existing` for update/delete.

```typescript
hooks: {
  beforeCreate: async (ctx) => { ctx.data.slug = slugify(ctx.data.name); },
  afterCreate:  async (ctx) => { analytics.track('created', { id: ctx.data._id }); },
  beforeUpdate: async (ctx) => { /* ctx.meta.existing has the pre-image */ },
  beforeDelete: async (ctx) => { if (ctx.data.isProtected) throw new Error('locked'); },
}
```

App-level (cross-resource): `createHookSystem()` + `beforeCreate(hooks, 'product', fn)` from `@classytic/arc/hooks`.

## Errors

```typescript
import { ArcError, NotFoundError, ValidationError, createDomainError } from '@classytic/arc';

throw new NotFoundError('Product');                                                // 404
throw createDomainError('SELF_REFERRAL', 'Cannot self-refer', 422, { field });
```

Wire envelope: `{ code, message, status, meta?, correlationId? }`. HTTP status is the discriminator — no `success` field. Custom mappers:

```typescript
errorHandler: {
  errorMappers: [{
    type: AccountingError,
    toResponse: (err) => ({ status: err.status, code: err.code, message: err.message }),
  }],
}
```

Modules ship their own via `defineModule({ errorMappers })` (2.21) — merged into the app handler at boot; host-level mappers keep priority.

## Testing

```typescript
import { createTestApp, expectArc } from '@classytic/arc/testing';

const ctx = await createTestApp({
  resources: [productResource],
  authMode: 'jwt',                  // 'jwt' | 'better-auth' | 'none'
  connectMongoose: true,            // in-memory Mongo
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

Three entry points: `createTestApp` (custom), `createHttpTestHarness` (~16 auto-generated CRUD/perm/validation tests per resource), `runStorageContract` (adapter conformance). → [references/testing.md](references/testing.md)

## CLI

```bash
arc init my-api --mongokit --better-auth --ts                  # scaffold
arc generate resource product                                  # alias: arc g r product
arc generate resource product --mcp                            # + MCP tools file
arc generate mcp analytics                                     # standalone MCP file
arc docs ./openapi.json --entry ./dist/index.js                # emit OpenAPI
arc introspect --entry ./dist/index.js
arc describe ./dist/resources.js --json                        # JSON metadata
arc doctor                                                     # diagnose env
```

Set `"mcp": true` in `.arcrc` to always generate `.mcp.ts` alongside resources.

## MCP (AI agent tools)

Resources auto-generate Model Context Protocol tools — same permissions, same field rules. Stateless by default.

```typescript
import { mcpPlugin } from '@classytic/arc/mcp';

await app.register(mcpPlugin, {
  resources: [productResource, orderResource],
  auth: false,                              // or: getAuth() | custom function
  exclude: ['credential'],
  overrides: { product: { operations: ['list', 'get'] } },
});
```

**Per-resource opt-out:** `defineResource({ mcp: false })` — exclude a resource from MCP tool generation entirely. Useful for internal-admin or write-heavy resources where you don't want LLMs poking.

**Auth modes** — `false` | `getAuth()` (Better Auth OAuth 2.1) | `createMcpAuthFromBetterAuthApiKey(getAuth(), { orgFromMetadata: true })` (BA API-key plugin — handles `referenceId`/`userId` fallback + `metadata.organizationId` extraction) | custom function returning `{ userId, organizationId, roles }` (human) or `{ clientId, organizationId, scopes }` (service). `PermissionResult.filters` flow into MCP tools exactly like REST.

**Tool-name collisions** — preset vs user (e.g. `softDelete` route vs `actions.restore`) auto-namespace to `softdelete_restore_<resource>`; every other collision shape throws `ArcError('arc.mcp.tool_name_collision')` naming both sources.

**Custom tools** — co-locate with resources (`order.mcp.ts`), wire via `extraTools`. **AI SDK bridge** — expose AI SDK `tool()` defs via `buildMcpToolsFromBridges([...])`.

Connect Claude CLI: `claude mcp add --transport http my-api http://localhost:3000/mcp`. Full recipes → [references/mcp.md](references/mcp.md).

### AI SDK streaming → Fastify

`streamResponse: true` routes that return a Web `ReadableStream` (Vercel AI SDK's `result.toUIMessageStream()`, `fetch().body`) auto-pipe through `pipeUIMessageStreamToReply()` — no `JsonToSseTransformStream` boilerplate.

```typescript
import { streamText } from 'ai';

defineResource({
  name: 'chat',
  customRoutesOnly: true,
  routes: [{
    method: 'POST', path: '/', streamResponse: true,
    permissions: requireAuth(),
    rawHandler: async (req) => {
      const result = streamText({ model, messages: req.body.messages });
      return result.toUIMessageStream();  // arc pipes it for you
    },
  }],
});
```

For manual control: `import { pipeUIMessageStreamToReply, UI_MESSAGE_STREAM_HEADERS } from '@classytic/arc/utils'`. Client disconnect cancels the source stream (no zombie LLM spend).

## Tenant cleanup (GDPR / SOX / HIPAA)

Per-resource strategy + one auth-lifecycle wire-up:

```typescript
defineResource({
  name: 'invoice',
  tenantField: 'organizationId',
  onTenantDelete: {
    strategy: { type: 'anonymize', fields: { customerName: '[REDACTED]', email: null } },
    priority: 50, batchSize: 1000,
  },
});
defineResource({ name: 'event',  onTenantDelete: { strategy: { type: 'hard' } } });
defineResource({ name: 'ledger', onTenantDelete: { strategy: { type: 'skip', reason: 'SOX retention' } } });

import { cascadeDeleteForOrganization, assertNoTenantData } from '@classytic/arc/registry';

betterAuth.org.afterDelete = async ({ organizationId }) => {
  const report = await cascadeDeleteForOrganization(fastify.arc.registry, {
    organizationId, concurrency: 4, logger: fastify.log,
  });
  if (report.failures.length > 0) await alerting.fire({ report });
};
```

Strategies: `hard` · `soft` · `anonymize` (`fields` static or `(doc) => value`) · `skip` (`reason` mandatory). Resources without `onTenantDelete` are never touched. **Index `tenantField`** on every cascading resource or chunked SELECTs run O(n²). Compliance smoke: `assertNoTenantData(registry, { organizationId })`.

## Enterprise auth (opt-in)

| Capability | Surface | Reference |
|---|---|---|
| SCIM 2.0 provisioning (Okta / Azure AD / Google) | `@classytic/arc/scim` — `scimPlugin({ users, groups, bearer })` | [references/scim.md](references/scim.md) |
| Agent mandates + DPoP (AP2 / x402 / MCP authz) | `@classytic/arc/permissions` — `requireAgentScope`, `requireMandate`, `requireDPoP` | [references/agent-auth.md](references/agent-auth.md) |
| Auth-event audit bridge | `@classytic/arc/auth/audit` — `wireBetterAuthAudit({ events })` | [references/enterprise-auth.md](references/enterprise-auth.md) |

Out of scope: SAML (use BA SAML plugin), session storage (BA `secondaryStorage`), DPoP crypto (one `jose.dpop.verify()` in your `authenticate`), device trust (Castle / Stytch).

## Audit per-resource

```typescript
await fastify.register(auditPlugin, { autoAudit: { perResource: true } });

defineResource({ name: 'order',   audit: true });
defineResource({ name: 'invoice', history: true });   // 2.22: injects GET /:id/history from audit rows; implies audit: true (gate: update→get→requireAuth; override via { permissions, limit })
defineResource({ name: 'payment', audit: { operations: ['delete'] } });
defineResource({ name: 'product' });   // not audited

// Manual (MCP tools / read auditing)
await app.audit.custom('order', req.params.id, 'refund', { reason }, { user });
```

## Usage counters + plan limits (2.22)

`@classytic/arc/usage` — `usagePlugin` decorates `fastify.usage` with per-actor, per-UTC-month counters (`record`/`summary`/`period`/`actorOf`; actor chain org → user → client → ip). Auto-tracks `api.requests` (default on) + `api.egress.bytes` (opt-in); recording is fail-safe (a throwing `UsageStore` never fails a request; `MemoryUsageStore` built in, Redis/kit backends are ~5 lines). Pair with `createApp({ rateLimit: { plan: { resolve, limits: { free: { max: 60 }, enterprise: false }, default: 'free' } } })` for per-plan ceilings — `false` = unlimited, unknown/throwing resolvers fall back to `default` then global `max`, and buckets follow the tenant key chain by default. Caveat: the limiter runs before route auth, so `resolve` sees the raw request.

## Adapters

Cross-framework adapter contract lives in `@classytic/repo-core/adapter`. Every kit-specific adapter ships from its kit's `/adapter` subpath; arc itself has zero kit-bound adapters.

```typescript
import { createMongooseAdapter } from '@classytic/mongokit/adapter';
import { createDrizzleAdapter }  from '@classytic/sqlitekit/adapter';
import { createPrismaAdapter }   from '@classytic/prismakit/adapter';

import type { DataAdapter, RepositoryLike, AdapterRepositoryInput }
  from '@classytic/repo-core/adapter';
// MinimalRepo<TDoc>  — 5-method floor (getAll, getById, create, update, delete)
// StandardRepo<TDoc> — MinimalRepo + optional batch ops, CAS, soft-delete, aggregate, …
// Arc feature-detects optional methods at call sites; missing methods → 501.
```

Custom kits implementing `DataAdapter<TDoc>` plug in identically. Kit-native repos plug in **without** `as RepositoryLike` casts.

## Controllers

`BaseController` is mixin-composed. The auto-built controller covers every preset; you only need a custom one to add domain methods.

```typescript
import { BaseController, type IRequestContext, type IControllerResponse } from '@classytic/arc';

class ProductController extends BaseController<Product> {
  constructor(opts: { tenantField?: string | false; idField?: string } = {}) {
    super(productRepo, { resourceName: 'product', ...opts });
  }
  async getFeatured(req: IRequestContext): Promise<IControllerResponse<Product[]>> {
    return { data: await this.repository.getAll({ filters: { isFeatured: true } }) };
  }
}

defineResource({ name: 'product', controller: new ProductController({ tenantField: '_id' }), tenantField: '_id' });
```

When you pass your own controller, arc **cannot** thread `tenantField` / `schemaOptions` / `idField` / `cache` / `onFieldWriteDenied` into it. Forward via `super()` AND pass to `defineResource()`. Presets that inject controller fields (slugLookup, softDelete, tree) only reach arc's auto-built `BaseController` — extend `BaseController` or drop the preset.

**Slim mixins** (no soft-delete/tree/slug/bulk on by default):

```typescript
import { BaseCrudController, SoftDeleteMixin, BulkMixin, SlugMixin, TreeMixin } from '@classytic/arc';
class OrderController extends SoftDeleteMixin(BulkMixin(BaseCrudController)) {}
```

## DX helpers

```typescript
import type { ArcRequest } from '@classytic/arc';
import { envelope } from '@classytic/arc';
import { multipartBody } from '@classytic/arc/middleware';

// Typed request — no `(req as any).user`
rawHandler: async (req: ArcRequest, reply) => { req.user?.id; req.scope; req.signal; }

// File upload — no-op for JSON requests, safe to always add
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

// SSE — preAuth runs before auth (EventSource can't set headers); rawHandler streams the response
routes: [
  { preAuth: [(req) => { req.headers.authorization = `Bearer ${req.query.token}`; }] },
  { method: 'GET', path: '/stream', rawHandler: async (req, reply) => reply.send(stream) },
]

// Per-route rate limit (2.20) — overrides the resource/app default for ONE endpoint.
// `false` = never throttle, object = tighten, omit = inherit. Custom routes only;
// actions share one POST /:id/action mount, so throttle an action by making it a route.
routes: [
  { method: 'POST', path: '/export', handler: 'export', permissions: requireAuth(),
    rateLimit: { max: 5, timeWindow: '1 minute' } },
  { method: 'GET', path: '/health', handler: 'health', permissions: allowPublic(),
    rateLimit: false },
]

// Per-resource opt-out of resourcePrefix (webhooks / admin routes)
defineResource({ name: 'webhook', prefix: '/hooks', skipGlobalPrefix: true });

// Reply helpers — opt-in via createApp({ replyHelpers: true })
return reply.sendList({ method: 'offset', data, total, page, limit, pages, hasNext, hasPrev });
return reply.stream(csvReadable, { contentType: 'text/csv', filename: 'export.csv' });
```

## Subpath imports

```typescript
import { defineResource, BaseController, allowPublic }     from '@classytic/arc';
import { createApp, loadResources }                        from '@classytic/arc/factory';
import { createMongooseAdapter }                           from '@classytic/mongokit/adapter';
import type { DataAdapter, RepositoryLike }                from '@classytic/repo-core/adapter';
import { getUserId, getOrgId, requireOrgId }               from '@classytic/arc/scope';
import { mcpPlugin }                                       from '@classytic/arc/mcp';
import { createTestApp, expectArc }                        from '@classytic/arc/testing';
```

Full subpath map → [references/api-reference.md](references/api-reference.md).

## References

- **[api-reference](references/api-reference.md)** — full subpath import map (every plugin, helper, type)
- **[auth](references/auth.md)** — JWT, Better Auth, API key, custom auth, kit overlays
- **[scim](references/scim.md)** — SCIM 2.0 plugin (Okta / Azure AD / Google Workspace)
- **[agent-auth](references/agent-auth.md)** — DPoP + capability mandates (AP2 / x402 / MCP authz)
- **[enterprise-auth](references/enterprise-auth.md)** — what's in vs out of the box
- **[events](references/events.md)** — Transports, retry, outbox, idempotency
- **[integrations](references/integrations.md)** — BullMQ jobs, WebSocket, EventGateway, Streamline, Webhooks
- **[mcp](references/mcp.md)** — Tool generation, custom tools, AI SDK bridges, Better Auth OAuth 2.1
- **[multi-tenancy](references/multi-tenancy.md)** — Scope ladder, `tenantField`, parent-child orgs, API-key auth
- **[production](references/production.md)** — Health, audit, idempotency, tracing, metrics, versioning, SSE, bulk ops
- **[testing](references/testing.md)** — Test app, mocks, fixtures, in-memory Mongo
