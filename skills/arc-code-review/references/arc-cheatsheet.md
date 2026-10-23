# Arc at a glance (for gap detection)

For full API read the arc skill. Use this to recognize what a project hand-rolls.

## defineResource surface

```ts
defineResource({
  name, displayName, tag, prefix, skipGlobalPrefix, module,
  adapter,                                   // from the kit's /adapter subpath
  controller, writes, transactional, concurrency,
  permissions: { list, get, create, update, delete },
  presets, hooks, pipe, middlewares, routeGuards,
  routes, actions, actionPermissions, aggregations,
  schemaOptions: { fieldRules, query, ... }, customSchemas, openApiSchemas,
  fields, onFieldWriteDenied, onImmutableWrite,
  tenantField, onTenantDelete, idField, lookupFields, defaultSort, defaultLimit, maxLimit,
  cache, events, audit, history, rateLimit, idempotency, mcp, queryParser,
  disableDefaultRoutes, disabledRoutes, crud,
  strictPermissions, strictSchemas, skipValidation,
});
```

`writes` binds a CRUD slot to a domain command while keeping sanitize, tenant injection and hooks. `transactional: true` runs each write in a retrying repository transaction. `concurrency` enables ETag and `If-Match`. `history: true` adds `GET /:id/history`.

## Permissions

```ts
allowPublic()   requireAuth()   requireRoles(["admin"])   requireOwnership("userId")
requireOrgMembership()   requireOrgRole("admin")   requireTeamMembership()
requireServiceScope("jobs:bulk")   requireScopeContext("branchId")   requireOrgInScope(targetId)
allOf(...)  anyOf(...)  not(...)  when(...)  denyAll()
permissionMatrix({ read, write, delete? })   createDynamicPermissionMatrix({ ... })
```

All from `@classytic/arc/permissions` (the common ones also from the root). A check returns `boolean` or a decision carrying `filters` (row-level policy) and `scope`. Field level: `fields.hidden()`, `visibleTo`, `writableBy`, `redactFor`, passed in the resource `fields` option.

## RequestScope

```ts
type RequestScope =
  | { kind: "public" }
  | { kind: "authenticated"; userId?; userRoles? }
  | { kind: "member"; userId?; userRoles; organizationId; orgRoles; teamId?; context?; ancestorOrgIds? }
  | { kind: "service"; clientId; organizationId; scopes?; context?; ancestorOrgIds?; mandate?; dpopJkt? }
  | { kind: "elevated"; userId?; organizationId?; elevatedBy; context?; ancestorOrgIds? };
```

Read only through `@classytic/arc/scope`: `getUserId`, `getOrgId`, `requireOrgId`, `requireUserId`, `getScopeContext`, `isOrgInScope`, `hasOrgAccess`.

## Presets

| Preset | Adds | Config |
|---|---|---|
| `softDelete` | `GET /deleted`, `POST /:id/restore` | |
| `slugLookup` | `GET /slug/:slug` | `slugField` |
| `tree` | tree and children routes | `parentField` |
| `ownedByUser` | owner scoping | `ownerField` |
| `multiTenant` | tenant scoping | `tenantField` or `tenantFields` |
| `audited` | audit writes | |
| `bulk` | bulk create, update, delete | `operations`, `maxCreateItems` |
| `filesUpload` | upload routes | `storage`, `allowedMimeTypes`, `maxFileSize` |
| `search` | search, similar, embed routes | `search`, `similar`, `embed` |

## fieldRules flags

`systemManaged`, `preserveForElevated`, `immutable`, `immutableAfterCreate`, `optional`, `nullable`, `hidden`, `aggregable`, `minLength`, `maxLength`, `min`, `max`, `pattern`, `enum`, `description`.

## createApp options that replace host code

`auth`, `modules`, `resources`, `resourcePrefix`, `beforeBoot`, `plugins`, `bootstrap`, `afterResources`, `onReady`, `onClose`, `stores` (`events`, `cache`, `idempotency`, `queryCache`), `errorHandler`, `rateLimit`, `cors`, `helmet`, `elevation`, `multipart`, `rawBody`, `ports`, `moduleGraph`, `preset` (`production`, `development`, `testing`, `edge`, `worker`), and `arcPlugins`: `requestId`, `health`, `gracefulShutdown`, `emitEvents`, `events`, `schedules`, `caching`, `sse`, `realtime`, `queryCache`, `metrics`, `versioning`.

Boot order: `beforeBoot`, module resolve, arc core, `plugins`, `bootstrap`, `resources`, `afterResources`, `onReady`, `onClose`.

## Subpaths and what lives there

| Subpath | Holds |
|---|---|
| `@classytic/arc` | `defineResource`, `defineAction`, `defineAggregation`, `mergeResourceConfig`, controllers, mixins, errors, common permissions |
| `/core` | `routeInput`, `crudInput`, `parsed`, `noPayloadSchema`, `defineAction` |
| `/factory` | `createApp`, `defineModule`, `getModuleExports`, `loadResources` |
| `/permissions`, `/scope` | checks, matrices, scope accessors |
| `/presets` | `multiTenantPreset`, `bulkPreset`, ... |
| `/plugins` | `schedulesPlugin`, `createDailyGate`, `createMemoryDailyLedger`, `errorHandlerPlugin`, `healthPlugin`, `ssePlugin` |
| `/cache`, `/events`, `/idempotency`, `/audit` | stores, transports, outbox, plugins |
| `/utils` | errors, `createDomainError`, `defineErrorMapper`, `ArcQueryParser` |
| `/mcp`, `/docs`, `/testing` | MCP plugin, OpenAPI, test harnesses |
| `/integrations/jobs`, `/integrations/webhooks`, `/integrations/websocket` | queue, signed webhooks, sockets |

Imports only from the root barrel suggest under-use of caching, scope, presets, MCP and testing.

## Non-negotiables to mirror in client code

1. No `console.log` in `src/`; use the logger.
2. No driver imports outside model, repository and adapter files.
3. No `any`, no `@ts-ignore`, no default exports.
4. Read `request.user` only behind a guard, or use scope accessors.
5. Verify webhooks over `req.rawBody`.
6. Set headers in `onRequest` or `preSerialization`, never async `onSend`.
