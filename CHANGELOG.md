# Changelog

## 2.8.5

### Fixed — Zod → Fastify schema regression

- **`z.number().positive() / .negative() / .gt() / .lt()` no longer break route registration.** The converter in `src/utils/schemaConverter.ts` used to hardcode `target: "openapi-3.0"`, which emits the draft-04 boolean form `exclusiveMinimum: true`. Fastify v5's AJV 8 is configured for draft-07 and rejects that at route registration with `schema is invalid: data/properties/X/exclusiveMinimum must be number`. The default target is now `"draft-7"` (matches Fastify's bundled AJV) and emits the numeric form AJV expects. OpenAPI doc generation still uses `"openapi-3.0"` so 3.0 consumers see the boolean form they expect.
- **`toJsonSchema()`, `convertRouteSchema()`, `convertOpenApiSchemas()`** now accept a `target: JsonSchemaTarget` argument (`"draft-7" | "draft-2020-12" | "openapi-3.0" | "openapi-3.1"`). Defaults are Fastify-first for validators and OpenAPI-first for doc generation.
- **`$schema` meta stripped** from converted Zod output so AJV strict mode stays quiet when the bundled draft and Zod's emitted `$schema` URI don't match.
- **`CrudSchemas` and `RouteDefinition.schema` slot types widened** from `Record<string, unknown>` to `unknown` so Zod class instances assign without `as unknown as Record<string, unknown>` casts at the wiring point.

### Added — `filesUploadPreset` + `Storage` contract

- **New preset** `filesUploadPreset({ storage, … })` from `@classytic/arc/presets/files-upload`. Registers three raw routes on the owning resource:
  - `POST /upload` — multipart parsed, file persisted via `storage.upload()`, returns `{ success: true, data: { id, url, pathname, contentType, bytes, metadata? } }`.
  - `GET /:id` — streams bytes back. Full HTTP Range support: single range (`bytes=start-end`), suffix (`bytes=-N`), open-ended (`bytes=N-`). Sends `Accept-Ranges: bytes` + `Content-Range` + 206 on partial reads. Falls back to server-side slicing when the adapter returns a full buffer.
  - `DELETE /:id` — 204 on success, 404 on already-absent.
- **New `Storage` interface** at `@classytic/arc/types/storage`. Deliberately minimal (5 methods, 3 optional). Adapters live in app source — arc ships zero reference adapters on purpose. `read(id, ctx, range?)` takes an optional `{ start, end }` range, end-inclusive, matching media-kit's `StorageDriver.read()` shape.
- **New contract suite** `runStorageContract(name, setup)` from `@classytic/arc/testing/storage`. Verifies any `Storage` adapter against 9 behavioral assertions (upload/read round-trip, delete idempotency, scope threading, lifecycle, stream+buffer kinds, ranged reads). Passing the contract guarantees preset compatibility.
- **Scope threading by default.** `contextFrom(scope)` defaults to `{ userId, organizationId }` extracted via `getUserId` / `getOrgId`. Override to project `projectId`, `workspaceId`, etc.
- **Per-route opt-outs** via `includeRoutes: { upload?, read?, delete? }` and per-route permissions via `permissions: { upload?, read?, delete? }`.
- **New subpath exports**: `./types/storage`, `./presets/files-upload`, `./testing/storage`. All tree-shakeable — pulling the preset does not drag in mongoose, S3 SDKs, or any storage-specific code.

### Added — `multipartBody({ requiredFields })`

- **New option** on the existing `multipartBody()` middleware: `requiredFields?: string[]`. When set, returns `400 { code: "MISSING_FILE_FIELDS", details: { missing } }` if any listed field is absent from the uploaded files. Singular vs plural wording handled automatically.
- **Stays no-op for JSON requests** — the middleware still short-circuits on non-multipart content types, so the same middleware remains safe to add to shared create/update routes that accept both JSON and multipart.
- **Discoverable from the options object** users already use (`maxFileSize`, `allowedMimeTypes`, `filesKey`). `filesKey` JSDoc now explicitly distinguishes "destination key on `req.body`" from "required source fields" to prevent confusion.

### Documentation

- New `docs/getting-started/files-upload.mdx` — full preset guide with four worked adapter samples (media-kit, raw S3, local FS, in-memory), `runStorageContract()` usage, when-not-to-use callout (OCR, ASR, classification flows belong in `multipartBody()` + raw route, not this preset).
- `docs/getting-started/presets.mdx` updated with a `filesUpload` entry.

## 2.8.4

### Added — MCP ↔ AI SDK bridge

- **MCP ↔ AI SDK bridge** — new helpers in `@classytic/arc/mcp`:
  - `bridgeToMcp(bridge)` exposes any AI SDK tool builder as an MCP tool with automatic auth, envelope translation, and error mapping.
  - `buildMcpToolsFromBridges(bridges, options)` takes a list of bridges and returns the registered MCP tool array, with optional `include`/`exclude` filtering for per-environment configuration (read-only deployments, strict allowlists).
  - `McpBridge.annotations` reuses the public `ToolAnnotations` type for consistency with `defineTool`.

### Added — distributed-system hardening (audit against Redis Inc + BullMQ specialist skills)

- **`jobsPlugin` wrapped with `fastify-plugin`** — `fastify.jobs.dispatch(...)` now works from the outer scope as documented (was previously encapsulated).
- **Stalled-job event bridge** — `worker.on('stalled', ...)` publishes `job.*.stalled` through the arc event bus so silent worker crashes can be alerted on.
- **Graceful shutdown pauses before closing** — `dispatcher.close()` now calls `worker.pause()` first so in-flight jobs drain on SIGTERM instead of being interrupted.
- **Repeatable / cron jobs** — `defineJob({ repeat: { pattern, tz } | { every } })`. Cron patterns require an explicit `tz` (enforced at register time) to prevent DST drift. Schedules are upserted on plugin register.
- **Large payload warning** — `dispatch()` logs a warning when serialized job data exceeds 100 KB ("pass IDs, not objects").
- **Naive ioredis detection** — `jobsPlugin` warns at register time when the Redis connection lacks `maxRetriesPerRequest: null` (the setting BullMQ requires to survive connection blips).
- **DLQ default name** uses `-dead` suffix instead of `:dead` (BullMQ rejects `:` in queue names).

### Added — Redis client adapters (DX wins)

- **`ioredisAsCacheClient(redis)`** and **`upstashAsCacheClient(redis)`** in `@classytic/arc/cache` — bridge either client to arc's `RedisCacheClient` contract without hand-rolled adapters.
- **`ioredisAsIdempotencyClient(redis)`** and **`upstashAsIdempotencyClient(redis)`** in `@classytic/arc/idempotency/redis` — same for the idempotency store.
- **Edge runtime support** — the `upstash*` adapters let arc's cache and idempotency layers run on Cloudflare Workers, Vercel Edge, and Deno Deploy via `@upstash/redis` (REST, no TCP).

### Added — performance

- **`RedisIdempotencyStore.findByPrefix()`** now fetches keys in concurrent batches of 10 with early termination on first unexpired match. On high-latency Redis (Upstash / ElastiCache across regions), this is roughly 10× faster than the previous sequential loop.

### Documentation

- **Bundle size section** in README with real numbers (~130 KB minimal), subpath-import pattern, and comparison vs Fastify/NestJS.
- **"Streams vs Pub/Sub" decision table** in `skills/arc/references/events.md` — prevents users from picking pub/sub for business-critical events.
- **Redis eviction policy guidance** — requires `noeviction` for any Redis backing queues/streams/idempotency, with per-provider notes (Upstash, self-hosted, ElastiCache).

## 2.8.3

- **Export `Guard<T>` and `GuardConfig<T>` types** from `@classytic/arc/utils` — fixes TS4023 when consumers re-export `defineGuard()` results in their own declaration files

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
