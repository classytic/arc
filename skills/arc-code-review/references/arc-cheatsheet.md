# Arc Cheatsheet — what arc provides, in one page

A condensed map of arc's capabilities so you can spot, during audit, what the team is *missing* vs hand-rolling. For deep API, see the existing `skills/arc/SKILL.md` and its `references/`.

---

## Boot order (FIXED — don't reorder)

```
1. Arc core (security, auth, events)
2. plugins()                  ← user infra (DB, docs, webhooks)
3. bootstrap[]                ← domain init (engines, singletons)
4. resources factory          ← if async: resolved here, after bootstrap
5. resources[]                ← register each resource
6. afterResources()           ← post-registration wiring
7. onReady / onClose          ← Fastify lifecycle hooks
```

When auditing: top-level `await ensureCatalogEngine()` in a `*.resource.ts` file = lifecycle violation. Use `resources: async (fastify) => [...]`.

---

## `createApp()` essentials

```typescript
const app = await createApp({
  preset: 'production',                     // production | development | testing | edge
  runtime: 'memory',                        // memory (default) | distributed
  auth: { type: 'jwt', jwt: { secret } },   // | 'betterAuth' | 'custom' | false
  resources: [resource1, resource2],        // OR async (fastify) => [...]
  arcPlugins: { events: true, queryCache: false, sse: false, caching: true },
  stores: { events: ..., queryCache: ..., idempotency: ... },  // distributed only
  cors: { origin: [...], credentials: true },
  helmet: true, rateLimit: { max: 100 },
  resourcePrefix: '/api/v1',
  bootstrap: [async () => { ... }],
  afterResources: async (app) => { ... },
});
```

---

## `defineResource()` — full surface

```typescript
defineResource({
  name: 'product',                  // required
  adapter: createMongooseAdapter({ model, repository, schemaGenerator? }),  // required
  controller?: new MyController(),  // optional — auto-built if omitted
  permissions: {                    // required
    list, get, create, update, delete: PermissionCheck,
  },
  presets?: ['softDelete', { name: 'multiTenant', tenantField: 'orgId' }, ...],
  schemaOptions?: {
    fieldRules: { [field]: FieldRuleEntry },
    query: { allowedPopulate, allowedLookups, filterableFields },
  },
  routes?: [{ method, path, handler, permissions, raw?, mcp?, summary? }],
  actions?: { [name]: { handler, permissions?, schema?, mcp?, description? } },
  actionPermissions?: PermissionCheck,
  hooks?: { beforeCreate, afterCreate, beforeUpdate, afterUpdate, beforeDelete, afterDelete },
  events?: { created: {}, updated: {}, deleted: {}, [custom]: { description?, schema? } },
  cache?: { staleTime, gcTime, tags, invalidateOn?, list?, byId? },
  routeGuards?: [preHandlerFn],
  middlewares?: { create: [multipartBody(...)], ... },
  pipe?: { create: [guard(...), transform(...), intercept(...)] },
  rateLimit?: { max, timeWindow },
  tenantField?: string | false,
  idField?: string,
  prefix?: string, skipGlobalPrefix?: boolean,
  queryParser?: QueryParserInterface,
  onFieldWriteDenied?: 'reject' | 'strip',
  audit?: boolean | { operations: [...] },
  displayName?: string, module?: string,
});
```

### `FieldRuleEntry` flags

| Flag | Effect |
|---|---|
| `systemManaged` | Strip from body, drop from `required[]`. Framework stamps the value. |
| `preserveForElevated` | Elevated admins keep the field on ingest (cross-tenant writes). |
| `immutable` / `immutableAfterCreate` | Omit from update body. |
| `optional` | Strip from `required[]` without touching `properties`. |
| `nullable` | Widen JSON-Schema `type` to include null. |
| `hidden` | Block from response projection + OpenAPI. |
| `minLength`/`maxLength`/`min`/`max`/`pattern`/`enum` | Map to AJV + OpenAPI. |
| `description` | OpenAPI `description`. |

Mongoose model-level constraints take precedence; `fieldRules` supplements.

---

## Permissions — combinators

From `@classytic/arc`:
```typescript
allowPublic()                    // always grant
requireAuth()                    // any authenticated user
requireRoles(['admin', 'editor'])// platform OR org roles
requireOwnership('userId')       // row-level: filters → { userId: scope.userId }
requireOrgMembership()           // member | service | elevated
requireOrgRole(['admin'])        // human-only role within org
requireTeamMembership()
requireServiceScope('jobs:bulk-write')   // OAuth-style API-key scopes
requireScopeContext('branchId')          // app-defined dimensions
requireOrgInScope(targetId)              // parent-child org hierarchy
allOf(check1, check2, ...)
anyOf(check1, check2, ...)
not(check)
when(condition, ifTrue, ifFalse)
denyAll()
createDynamicPermissionMatrix({ resolveRolePermissions, cacheStore })
```

Convenience bundles: `publicRead()`, `publicReadAdminWrite()`, `adminOnly()`, `ownerWithAdminBypass()`.

`PermissionCheck` returns `boolean | { granted, reason?, filters?, scope? }`. `filters` flow into the repo query (row-level ABAC). `scope` stamps attributes downstream.

### Field-level
```typescript
import { fields } from '@classytic/arc';
fieldRules: {
  password: fields.hidden(),
  salary:   fields.visibleTo(['admin', 'hr']),
  role:     fields.writableBy(['admin']),
  email:    fields.redactFor(['viewer'], '***'),
}
```

---

## RequestScope — five kinds

```typescript
type RequestScope =
  | { kind: 'public' }
  | { kind: 'authenticated'; userId?; userRoles? }
  | { kind: 'member';   userId?; userRoles; organizationId; orgRoles; teamId?; context?; ancestorOrgIds? }
  | { kind: 'service';  clientId; organizationId; scopes?; context?; ancestorOrgIds? }
  | { kind: 'elevated'; userId?; organizationId?; elevatedBy; context?; ancestorOrgIds? };
```

**Always read via accessors from `@classytic/arc/scope`:**
```typescript
isPublic, isAuthenticated, isMember, isService, isElevated, hasOrgAccess,
getUserId, getUserRoles, getOrgId, getOrgRoles, getTeamId, getClientId,
getServiceScopes, getScopeContext, getScopeContextMap,
getAncestorOrgIds, isOrgInScope, getRequestScope,
requireUserId, requireClientId,                                // throw 401 (UnauthorizedError) if absent
requireOrgId, requireTeamId,                                   // throw 403 (OrgRequiredError) if absent
createTenantKeyGenerator,
```

| Helper | `member` | `service` | `elevated` |
|---|---|---|---|
| `requireOrgMembership()` | ✅ | ✅ | ✅ |
| `requireOrgRole(roles)` | role match | ❌ deny | ✅ bypass |
| `requireServiceScope(scopes)` | ❌ | scope match | ✅ bypass |
| `requireScopeContext(...)` | key match | key match | ✅ bypass |
| `requireTeamMembership()` | `teamId` set | n/a | ✅ bypass |
| `requireOrgInScope(target)` | target in chain | target in chain | ✅ bypass |

---

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

---

## Hooks

Inline (per-resource):
```typescript
hooks: {
  beforeCreate: async (ctx) => { /* ctx.data, ctx.user, ctx.meta */ },
  afterCreate:  async (ctx) => { ... },
  beforeUpdate: async (ctx) => { /* ctx.meta.existing has the pre-image */ },
  afterUpdate:  async (ctx) => { ... },
  beforeDelete: async (ctx) => { ... },
  afterDelete:  async (ctx) => { ... },
}
```

App-level (cross-resource):
```typescript
import { createHookSystem, beforeCreate, afterUpdate } from '@classytic/arc/hooks';

const hooks = createHookSystem();
beforeCreate(hooks, 'product', async (ctx) => { ctx.data.slug = slugify(ctx.data.name); });
```

Pipeline (for finer control):
```typescript
import { guard, transform, intercept } from '@classytic/arc/pipeline';

pipe: {
  create: [
    guard('verified', async (ctx) => ctx.user?.verified === true),
    transform('inject', async (ctx) => { ctx.body.createdBy = ctx.user._id; }),
  ],
}
```

---

## Events

```typescript
events: { created: {}, updated: {}, deleted: {}, custom: { description, schema } }
```

CRUD events auto-emit. Custom: `await req.fastify.events.publish(eventType, payload)`. Subscribe: `app.events.subscribe('order.*', handler)`.

**Transports:** `MemoryEventTransport` · `RedisEventTransport` (pub/sub fire-and-forget) · `RedisStreamTransport` (durable, at-least-once, consumer groups, DLQ) · `EventOutbox` (transactional outbox).

---

## Cache (QueryCache)

```typescript
cache: {
  staleTime: 30, gcTime: 300, tags: ['catalog'],
  invalidateOn: { 'category.*': ['catalog'] },
  list:  { staleTime: 60 },
  byId:  { staleTime: 10 },
}
```
Modes: `memory` (default) | `distributed` (`stores.queryCache: RedisCacheStore`). Response: `x-cache: HIT | STALE | MISS`.

---

## CLI

```bash
arc init my-api --mongokit --jwt --ts          # scaffold (also: --custom, --better-auth, --multi)
arc generate resource product                   # generate resource files
arc generate resource product --mcp             # + MCP tools file
arc generate mcp analytics                      # standalone MCP tools file
arc docs ./openapi.json --entry ./dist/index.js # emit OpenAPI
arc introspect --entry ./dist/index.js          # list registered resources
arc describe product                            # detail a resource's routes/actions/permissions
arc doctor                                      # diagnose env
```

`.arcrc`: project config used by `arc generate`. Set `"mcp": true` to always emit `.mcp.ts` alongside resources.

Generated layout:
```
src/resources/{name}/
  {name}.model.ts          # Mongoose schema (with --mongokit)
  {name}.repository.ts     # Repository class (mongokit Repository)
  {name}.resource.ts       # defineResource() config
  {name}.mcp.ts            # (optional) custom MCP tools
```

Naming: kebab input (`org-profile`) → PascalCase class (`OrgProfile`), camelCase var (`orgProfile`), kebab files.

---

## MCP

```typescript
import { mcpPlugin } from '@classytic/arc/mcp';

await app.register(mcpPlugin, {
  resources: [productResource, orderResource],
  auth: false,                              // | getAuth() | custom function
  exclude: ['credential'],
  overrides: { product: { operations: ['list', 'get'] } },
});

// Stateful (server-initiated messages)
await app.register(mcpPlugin, { resources, stateful: true, sessionTtlMs: 600000 });
```

Auto-generates 5 CRUD tools per resource + custom routes + actions. Permissions and field rules carry through. Connect via `claude mcp add --transport http my-api http://localhost:3000/mcp`.

Custom tools alongside resources: co-locate `order.mcp.ts`, wire via `extraTools: [...]`. AI SDK bridge: `buildMcpToolsFromBridges([bridge])`.

---

## Adapters

In arc 2.12, every kit-specific adapter ships from its kit's `/adapter` subpath. Arc has zero kit-bound adapters. The cross-framework contract lives in `@classytic/repo-core/adapter`.

```typescript
// Mongoose — from mongokit
import { createMongooseAdapter } from '@classytic/mongokit/adapter';
import { buildCrudSchemasFromModel, Repository } from '@classytic/mongokit';

const adapter = createMongooseAdapter({
  model: ProductModel,
  repository: new Repository(ProductModel),
  schemaGenerator: buildCrudSchemasFromModel,
});

// Drizzle — from sqlitekit
import { createDrizzleAdapter } from '@classytic/sqlitekit/adapter';
import { buildCrudSchemasFromTable } from '@classytic/sqlitekit';

// Prisma — from prismakit
import { createPrismaAdapter } from '@classytic/prismakit/adapter';
```

Custom adapter: implement `DataAdapter` / `MinimalRepo<TDoc>` from `@classytic/repo-core/adapter` (5-method floor). Any kit (mongokit, sqlitekit, prismakit, future pgkit, custom) plugs in identically. `RepositoryLike<TDoc> = MinimalRepo<TDoc> & Partial<StandardRepo<TDoc>>` — arc feature-detects optional methods at call sites. Arc re-exports `RepositoryLike`; the rest of the contract types come from `@classytic/repo-core/adapter` directly.

| Plugin | Required methods on repo |
|---|---|
| `auditPlugin` | `create`, `findAll` |
| `idempotencyPlugin` | `getOne`, `deleteMany`, `findOneAndUpdate` |
| `EventOutbox` | `create`, `getOne`, `findAll`, `deleteMany`, `findOneAndUpdate` |

---

## Plugins (`@classytic/arc/plugins`)

```typescript
import {
  healthPlugin, gracefulShutdownPlugin, ssePlugin,
  metricsPlugin, versioningPlugin,
} from '@classytic/arc/plugins';
import { tracingPlugin } from '@classytic/arc/plugins/tracing';
import { auditPlugin } from '@classytic/arc/audit';
import { idempotencyPlugin } from '@classytic/arc/idempotency';
import { jobsPlugin } from '@classytic/arc/integrations/jobs';
import { websocketPlugin } from '@classytic/arc/integrations/websocket';
import { eventGatewayPlugin } from '@classytic/arc/integrations/event-gateway';
import { webhookPlugin } from '@classytic/arc/integrations/webhooks';
```

---

## Subpath imports (tree-shakeable)

```typescript
import { defineResource, BaseController, allowPublic, requireRoles } from '@classytic/arc';
import { createApp, loadResources } from '@classytic/arc/factory';
import { MemoryCacheStore, RedisCacheStore, QueryCache } from '@classytic/arc/cache';
import { createBetterAuthAdapter } from '@classytic/arc/auth';
import { eventPlugin, EventOutbox } from '@classytic/arc/events';
import { RedisEventTransport } from '@classytic/arc/events/redis';
import { mcpPlugin, defineTool } from '@classytic/arc/mcp';
import { bulkPreset, multiTenantPreset } from '@classytic/arc/presets';
import { isMember, getUserId, getOrgId, hasOrgAccess } from '@classytic/arc/scope';
import { createTestApp, expectArc } from '@classytic/arc/testing';
import { multipartBody } from '@classytic/arc/middleware';
import { defineGuard, withCompensation, CircuitBreaker, createStateMachine } from '@classytic/arc/utils';
```

Audit signal: a project importing only from the `@classytic/arc` root barrel is probably under-using subpath features (caching, scope accessors, presets, MCP, testing harness).

---

## Non-negotiable conventions (mirror in client projects)

1. No `console.log` in `src/` (except `cli/`) — use logger.
2. No `mongoose`/`drizzle-orm`/`@prisma/client` imports anywhere in the host outside the host's adapter wiring file. Every kit-specific adapter factory (`createMongooseAdapter` / `createDrizzleAdapter` / `createPrismaAdapter`) MUST come from the kit's `/adapter` subpath, never from `@classytic/arc` — the `@classytic/arc/adapters` subpath was removed in arc 2.12.
3. No `any` — use `unknown`. No `@ts-ignore` — fix the type.
4. No default exports in `src/` (knip enforces in arc; recommend in clients).
5. Always read `request.user` via guard or use `@classytic/arc/scope` accessors.
6. Always use `req.rawBody` for `verifySignature(...)`, never parsed body.
7. Set headers in `onRequest` or `preSerialization`, never `onSend`.
8. `request.user: Record<string, unknown> | undefined` — required property, NOT optional.
