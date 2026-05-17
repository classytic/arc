# Arc capabilities at a glance — for gap detection

A condensed map of what arc provides, so during audit you can spot what the team is **hand-rolling** vs what's already a one-liner. For full API details, read [`skills/arc/SKILL.md`](../../arc/SKILL.md) and its references.

## What arc replaces (audit signals)

| If you see this in the codebase… | …it should be this arc surface |
|---|---|
| 5× `fastify.get/post/patch/delete` for one resource | `defineResource({ name, adapter, permissions, … })` — CRUD auto-generated |
| `if (req.user.role !== 'admin') return reply.code(403)…` | `permissions: { update: requireRoles(['admin']) }` |
| `req.user._id`, `req.user.orgId` direct reads | `getUserId(scope)` / `getOrgId(scope)` from `@classytic/arc/scope` |
| Hand-written `schema: { body, response }` per route | `schemaOptions.fieldRules` |
| `schema.set('toJSON', { transform })` to strip `password`/`__v` | `fieldRules: { password: { hidden: true } }` |
| Manual `req.query.filter` parsing, `$or`/`$and` building | `ArcQueryParser` / mongokit `QueryParser` |
| Hand-maintained `openapi.yaml` | `arc docs ./openapi.json` |
| `eventBus.emit('product.created', …)` in handler | CRUD events auto-emit; `events: { created: {} }` for custom |
| `cache.del('products-*')` after mutation | `cache: { tags: ['catalog'] }` — auto-invalidated |
| Soft-delete: hand-rolled `/deleted` route + `deletedAt` field + restore handler | `presets: ['softDelete']` |
| `class UserRepository { async create() { Model.create() } }` | `new Repository(Model)` from mongokit |
| Per-schema `schema.pre('save', …)` for timestamps/validation | mongokit's `timestampPlugin()`, `validationChainPlugin()` |
| Hand-written MCP tool handlers | `mcpPlugin({ resources })` — auto-generated, same perms |
| `Model.aggregate([…])` in route handler | `aggregations: { name: defineAggregation({ … }) }` |
| Custom `withRetry` / `withDLQ` plumbing on events | `RedisStreamTransport` (durable, consumer groups, DLQ) |
| Hand-rolled idempotency token check | `idempotencyPlugin` (header-based, configurable store) |
| Manual SCIM provisioning endpoints | `@classytic/arc/scim` — `scimPlugin({ users, groups, bearer })` |

## Boot order (FIXED)

```
1. Arc core (security, auth, events)
2. plugins()        ← user infra (DB, docs, webhooks)
3. bootstrap[]      ← domain init (engines, singletons)
4. resources (factory runs after bootstrap)
5. resources[]      ← register each
6. afterResources()
7. onReady / onClose
```

**Lifecycle smell:** top-level `await ensureCatalogEngine()` in a `*.resource.ts` file. Fix: pass `resources` as `async (fastify) => [...]` so it runs after `bootstrap[]`.

## defineResource — full surface

```typescript
defineResource({
  name: 'product',                                  // required
  adapter,                                          // required — from kit's /adapter subpath
  controller?,                                      // optional — auto-built if omitted
  permissions: { list, get, create, update, delete },
  presets?: [...],
  schemaOptions?: { fieldRules, query },
  routes?, actions?, actionPermissions?,
  hooks?, events?, cache?,
  routeGuards?, middlewares?, pipe?,
  rateLimit?, tenantField?, idField?,
  prefix?, skipGlobalPrefix?,
  queryParser?, onFieldWriteDenied?,
  audit?, mcp?,                                     // mcp: false to exclude from MCP tool gen
  displayName?, module?,
  onTenantDelete?,                                  // GDPR cascade strategy
});
```

## Permissions

```typescript
allowPublic()                              requireOrgRole(['admin'])
requireAuth()                              requireTeamMembership()
requireRoles(['admin'])                    requireServiceScope('jobs:bulk')
requireOwnership('userId')                 requireScopeContext('branchId')
requireOrgMembership()                     requireOrgInScope(targetId)
allOf(...) · anyOf(...) · not(...) · when(...) · denyAll()
createDynamicPermissionMatrix({ resolveRolePermissions, cacheStore })
```

Returns `boolean | { granted, reason?, filters?, scope? }`. `filters` propagate into the repo query (row-level ABAC).

Field-level: `fields.hidden()`, `fields.visibleTo([...])`, `fields.writableBy([...])`, `fields.redactFor([...], '***')`.

## RequestScope

```typescript
type RequestScope =
  | { kind: 'public' }
  | { kind: 'authenticated'; userId?; userRoles? }
  | { kind: 'member';   userId?; userRoles; organizationId; orgRoles; teamId?; context?; ancestorOrgIds? }
  | { kind: 'service';  clientId; organizationId; scopes?; context?; ancestorOrgIds?; mandate?; dpopJkt? }
  | { kind: 'elevated'; userId?; organizationId?; elevatedBy; context?; ancestorOrgIds? };
```

Always access via `@classytic/arc/scope`: `getUserId`, `getOrgId`, `hasOrgAccess`, `requireOrgId` (throws 403), `requireUserId` (throws 401), `getScopeContext`, `isOrgInScope`. **Never read `scope.organizationId` directly.**

## Presets

| Preset | Routes added | Config |
|---|---|---|
| `softDelete` | `GET /deleted`, `POST /:id/restore` | `{ deletedField }` |
| `slugLookup` | `GET /slug/:slug` | `{ slugField }` |
| `tree` | `GET /tree`, `GET /:parent/children` | `{ parentField }` |
| `ownedByUser` | (middleware) | `{ ownerField }` |
| `multiTenant` | (middleware) | `{ tenantField }` or `{ tenantFields: [...] }` |
| `audited` | (middleware) | — |
| `bulk` | `POST/PATCH/DELETE /bulk` | `{ operations?, maxCreateItems? }` |
| `filesUpload` | `POST /upload`, `GET /:id`, `DELETE /:id` | `{ storage, sanitizeFilename?, … }` |
| `search` | `POST /search`, `/search-similar`, `/embed` | `{ repository?, search?, similar?, embed? }` |

## fieldRules flags

`systemManaged` · `preserveForElevated` · `immutable` / `immutableAfterCreate` · `optional` · `nullable` · `hidden` · `minLength` / `maxLength` / `min` / `max` / `pattern` / `enum` · `description`.

## Aggregations

```typescript
aggregations: {
  byMethod: defineAggregation({
    groupBy: 'method',
    measures: { total: 'sum:amount', count: 'count' },
    requireDateRange: { field: 'createdAt', maxRangeDays: 365 },
    cache: { staleTime: 60, swr: true, tags: ['revenue'] },
    permissions: canViewRevenue(),
  }),
}
```

Registers `GET /:prefix/aggregations/:name`. Same perms + cache + tag invalidation + MCP tool as CRUD. **Anti-pattern:** custom routes calling `Model.aggregate([...])` directly.

## CLI

```bash
arc init my-api --mongokit --better-auth --ts
arc generate resource product [--mcp]
arc docs ./openapi.json --entry ./dist/index.js
arc introspect --entry ./dist/index.js
arc describe ./dist/resources.js --json
arc doctor
```

Generated layout: `src/resources/{name}/{name}.{model,repository,resource,mcp}.ts`. Naming: `org-profile` (kebab input) → `OrgProfile` (class) / `orgProfile` (var) / `org-profile.*.ts` (files).

## Adapters

Every kit ships its adapter from `@classytic/<kit>/adapter`. Arc has **zero** kit-bound adapters in `src/` since 2.12.

```typescript
import { createMongooseAdapter } from '@classytic/mongokit/adapter';
import { createDrizzleAdapter }  from '@classytic/sqlitekit/adapter';
import { createPrismaAdapter }   from '@classytic/prismakit/adapter';

import type { DataAdapter, RepositoryLike } from '@classytic/repo-core/adapter';
// RepositoryLike<TDoc> = MinimalRepo<TDoc> & Partial<StandardRepo<TDoc>>
```

| Plugin | Required repo methods |
|---|---|
| `auditPlugin` | `create`, `findAll` |
| `idempotencyPlugin` | `getOne`, `deleteMany`, `findOneAndUpdate` |
| `EventOutbox` | `create`, `getOne`, `findAll`, `deleteMany`, `findOneAndUpdate` |

## Subpath imports — audit signals

```typescript
import { defineResource, BaseController, allowPublic }    from '@classytic/arc';
import { createApp, loadResources }                        from '@classytic/arc/factory';
import { MemoryCacheStore, RedisCacheStore, QueryCache }   from '@classytic/arc/cache';
import { eventPlugin, EventOutbox }                        from '@classytic/arc/events';
import { RedisEventTransport, RedisStreamTransport }       from '@classytic/arc/events/redis-stream';
import { mcpPlugin, defineTool }                           from '@classytic/arc/mcp';
import { bulkPreset, multiTenantPreset }                   from '@classytic/arc/presets';
import { isMember, getUserId, getOrgId, requireOrgId }     from '@classytic/arc/scope';
import { createTestApp, expectArc }                        from '@classytic/arc/testing';
import { multipartBody }                                   from '@classytic/arc/middleware';
import { defineGuard, withCompensation }                   from '@classytic/arc/utils';
```

A project importing only from the root barrel is probably under-using subpath features (caching, scope accessors, presets, MCP, testing harness).

## Non-negotiables (mirror in client projects)

1. No `console.log` in `src/` (except `cli/`) — use logger.
2. No `mongoose` / `drizzle-orm` / `@prisma/client` imports outside the host's adapter wiring file.
3. No `any` — use `unknown`. No `@ts-ignore` — fix the type.
4. No default exports in `src/` (knip enforces in arc).
5. Always read `request.user` via guard, or use `@classytic/arc/scope` accessors.
6. Always use `req.rawBody` for `verifySignature(...)`, never parsed body.
7. Set response headers in `onRequest` or `preSerialization`, never `onSend`.
8. `request.user: Record<string, unknown> | undefined` — required property, NOT optional.
