# Core

**Summary**: `defineResource` is the fundamental unit. Controllers are a mixin stack: `BaseCrudController` (CRUD core) + four preset mixins (SoftDelete / Tree / Slug / Bulk). `BaseController` is the pre-composed "everything" facade. `createCrudRouter` mounts handlers on Fastify.
**Sources**: src/core/.
**Last updated**: 2026-07-15 (history/audit-at-scale: retention, indexes, audit-log-as-resource).

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

**Canonical hook placement** (all three routers — CRUD, actions, aggregations — emit it via `buildRouteHooks`, 2.22):

```
onRequest:  preAuth → arcDecorator → authMw
preHandler: permissionMw → pluginMw → routeGuards → customMws
```

Auth sits at route-level `onRequest` — Fastify parses the body and runs AJV BETWEEN the stages, so unauthenticated requests 401 before paying parse/validate cost (and before a 400 leaks schema shape). Auth reads only headers/cookies/params/query; body-shaped middleware stays at preHandler. Elevation is unaffected (wraps the `authenticate` decorator, rides wherever auth runs). Consequence: unauthenticated invalid-body requests get 401, not 400 — including action posts. Pinned by `tests/core/auth-before-parse.test.ts`; full rationale in `core/middlewares/chain.ts`.

- `permissionMw` — CRUD uses the static `buildCrudPermissionMw` (permission known at route-registration time); actions use the dynamic `buildActionPermissionMw` (permission resolved from `body.action` at request time). Both apply `_policyFilters` + `request.scope` via `evaluateAndApplyPermission` **before** `pluginMw` (idempotency) runs — so unauthorized requests never record idempotency keys and route guards see the full permission-installed scope.
- `buildPipelineHandler` + `buildActionPipelineHandler` — both return `Promise<IControllerResponse<unknown>>`. Pipeline steps that need to fail throw an `ArcError` (or any `HttpError`-shaped class); the global error handler catches and serializes to the canonical `ErrorContract` wire shape.
- `buildAuthMiddlewareForPermissions(fastify, perms)` — accepts `ReadonlyArray<PermissionCheck | undefined>`. An explicit `allowPublic()` (`_isPublic: true`) AND an undefined slot ("public by omission") both flip the route-level auth decision to `optionalAuthenticate`. Treating undefined as "not a signal" broke `{ ping: undefined, promote: requireRoles([...]) }` — the public `ping` got 401'd at the auth layer before the per-action check could let it through. See [[gotchas]] #25.

See [[removed]] for the list of public action-router APIs retired in v2.9.

## Per-route rate limit (2.20)

`RouteDefinition.rateLimit?: RateLimitConfig | false` overrides the resource/app default for one custom endpoint (`{ max, timeWindow }` to tighten, `false` to never throttle, omit to inherit). Each custom route is its own Fastify route, so the override rides `config.rateLimit` cleanly — same primitive as aggregations. **Actions do NOT get a per-action limit**: they share one `POST /:id/action` mount, where Fastify's per-route limit can't distinguish them, so they inherit the resource limit — throttle a specific action by promoting it to a `routes:` entry (documented on `ActionDefinition`). Requires `@fastify/rate-limit` (arc's factory wires it).

## `history: true` — per-record audit timeline (2.22)

`defineResource({ history: true })` injects `GET /:prefix/:id/history` — that record's audit rows (`?limit=&offset=`, wire cap 200) — and **implies `audit: true`**. Requires `auditPlugin`; without it the route answers 503 `history.audit_unavailable`. Gate defaults stricter than reads: resource `update` permission → `get` → `requireAuth()`; override with `history: { permissions, limit }`. The flag is consumed in Phase-0 normalization (same contract as `customRoutesOnly` — expanded before the router ever sees it). See [[plugins]] for the audit plugin itself.

### History/audit at scale — retention, indexes, rich queries

Three concerns, three homes (framework/kit/recipe):

- **Retention** (audit rows ARE the history — prune them, history prunes with them): `auditPlugin({ retention: { maxAgeMs, purgeIntervalMs } })` runs a periodic `purgeOlderThan` → repo `deleteMany(timestamp < cutoff)`. **Multi-replica hosts**: set `purgeIntervalMs: 0` and drive `fastify.audit.purge(...)` from a [[plugins]] `schedulesPlugin` entry instead — leader-safe, jittered, observable (the built-in timer predates 2.21 and runs on every replica). **Mongo hosts** can skip both: a TTL index (`{ timestamp: 1 }, { expireAfterSeconds }`) makes the DB do it server-side — the store contract explicitly blesses this.
- **Indexes are kit territory** (the audit model is host-defined): Mongo — TTL index above + compound `{ resource: 1, documentId: 1, timestamp: -1 }` (covers the history-timeline query exactly); SQL kits — index `(resource, document_id, timestamp)` + the kit's ttl/sweep plugin (sqlitekit ships `ttlPlugin` with scheduled/trigger/lazy modes).
- **Rich search**: `audit.query()` is deliberately narrow (the timeline's needs). For an admin audit-log UI with full repo-core filter power, mount the audit repository AS a resource — `defineResource({ name: 'audit-log', crud: { list: true, get: true }, adapter: { repository: auditRepo }, queryParser: new QueryParser({ allowedFilterFields: ['resource', 'documentId', 'userId', 'action', 'organizationId'] }), permissions: { list: requireRoles(['auditor']), ... } })` — filters, sort, keyset pagination, MCP tools, and permission gating all arrive free. Rows are just documents; the composition IS the search API.

## Write-side field permissions (v2.9) + systemManaged strip (v2.11)

`BodySanitizer` rejects writes to denied fields with `ForbiddenError` listing them. Opt into silent strip via `onFieldWriteDenied: 'strip'`. Rationale: surface misconfigurations instead of hiding them. See [[gotchas]] #11.

**v2.11 companion fix:** any field rule with `systemManaged: true` is also stripped from adapter-generated `createBody` / `updateBody` `required[]` arrays via `stripSystemManagedFromBodyRequired` ([src/core/schemaOptions.ts](../src/core/schemaOptions.ts)). This closes the gotcha where Fastify preValidation rejected requests for fields the framework was about to inject (e.g. `organizationId` via `multiTenantPreset` + an engine with `tenant: { required: true }`).

## Schema-generation errors (v2.11)

Errors thrown from `adapter.generateSchemas()` / `convertOpenApiSchemas()` / the query-schema merge are non-fatal (the resource still boots + serves traffic) but no longer silent. `arcLog("defineResource").warn(...)` fires with the resource name + error message so contract drift is visible in startup logs. Honors `ARC_SUPPRESS_WARNINGS=1`.

## Related
- [[factory]] — how resources are registered into an app
- [[adapters]] — what `model` must satisfy
- [[testing]] — `tests/core/` + `tests/e2e/` cover this module
