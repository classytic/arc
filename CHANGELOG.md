# Changelog

## 2.8.2

### Repository Contract

- `CrudRepository<TDoc>` — canonical contract tiered into Required / Recommended / Optional
- Hard delete forwarding — `DELETE /:id?hard=true` flows to `repo.delete({ mode: 'hard' })`
- `BaseController.delete` — accepts both mongokit and raw driver result shapes
- `BaseController.getDeleted` — handles keyset pagination, passes parsed query to repo
- `RepositoryLike` expanded with optional capabilities (count, exists, distinct, bulkWrite, aggregate, withTransaction)
- New typed option/result types (DeleteOptions, DeleteResult, PaginationResult, etc.)
- `@classytic/mongokit` peer dep bumped to `>=3.6.0`
- Repository contract conformance test (31 tests) — kit authors: copy and swap in your adapter

### Actions + Routes

- Per-action discriminated validation — `oneOf` body schema, AJV enforces required fields at HTTP layer
- Zod v4 action schemas — accepts Zod, full JSON Schema, or legacy field map
- `buildActionBodySchema()` — single source of truth for runtime router + OpenAPI
- Actions in OpenAPI — `POST /:id/action` auto-generated with discriminated body schema
- Actions in registry — `RegistryEntry.actions` for introspection, `totalRoutes` includes action endpoint
- **Actions in MCP** — `resourceToTools()` generates one tool per action (`{action}_{resource}`), with input schema from action schema, per-action permission checks, `mcp: false` opt-out
- **Route-level MCP config honored** — `mcp: false` skips route from tool generation, `mcp: { description, annotations }` overrides defaults
- Route metadata preserved — `mcp`, `description`, `annotations` survive normalization
- `ResourceDefinition.routes/actions` retained — original config available to downstream consumers
- `additionalProperties` open by default in action schemas — documented: extra fields pass through to handlers unless the app author supplies a full schema with `additionalProperties: false`

### Outbox

- Expanded `OutboxStore` contract — `claimPending`, `fail`, write options (`session`, `visibleAt`, `dedupeKey`), all optional + backward-compatible
- `relayBatch()` — returns `RelayResult` with per-kind counts (relayed, publishFailed, ackFailed, ownershipMismatches, malformed)
- `publishMany` support — optional batched publish on `EventTransport`, auto-detected by relay
- `exponentialBackoff()` — retry helper for store authors implementing `fail()` with backoff
- `OutboxOwnershipError` — stores must throw on mismatch; relay handles it correctly
- `InvalidOutboxEventError` — `EventOutbox.store()` validates before persistence
- `onError` callback — non-fatal error reporting for logging/metrics
- Terminology aligned — `delivered` / `deliveredAt` is canonical; `acknowledgedAt` deprecated
- Backend guarantees documented — Mongo/SQL vs Redis/Kafka atomicity + durability table

### Fixes

- `slugLookup` fallback — `getOne({ [slugField]: slug })` when `getBySlug` missing
- Restore lifecycle hooks — `before:restore` / `around:restore` / `after:restore` now fire from `BaseController.restore()`, symmetric with delete hooks
- **fieldRules → OpenAPI parity** — `minLength`, `maxLength`, `min`, `max`, `pattern`, `enum`, `description` from `fieldRules` now auto-map to OpenAPI schema properties (was already working for MCP tools, now consistent). Mongoose model-level constraints still take precedence.
- `RouteSchemaOptions.fieldRules` type now declares constraint fields explicitly (`minLength`, `maxLength`, `min`, `max`, `pattern`, `enum`, `description`) for IDE autocomplete
- `ErrorMapper` type now exported from `@classytic/arc/plugins` — consumers can type custom error mappers
- **Preset routes lost when `routes` also defined** — `presets: ['softDelete']` + `routes: [...]` silently dropped preset routes (`/deleted`, `/:id/restore`). Now both are merged correctly.
- README version sync

### DX

- **`routeGuards`** on `defineResource()` — resource-level preHandlers that auto-apply to every route (CRUD + custom `routes` + preset routes). Runs after auth/permissions, before per-route `preHandler`. Eliminates per-handler guard boilerplate.
- **`defineGuard()`** helper (`@classytic/arc/utils`) — typed preHandler + context extraction pair. Guard runs once, result accessible via `guard.from(req)` with full type inference. Composes with `routeGuards`.

### Tests

- 150+ new tests across repository contract, actions, routes, outbox, route guards, defineGuard

## 2.8.0

- **`routes`** replaces `additionalRoutes` — `raw: true` instead of `wrapHandler: false`
- **`actions`** on `defineResource()` — declarative state transitions (Stripe pattern)
- **`actionPermissions`** fallback, **`onRegister` scope fix**
- 40 new tests

```typescript
// Before (v2.7)
additionalRoutes: [
  { method: 'GET', path: '/stats', handler: fn, wrapHandler: false, permissions: auth() },
],

// After (v2.8)
routes: [
  { method: 'GET', path: '/stats', handler: fn, raw: true, permissions: auth() },
],
actions: { approve: handler },
```

---

## 2.7.7

- WorkflowRunLike type fix, MongoKit 3.5.6 peer dep

## 2.7.5

- CI pipeline fix, runtime console cleanup, streamline execute/waitFor, MCP E2E script

## 2.7.3

- DX helpers, service scope, security fixes

## 2.7.2

- Webhooks: verifySignature, lifecycle cleanup, bounded concurrency

## 2.7.1

- `allOf()` scope plumbing fix, `requireServiceScope` helper, service scope in multiTenant preset, MCP auth + org scoping

## 2.6.3

- `idField` override works end-to-end (custom primary keys no longer rejected by AJV)

## 2.6.2

- Event WAL (write-ahead log) for durable at-least-once delivery, `arc.*` event skip

## 2.6.0

- Audit trail plugin + stores, per-resource opt-in, idempotency plugin

## 2.5.5

- `createApp({ resources })`, `loadResources()`, bracket notation filters, body sanitizer

## 2.4.3

- Better Auth adapter, org scoping, role hierarchy, field-level permissions

## 2.4.1

- Initial public release — defineResource, BaseController, CRUD router, permissions, events, cache, presets
