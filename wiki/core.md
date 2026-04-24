# Core

**Summary**: `defineResource` is the fundamental unit. Controllers are a mixin stack: `BaseCrudController` (CRUD core) + four preset mixins (SoftDelete / Tree / Slug / Bulk). `BaseController` is the pre-composed "everything" facade. `createCrudRouter` mounts handlers on Fastify.
**Sources**: src/core/.
**Last updated**: 2026-04-24 (v2.11.0 mixin split + action-router parity via `routerShared`).

---

## `defineResource`

One config → everything. Carries: name, model/adapter, field rules, permissions, hooks, events, cache, routes, actions, presets.

```ts
defineResource({
  name: 'order',
  model,                                  // Mongoose model or RepositoryLike
  schemaOptions: { fieldRules: { ... } }, // v2 stringly-typed (v3: type-safe builder)
  permissions: { ... },                   // → [[permissions]]
  hooks: { ... },                         // → [[hooks]]
  events: { ... },                        // → [[events]]
  cache: { ... },                         // → [[cache]]
  actions: { ... },                       // custom non-CRUD routes
  onFieldWriteDenied: 'reject' | 'strip', // default reject (v2.9)
});
```

**2.11 hygiene:** `defineResource` never mutates the caller's config object (even on the no-preset path). A fresh shallow clone is always produced before `_appliedPresets` / tenant-field rule auto-inject run. Hosts can safely factor a shared base and spread it across multiple `defineResource` calls.

## Controller split (v2.11.0)

The pre-2.11 `BaseController` was a 1,589-LOC god class. 2.11 splits concerns into focused files:

- `BaseCrudController<TDoc>` (~870 LOC) — core machinery (`AccessControl`, `BodySanitizer`, `QueryResolver`, tenant threading, cache, hooks) + `list` / `get` / `create` / `update` / `delete`. Extend this for slim CRUD.
- `SoftDeleteMixin` — `getDeleted` / `restore`.
- `TreeMixin` — `getTree` / `getChildren`.
- `SlugMixin` — `getBySlug`.
- `BulkMixin` — `bulkCreate` / `bulkUpdate` / `bulkDelete`.
- `BaseController<TDoc>` — pre-composed `SoftDelete ∘ Tree ∘ Slug ∘ Bulk ∘ BaseCrudController`. Drop-in replacement for the pre-2.11 class. A companion interface declaration-merges `TDoc` through every method so `ctrl.bulkCreate(req)` returns `Promise<IControllerResponse<TDoc[]>>`.

```ts
// Full surface (every preset method)
class ProductController extends BaseController<Product> {}

// Slim CRUD only
class ReportController extends BaseCrudController<Report> {}

// Explicit mix
class OrderController extends SoftDeleteMixin(BulkMixin(BaseCrudController)) {}
```

All symbols exported from `@classytic/arc` (root) and `@classytic/arc/core`.

## `QueryResolver`

- Parses Arc's query string DSL → shape the adapter consumes.
- **`select` is preserved as-is** (string, array, or projection object). Do NOT normalize — it breaks DB-agnostic compatibility. See [[gotchas]] #5.
- Operator suffixes: `field[gt]`, `field[in]`, etc. — documented in `src/utils/queryParser*`. `contains` / `like` emit `$options: "i"` (case-insensitive per docs, v2.10.9 fix).
- Post-construction swap: `BaseCrudController.setQueryParser(qp)` rebuilds the resolver with a new parser. `defineResource` calls this automatically when both `controller` and `queryParser` are supplied.

## `createCrudRouter` + `createActionRouter`

`createCrudRouter` mounts CRUD handlers on Fastify from the resource definition. `createActionRouter` (internal since v2.9 — declare actions via `defineResource({ actions })`) mounts the unified `POST /:id/action` endpoint. Both delegate every cross-cutting concern — auth, permission, pipeline, preHandler composition, response shaping — to shared primitives in [src/core/routerShared.ts](../src/core/routerShared.ts) so CRUD and actions can't silently drift.

**Canonical preHandler order** (both routers emit it via `buildPreHandlerChain`):

```
preAuth → arcDecorator → authMw → permissionMw → pluginMw → routeGuards → customMws
```

- `permissionMw` — CRUD uses the static `buildCrudPermissionMw` (permission known at route-registration time); actions use the dynamic `buildActionPermissionMw` (permission resolved from `body.action` at request time). Both apply `_policyFilters` + `request.scope` via `evaluateAndApplyPermission` **before** `pluginMw` (idempotency) runs — so unauthorized requests never record idempotency keys and route guards see the full permission-installed scope.
- `buildPipelineHandler` + `buildActionPipelineHandler` — both return `Promise<IControllerResponse<unknown>>` so a pipeline step that returns `{ success: false, status: 422, error, details, meta }` reaches `sendControllerResponse` with every field intact.
- `buildAuthMiddlewareForPermissions(fastify, perms)` — accepts `ReadonlyArray<PermissionCheck | undefined>`. An explicit `allowPublic()` (`_isPublic: true`) AND an undefined slot ("public by omission") both flip the route-level auth decision to `optionalAuthenticate`. Treating undefined as "not a signal" broke `{ ping: undefined, promote: requireRoles([...]) }` — the public `ping` got 401'd at the auth layer before the per-action check could let it through. See [[gotchas]] #25.

See [[removed]] for the list of public action-router APIs retired in v2.9.

## Write-side field permissions (v2.9) + systemManaged strip (v2.11)

`BodySanitizer` rejects writes to denied fields with `ForbiddenError` listing them. Opt into silent strip via `onFieldWriteDenied: 'strip'`. Rationale: surface misconfigurations instead of hiding them. See [[gotchas]] #11.

**v2.11 companion fix:** any field rule with `systemManaged: true` is also stripped from adapter-generated `createBody` / `updateBody` `required[]` arrays via `stripSystemManagedFromBodyRequired` ([src/core/schemaOptions.ts](../src/core/schemaOptions.ts)). This closes the gotcha where Fastify preValidation rejected requests for fields the framework was about to inject (e.g. `organizationId` via `multiTenantPreset` + an engine with `tenant: { required: true }`).

## Schema-generation errors (v2.11)

Errors thrown from `adapter.generateSchemas()` / `convertOpenApiSchemas()` / the query-schema merge are non-fatal (the resource still boots + serves traffic) but no longer silent. `arcLog("defineResource").warn(...)` fires with the resource name + error message so contract drift is visible in startup logs. Honors `ARC_SUPPRESS_WARNINGS=1`.

## Related
- [[factory]] — how resources are registered into an app
- [[adapters]] — what `model` must satisfy
- [[testing]] — `tests/core/` + `tests/e2e/` cover this module
