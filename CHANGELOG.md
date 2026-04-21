# Changelog

## 2.10 — migration notes (from 2.9.x)

**Tightened `ActionHandler` req type.** The third argument of action
handlers (`defineResource({ actions: { foo: (id, data, req) => ... } })`)
is now typed `RequestWithExtras` instead of the bare `FastifyRequest`.
`RequestWithExtras` adds the arc-populated `arc`, `context`,
`_policyFilters`, `fieldMask`, `_ownershipCheck` fields that every action
handler was reaching for via `as any` — now they're on the type.

- **Breaking for code that assigned the handler to a `FastifyRequest`-typed
  local** (several be-prod files broke here). Fix: let TS infer the param
  type, or import `RequestWithExtras` from `@classytic/arc` and use it
  explicitly.
- Non-breaking if you used `req: any` or inferred — the runtime object
  is unchanged.

**`EventsDecorator.subscribe` handler signature clarified.** Handlers
receive a `DomainEvent<T> = { type, payload, meta }` envelope — *not* a
bare payload. This has always been the runtime shape; the type now
reflects it:

```ts
// Before (runtime contract, loosely typed):
fastify.events.subscribe('order.created', async (event) => {
  // event was typed `unknown` — you had to cast
});

// After (explicit envelope type):
fastify.events.subscribe('order.created', async (event) => {
  event.type;             // 'order.created'
  event.payload;          // your typed payload
  event.meta.timestamp;   // Date
  event.meta.correlationId;
});
```

If you wrote handlers against the old `unknown` type and destructured
`payload` directly, nothing changes at runtime — only the type is now
narrower. If you wrote `(payload) => ...` assuming the argument was the
payload, switch to `(event) => event.payload`.

## 2.10.4 — expose `middleware` / `pipeline` / `context` / `logger` subpaths

Four barrel modules had source, tests, and `index.ts` barrels but no
`package.json` export entry and no `tsdown` build entry — so consumers
could only reach them through the root barrel, which either re-exported
a subset (leaking the rest) or didn't re-export them at all. Surfaced by
the fajr-be-arc team when `@classytic/arc/middleware` 404'd on import —
the only way to get `multipartBody` was to inline a ~160-line copy of
[src/middleware/multipartBody.ts](src/middleware/multipartBody.ts) into
the app, with no way to pick up upstream fixes.

| Subpath | Symbols newly reachable |
|---|---|
| `@classytic/arc/middleware` | `multipartBody`, `ParsedFile`, `MultipartBodyOptions` (were unreachable from any public path), plus `middleware`, `sortMiddlewares`, `NamedMiddleware` |
| `@classytic/arc/pipeline` | `executePipeline`, `NextFunction`, `OperationFilter` (were unreachable — `NextFunction` is the parameter type for `intercept` handlers, so anyone writing interceptors hit TS2724), plus `guard`, `intercept`, `pipe`, `transform`, `Guard`, `Interceptor`, `PipelineConfig`, `PipelineContext`, `PipelineStep`, `Transform` |
| `@classytic/arc/context` | `requestContext`, `RequestStore` |
| `@classytic/arc/logger` | `arcLog`, `configureArcLogger`, `ArcLogger`, `ArcLoggerOptions`, `ArcLogWriter` |

**Root re-exports removed** for the same four modules. The root barrel's
own doc comment already stated "this main entry exports ONLY the
essentials — all other features live in dedicated subpaths — Node.js does
NOT tree-shake, so barrel re-exports load eagerly at runtime," but
`requestContext`, `middleware`/`sortMiddlewares`/`NamedMiddleware`,
`guard`/`intercept`/`pipe`/`transform` (+ pipeline types), and
`arcLog`/`configureArcLogger` (+ logger types) were still re-exported
from root and pulled their transitive graphs into every consumer that
imported anything from `@classytic/arc`. Removing them brings root in
line with the documented policy.

**Consumer migration** — mechanical search-and-replace:

```ts
// Before
import { requestContext, arcLog, guard, intercept, middleware } from '@classytic/arc';

// After
import { requestContext } from '@classytic/arc/context';
import { arcLog } from '@classytic/arc/logger';
import { guard, intercept } from '@classytic/arc/pipeline';
import { middleware } from '@classytic/arc/middleware';
```

Regression guard: [tests/smoke/exports.test.ts](tests/smoke/exports.test.ts)
now asserts both that the four new subpaths resolve and that each one's
headline symbols (`multipartBody`, `executePipeline`, `requestContext.run`,
`arcLog`) are reachable. A future accidental drop would fail `npm run test:ci`.

## 2.10.3 — plugin onSend race closures + idempotency lock-leak fix

Follow-up sweep to 2.9.3's `caching.ts` → `preSerialization` migration.
2.9.2 introduced `isReplyCommitted()` guards across five plugins as a
defensive patch for an async-onSend race with Fastify's
`onSendEnd → safeWriteHead` flush path. The guard silenced unhandled
rejections but didn't close the race window. 2.9.3 fixed `caching.ts`.
2.10.3 finishes the sweep for the remaining four:

| Plugin | Before | After | Why |
|---|---|---|---|
| [`requestId`](src/plugins/requestId.ts) | `onSend` | **`onRequest`** | Static header, known on arrival — fires for every response including 204/streams |
| [`versioning`](src/plugins/versioning.ts) | `onSend` | **`onRequest`** (merged with existing hook) | Static header derived from request; saves one async hook per request |
| [`response-cache`](src/plugins/response-cache.ts) | `onSend` | **`preSerialization`** | Needs payload — mirrors `caching.ts`'s 2.9.3 pattern |
| [`idempotency`](src/idempotency/idempotencyPlugin.ts) | `onSend` | **`preSerialization` + `onResponse`** | Split hook — body caching stays in preSerialization; lock release moves to onResponse (fires for EVERY response path) |

**Observed impact (be-prod, 3–4s Atlas latency from Bangladesh):**
slow `GET` responses no longer produce `ERR_HTTP_HEADERS_SENT` unhandled
rejections that triggered `process.on('unhandledRejection')` →
graceful-shutdown cascades. Full `be-prod` vitest suite: 75/75 pass,
0 unhandled rejections (was 13).

### Idempotency lock-leak on empty-body responses

Fastify skips `preSerialization` when the payload is `null` / `undefined`
— so a naive onSend → preSerialization move would have introduced a new
bug: 204 responses, `reply.code(200).send()` with no argument, and any
empty non-2xx reply would never unlock the idempotency key, holding the
lock until `ttlMs` expired and blocking legitimate retries.

**Fix — split responsibilities across two hooks:**

- `preSerialization` handles only body caching (correctly skipped for
  empty responses — nothing to cache)
- `onResponse` handles unlock for every response path (success, empty
  2xx, 4xx, 5xx, errors). Fires after flush, so no header race possible.
- `X-Idempotency-Key` response header moved to the idempotency middleware
  itself (earliest point the key is guaranteed-known and route-applicable),
  so it survives empty-body replies where the hook is skipped.
- The former `onError` hook is removed — subsumed by the universal
  `onResponse` unlock.

Regression tests added to [`tests/idempotency/plugin-integration.test.ts`](tests/idempotency/plugin-integration.test.ts)
for 204, empty-200, and empty-404 paths.

### Contributor invariant (new CLAUDE.md gotcha #15)

Arc plugins set response headers at `onRequest` (if the value is derivable
from the request) or `preSerialization` (if payload-dependent). `onSend`
is reserved for diagnostic tracing and final byte-level transforms — never
for header mutation.

`isReplyCommitted()` still ships at [src/utils/reply-guards.ts](src/utils/reply-guards.ts)
for third-party plugin authors; arc's own plugins no longer import it.

## 2.10.2 — fix: silent pagination in audit/outbox adapters

**Critical bug fix — 2.10.0 and 2.10.1 are deprecated on npm.**
**2.10.2 is unpublished** — use 2.10.3 which contains this fix plus the
plugin race closures.

Arc's `repositoryAsAuditStore.query()`, `repositoryAsOutboxStore.getPending()`,
`repositoryAsOutboxStore.getDeadLettered()`, and the purge batch loop all
called `repository.findAll(filter, { skip?, limit })`. mongokit's `findAll`
signature is `findAll(filter, OperationOptions)` — `OperationOptions` has
no `skip` or `limit` fields, so those were silently dropped. Consequence:

- `audit.query({ limit: 10 })` returned **every audit row** in the table
- `outbox.getPending(10)` returned every pending event
- `outbox.getDeadLettered(5)` returned every DLQ entry
- `outbox.purge()` fetched every delivered doc per batch iteration (memory
  blow-up on large outboxes)

**Fix** — switched the four call sites to `repository.getAll(params)`, which
takes `{ filters, sort, page, limit, select }` and returns the offset
pagination envelope `{ docs, ... }`. The adapter unwraps `.docs` and
handles both array + envelope returns for kit flexibility.

**AuditQueryOptions.offset → page conversion** — `AuditStore.query` exposes
offset-based pagination, mongokit exposes page-based. The adapter now
converts `page = Math.floor(offset / limit) + 1`. Callers using the
standard `offset = (page - 1) * limit` pattern get exact results;
unaligned offsets round down to the nearest page boundary (rare case,
documented).

**`missing`-methods check updated** — the outbox adapter now requires
`getAll` (on repo-core's `MinimalRepo` floor, guaranteed to be present)
instead of the optional `findAll`.

**Regression tests added** in
[`tests/integration/strict-false-plugins.test.ts`](tests/integration/strict-false-plugins.test.ts):

- `audit.query()` respects limit/offset with 25-row seed
- `outbox.getPending(5)` bounds to 5 of 15
- `outbox.getDeadLettered(3)` bounds to 3 of 8

## 2.10.1 — additive: expose repo→store adapters + mongokit ≥3.10.2

**Additive (no breaking changes):**

- `repositoryAsOutboxStore` — now re-exported from `@classytic/arc/events`
- `repositoryAsAuditStore` — now re-exported from `@classytic/arc/audit`
- `repositoryAsIdempotencyStore` — now re-exported from `@classytic/arc/idempotency`

The functions were already tested and stable but gated by the `exports`
field. Use them when you need to compose stores before registration:

- **Audit fan-out** — one entry in `auditPlugin({ customStores: [...] })`
  wired to your repo, other entries to Kafka/S3/Loki
- **Decorated outbox/idempotency** — wrap the repo-backed store with
  metrics, tracing, or key-namespacing before passing as `store:` /
  `repository:`

Passing `{ repository }` to the plugin remains the one-liner path for the
common case — nothing changes there.

**Dependency bump:**

- `peerDependencies["@classytic/mongokit"]` bumped `>=3.10.0` → `>=3.10.2`
- `devDependencies["@classytic/mongokit"]` bumped `^3.10.0` → `^3.10.2`
- CLI `arc init` scaffolds `@classytic/mongokit@^3.10.2`

## 2.10 — clean-break on repo-core types + outbox fix

### Breaking changes — repo-core is no longer re-exported

Arc 2.10 stops re-exporting types from `@classytic/repo-core`. The repo
contract has a single canonical home (repo-core); arc only defines types
it owns.

**Removed from the `@classytic/arc` public surface:**

| Removed name (arc 2.9) | Replacement |
|---|---|
| `CrudRepository<T>` | `StandardRepo<T>` from `@classytic/repo-core/repository` |
| `PaginatedResult<T>` | `OffsetPaginationResult<T>` from `@classytic/repo-core/pagination` |
| `KeysetPaginatedResult<T>` | `KeysetPaginationResult<T>` (same package) |
| `OffsetPaginatedResult<T>` | `OffsetPaginationResult<T>` |
| `WriteOptions`, `QueryOptions`, `FindOneAndUpdateOptions` | import from `@classytic/repo-core/repository` |
| `UpdateManyResult`, `DeleteResult`, `DeleteManyResult`, `DeleteOptions` | same |
| `RepositorySession`, `PaginationParams`, `InferDoc` | same |
| `BulkWriteOperation`, `BulkWriteResult` | same |

**Migration** — codemod your imports:

```ts
// Before
import type { CrudRepository, PaginatedResult, WriteOptions } from '@classytic/arc';

// After
import type { StandardRepo, WriteOptions } from '@classytic/repo-core/repository';
import type { OffsetPaginationResult } from '@classytic/repo-core/pagination';
```

**Still exported from `@classytic/arc`** (arc-owned, not in repo-core):

- `RepositoryLike<T>` = `MinimalRepo<T> & Partial<StandardRepo<T>>` — arc's
  "floor + optionals" composition, used everywhere arc feature-detects kit
  capabilities at runtime.
- `PaginationResult<T>` — discriminated union of the offset/keyset shapes,
  used by `BaseController.list` and `getDeleted` where either is valid.

### Bugfix: outbox `fail()` on mongokit

- **Fix: `repositoryAsOutboxStore.fail()` now passes `updatePipeline: true`
  to `findOneAndUpdate`.** mongokit ≥3.8 blocks array-form (aggregation)
  updates by default as a safety rail; arc's outbox uses the pipeline
  form so `$ifNull` can preserve `firstFailedAt` across retries without a
  round-trip read. Without the flag, every `fail()` call — retry or DLQ
  transition — threw `"Update pipelines (array updates) are disabled"`.
  Caught by [`tests/integration/strict-false-plugins.test.ts`](tests/integration/strict-false-plugins.test.ts).

- **Docs: `audit`, `events`, `idempotency` production-ops pages now
  document the required mongokit plugins** (`methodRegistryPlugin` +
  `batchOperationsPlugin`) and the rationale for the `strict: false`
  passthrough schema. Previously users hitting "repository is missing
  required methods: deleteMany" had to read the adapter source to
  diagnose.

## 2.9.3

- **Fix: `cachingPlugin` `ERR_HTTP_HEADERS_SENT` under `light-my-request`.**
  Moved header mutation from `onSend` → `preSerialization`. The onSend
  hook ran after Fastify's chain had already scheduled `safeWriteHead`;
  under the vitest test harness (`app.inject()`) the async microtask
  yield let the response commit between our hook and `onSendEnd`,
  re-throwing "Cannot write headers after they are sent". preSerialization
  runs before the flush window, so no race. (2.9.2 attempted an
  `isReplyCommitted` guard — same reporter confirmed it didn't fix the
  actual bug; reverted.) 304 responses now use `reply.serializer()` to
  bypass JSON's `'""'` encoding for the empty body. ETag hashing now
  uses `JSON.stringify(payload)` instead of `String(payload)` — fixes a
  prior bug where every object response hashed to the same
  `"[object Object]"` tag.
- **Fix: auditPlugin retention (unbounded disk growth).** Added
  `retention: { maxAgeMs, purgeIntervalMs? }` option. The plugin
  registers an unref'd `setInterval` that calls `audit.purge(cutoff)`
  and cleans up in `onClose`. `AuditStore` gains
  `purgeOlderThan?(cutoff)` — optional, so append-only stores (Kafka,
  S3) are skipped silently. Repository adapter maps to
  `repository.deleteMany({ timestamp: { $lt: cutoff } })`.
  `fastify.audit.purge(cutoff)` is always available for manual / cron
  use regardless of whether `retention` is set. Mongo apps can still
  declare a server-side TTL index on the collection — both approaches
  coexist.
- Shared `repositoryAs*` helpers extracted to
  `src/adapters/store-helpers.ts` (`isNotFoundError`,
  `createSafeGetOne`, `createIsDuplicateKeyError`) — outbox + idempotency
  adapters lose ~76 lines of duplicated cross-kit error handling.
  Behavior unchanged.

**2.9.2 was unpublished.** Its `isReplyCommitted` guard did not fix the
reported race; 2.9.3 is the correct fix.

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
