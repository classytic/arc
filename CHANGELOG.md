# Changelog

## 2.9.2

- **Fix: onSend header mutation no longer trips `ERR_HTTP_HEADERS_SENT`
  under `light-my-request`.** When an action route, error handler, or
  404 path flushed the response before the onSend chain resolved, any
  plugin that called `reply.header(...)` in its onSend hook caused
  Fastify's `safeWriteHead` to try writing headers twice — producing
  unhandled rejections in vitest (CRUD POST intermittent, action POST
  ~100%, GET 404 ~100%). Primary reporter: `cachingPlugin`. Same class
  of bug applied to `versioningPlugin`, `requestIdPlugin`,
  `responseCachePlugin`, and `idempotencyPlugin` — all fixed in this
  patch via a shared `isReplyCommitted(reply)` guard
  (`src/utils/reply-guards.ts`). No-op under a real HTTP server.
- Regression tests added — spy on `reply.header` to assert the plugin
  skips mutation when `reply.raw.headersSent === true`. Tests fail
  without the guard, pass with it.
- Shared `repositoryAs*` helpers extracted to `src/adapters/store-helpers.ts`
  (`isNotFoundError`, `createSafeGetOne`, `createIsDuplicateKeyError`) —
  outbox + idempotency adapters lose ~76 lines of duplicated cross-kit
  error handling. Behavior unchanged.

## 2.9.1

**Breaking — MongoDB wrapper stores removed.** `auditPlugin`,
`idempotencyPlugin`, and `EventOutbox` now take `repository: RepositoryLike`
directly — pass a `Repository` from mongokit / prismakit / your own kit.
Arc calls `create`, `getOne`, `findAll`, `deleteMany`, `findOneAndUpdate`
on it. Removed: `MongoAuditStore`, `MongoIdempotencyStore`,
`MongoOutboxStore`, and their `/audit/mongodb`, `/idempotency/mongodb`,
`/events/mongo` subpaths. Memory + Redis escape hatches unchanged.

**Breaking — routes API cleanup (pre-1.0).** `additionalRoutes` → `routes`,
`wrapHandler: false` → `raw: true`, `AdditionalRoute` → `RouteDefinition`.
`CrudRouterOptions.additionalRoutes` → `routes`. `TestHarness.runCrud()`
removed — use `HttpTestHarness.runCrud()`.

**`RepositoryLike` / `CrudRepository` additions**
- Optional `findOneAndUpdate(filter, update, options)`. `context.query` is
  the canonical filter field across all methods.
- Optional `isDuplicateKeyError(err): boolean` — kit-owned dup-key
  classification. Fallback is Mongo (`code 11000`), so mongokit ≤3.8 keeps
  working. Non-mongo kits implement to participate in idempotency.
- Optional `search?`, `searchSimilar?`, `embed?`, `buildAggregation?`,
  `buildLookup?` type hints (opt-in).

**`errorHandlerPlugin`** detects dup-key errors out of the box across
MongoDB (`11000`), Prisma (`P2002`), Postgres (`23505` — Neon/Cockroach),
MySQL/MariaDB (`ER_DUP_ENTRY` / `1062`), SQLite (`SQLITE_CONSTRAINT_*`).
`duplicateFields` extracted from each driver's native shape. Export
`defaultIsDuplicateKeyError` from `/plugins` for composition. Detection is
by driver codes only — never message strings.

**`searchPreset`** — `@classytic/arc/presets/search`. Mounts `POST /search`,
`/search-similar`, `/embed` without assuming a search backend. Auto-wires
from `repo.search` / `searchSimilar` / `embed` (verified against mongokit
3.6 native conventions). Explicit handlers win for Pinecone / Algolia /
custom. Zod v4 schemas pass through to AJV + OpenAPI.

**Pagination `TExtra` generic** — `OffsetPaginatedResult<TDoc, TExtra>`,
`KeysetPaginatedResult<TDoc, TExtra>`, `PaginationResult<TDoc, TExtra>`.
Opt-in for kit-specific metadata (tookMs, region, cursor version).
Defaults to `{}` — existing code unchanged. Added `warning?: string` for
deep-pagination hints.

**Other**
- MCP tools now emit for all custom + preset routes (no longer gated on
  `resource.adapter`).
- `filesUploadPreset.sanitizeFilename: boolean | '*' | fn` — relaxes
  default strict filename rules for microservice contexts.
- `multipartBody.allowedMimeTypes` accepts `'*'`, `'*/*'`, `type/*`.
- `idempotencyPlugin.namespace` folds into fingerprint for shared stores
  (prod + canary on one Redis).
- `webhooks.verifySignature` throws `TypeError` loudly when body is
  parsed instead of string/Buffer.
- Elevation plugin emits `arc.scope.elevated` on every elevation.
- `searchSimilar` auto-wire now passes single `VectorSearchParams` object
  (was positional — options were silently dropped).
- MCP custom-route handlers support inline function handlers.
- `src/events/outbox.ts` split into `outbox.ts`, `memory-outbox.ts`,
  `repository-outbox-adapter.ts`. Similar split for audit + idempotency.
- Peer: `@classytic/mongokit ≥3.8.0`.

```ts
import { Repository, methodRegistryPlugin, batchOperationsPlugin } from '@classytic/mongokit';

// Audit needs create + findAll — vanilla Repository works
await fastify.register(auditPlugin, {
  enabled: true,
  repository: new Repository(AuditModel),
});

// Idempotency + Outbox also need deleteMany → register batch-operations
const plugins = [methodRegistryPlugin(), batchOperationsPlugin()];

await fastify.register(idempotencyPlugin, {
  enabled: true,
  repository: new Repository(IdempotencyModel, plugins),
});

new EventOutbox({
  repository: new Repository(OutboxModel, plugins),
  transport,
});
```

## 2.8.5

- **Zod → Fastify schema fix** — `z.number().positive()` etc. no longer
  break route registration. `schemaConverter` defaults to `"draft-7"`
  (matches Fastify's AJV 8); OpenAPI generation keeps `"openapi-3.0"`.
  `toJsonSchema()` / `convertRouteSchema()` / `convertOpenApiSchemas()`
  take a `target` argument.
- **`filesUploadPreset`** — `@classytic/arc/presets/files-upload`. Raw
  `POST /upload`, `GET /:id` (with HTTP Range), `DELETE /:id`. Pluggable
  `Storage` contract (5 methods, 3 optional). No reference adapters ship —
  app source owns them. `runStorageContract()` for adapter conformance.
- **`multipartBody({ requiredFields })`** — returns 400 with
  `MISSING_FILE_FIELDS` if any listed field is absent. No-op for JSON.

## 2.8.4

- **MCP ↔ AI SDK bridge** — `bridgeToMcp()`, `buildMcpToolsFromBridges()`
  with include/exclude filtering.
- **`jobsPlugin` hardening** — wrapped with `fastify-plugin`, stalled-job
  bridge, `worker.pause()` on shutdown, repeatable/cron (`tz` required),
  large-payload warning (>100 KB), naive-ioredis detection, DLQ uses
  `-dead` suffix.
- **Redis adapters** — `ioredisAsCacheClient`, `upstashAsCacheClient`,
  `ioredisAsIdempotencyClient`, `upstashAsIdempotencyClient`. Edge
  runtimes work via upstash (REST).
- **`RedisIdempotencyStore.findByPrefix()`** batched (10 concurrent) with
  early termination — ~10× faster on high-latency Redis.

## 2.8.3

- Export `Guard<T>` / `GuardConfig<T>` from `/utils` (fixes TS4023).

## 2.8.2

- **`CrudRepository<TDoc>`** — tiered Required / Recommended / Optional.
- **Hard delete forwarding** — `?hard=true` → `repo.delete({ mode: 'hard' })`.
- **`RepositoryLike`** expanded (count, exists, distinct, bulkWrite,
  aggregate, withTransaction).
- **Actions** — per-action discriminated body validation (AJV enforces),
  Zod v4 / JSON Schema / field map, OpenAPI + MCP auto-generation,
  route-level `mcp: false`.
- **Outbox** — `claimPending`, `fail`, write options (session, visibleAt,
  dedupeKey), `RelayResult` per-kind counts, `publishMany` auto-detected,
  `exponentialBackoff()`, `OutboxOwnershipError`, `InvalidOutboxEventError`,
  `onError` callback. `delivered`/`deliveredAt` canonical.
- **`routeGuards`** on `defineResource()` — resource-level preHandlers
  auto-applied to every route. **`defineGuard()`** — typed preHandler +
  context pair with `guard.from(req)` type inference.
- Fixes: `slugLookup` fallback, restore hooks fire, fieldRules → OpenAPI
  parity, preset routes + `routes` merge correctly.
- Peer: `@classytic/mongokit ≥3.6.0`.

## 2.8.0

- `routes` replaces `additionalRoutes` (`raw: true` instead of
  `wrapHandler: false`). `actions` on `defineResource()` — declarative
  state transitions.

## 2.7.x

- **2.7.7** — WorkflowRunLike type fix, MongoKit 3.5.6 peer.
- **2.7.5** — CI fix, console cleanup, streamline execute/waitFor, MCP E2E.
- **2.7.3** — DX helpers, service scope, security fixes.
- **2.7.2** — Webhooks `verifySignature`, lifecycle cleanup, bounded concurrency.
- **2.7.1** — `allOf()` scope fix, `requireServiceScope`, MCP auth + org scoping.

## 2.6.x

- **2.6.3** — `idField` override end-to-end (AJV accepts custom PKs).
- **2.6.2** — Event WAL for durable at-least-once delivery.
- **2.6.0** — Audit trail plugin + stores, idempotency plugin.

## 2.5.5

- `createApp({ resources })`, `loadResources()`, bracket-notation filters,
  body sanitizer.

## 2.4.x

- **2.4.3** — Better Auth adapter, org scoping, role hierarchy, field-level perms.
- **2.4.1** — Initial public release.
