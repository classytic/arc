# Changelog

## 2.7.0

### Better Auth 1.6 alignment + Mongoose populate bridge

Audited the BA adapter against the Better Auth 1.6 surface (`auth.handler`, `api.getSession`, organization plugin endpoints, `getActiveMemberRole`, `listTeams`, session shape). All paths still align — no breaking changes from BA core. Bumped peer dep `better-auth: >=1.5.5` → `>=1.6.0`.

Removed two `any` casts in the team-resolution branch of `betterAuth.ts`. Team id matching now uses the existing `normalizeId()` helper, so team ids stored as `{ _id: '...' }` objects (e.g. mongoose-style) match correctly.

### New: `@classytic/arc/auth/mongoose` — populate against Better Auth collections

When you back Better Auth with the official `@better-auth/mongo-adapter`, BA writes through the native `mongodb` driver and never registers anything with Mongoose. Any arc resource that does `Schema({ userId: { type: String, ref: 'user' } })` and calls `.populate('userId')` then throws `MissingSchemaError`.

New optional helper at a dedicated subpath registers `strict: false` stub Mongoose models for BA's collections so populate works end-to-end. Lives behind a subpath export so users on Prisma/Drizzle/Kysely never get Mongoose pulled into their bundle.

```typescript
import mongoose from 'mongoose';
import { betterAuth } from 'better-auth';
import { mongodbAdapter } from '@better-auth/mongo-adapter';
import { organization } from 'better-auth/plugins';
import { registerBetterAuthMongooseModels } from '@classytic/arc/auth/mongoose';

const auth = betterAuth({
  database: mongodbAdapter(mongoose.connection.getClient().db()),
  plugins: [organization({ teams: { enabled: true } })],
  // ...
});

// Register stub models AFTER betterAuth() so collections are known.
// Default is core only (`user`, `session`, `account`, `verification`) —
// every plugin set is opt-in.
registerBetterAuthMongooseModels(mongoose, {
  plugins: ['organization', 'organization-teams'],
});

// Now arc resources can populate BA-owned references:
const Post = mongoose.model('Post', new mongoose.Schema({
  title: String,
  authorId: { type: String, ref: 'user' },
}));
await Post.findOne().populate('authorId'); // resolves against BA's user collection
```

Plugin coverage (researched against BA 1.6 docs, not guesswork):

- **Core BA plugins** (selectable via `plugins: [...]`): `organization`, `organization-teams`, `twoFactor`, `jwt`, `oidcProvider`, `oauthProvider` (alias for `oidcProvider`), `mcp` (reuses oidcProvider schema per docs), `deviceAuthorization`
- **Separate `@better-auth/*` packages** (use `extraCollections` — they evolve independently of core): `@better-auth/passkey` → `'passkey'`, `@better-auth/sso` → `'ssoProvider'`, `@better-auth/api-key` → consult plugin docs
- **Field-only plugins** (no entry needed — `strict: false` stubs round-trip extra fields): `admin`, `username`, `phoneNumber`, `magicLink`, `emailOtp`, `anonymous`, `bearer`, `multiSession`, `siwe`, `lastLoginMethod`, `genericOAuth`, etc.

Other features: `usePlural` (matches `@better-auth/mongo-adapter`'s pluralization), `modelOverrides` (for custom `user: { modelName: 'profile' }` configs), `extraCollections` (for separate-package plugins or custom plugins). Idempotent — safe to call repeatedly under HMR. Deduplicates overlapping collection sets so `plugins: ['mcp', 'oidcProvider']` won't crash with `OverwriteModelError`.

### New: real BA + mongo smoke test

Added `tests/smoke/better-auth-mongo.smoke.test.ts` that boots a real `betterAuth()` instance against `mongodb-memory-server` via `@better-auth/mongo-adapter`. Covers signup → cookie session, createOrganization → setActiveOrganization → member scope, multi-role → `requireOrgRole` matches, createTeam → addTeamMember → setActiveTeam → `scope.teamId` populated, and the `x-organization-id` header fallback for API-key auth.

This is the canary that catches BA upgrade regressions that mock-based tests can't — when BA 1.7 or 2.0 lands, this test will fail in seconds rather than waiting for a user bug report.

## 2.6.3

### `idField` override works end-to-end

Resources with a custom `idField` (e.g. `jobId`, `orderId`, UUID strings) no longer get their routes rejected by AJV's ObjectId pattern validation. Fixed at two layers:

- **New adapter contract** — `DataAdapter.generateSchemas(options, context?)` now accepts `AdapterSchemaContext` with `idField` and `resourceName`. Adapters and schema-generator plugins (MongoKit's `buildCrudSchemasFromModel`) can produce the right `params.id` shape from the start. Backwards compatible — legacy adapters ignoring the argument still work via the safety net below.
- **Safety net in `defineResource`** — when `idField !== '_id'` and any known ObjectId pattern is detected on `params.id`, Arc strips `pattern` / `minLength` / `maxLength` and sets a description. User-provided `openApiSchemas.params` still wins over everything.

```typescript
defineResource({
  name: 'job',
  adapter: createMongooseAdapter(JobModel, jobRepository),
  idField: 'jobId',     // ← one line, now works for routes + MCP tools + OpenAPI docs
});

// GET /jobs/job-5219f346-a4d  → 200 (was 400 "must match pattern ^[0-9a-fA-F]{24}$")
```

Covers all three layers: Fastify route validation (AJV), BaseController lookups, OpenAPI docs.

### List query normalization — no more AJV strict-mode warnings

Rewrote the listQuery normalization in `defineResource.toPlugin()`. The old approach tried to strip `type` from filter fields but missed `populate` (with its `oneOf` composition), didn't recurse into composition keywords, and could leave orphan `minimum`/`maximum` constraints when merging with partial user schemas.

New strategy: a fixed allowlist of well-known keys (`page`, `limit`, `sort`, `search`, `select`, `after`, `populate`, `lookup`, `aggregate`) preserves its parser-emitted schema. Everything else (filter fields) is replaced with `{}` (accept-any) — the `QueryParser` owns runtime validation, AJV just gets out of the way.

Works with MongoKit, SQL-style parsers, composition-heavy custom parsers, or any exotic user-defined shape. The `_registryMeta.openApiSchemas.listQuery` is NOT mutated, so OpenAPI docs still show the rich parser output.

### Mongoose adapter — body schemas default to `additionalProperties: true`

The built-in Mongoose adapter fallback now emits `additionalProperties: true` on `createBody` and `updateBody` (previously only on `response`), so POST/PATCH requests with extra fields are no longer rejected by the built-in fallback generator. Explicit generators (MongoKit's `buildCrudSchemasFromModel`) can still override this by setting `additionalProperties: false`.

### Peer dependencies use `>=` instead of `^`

All peer dependency version ranges converted from `^X.Y.Z` to `>=X.Y.Z` so users upgrading to new majors don't get peer-dep warnings. Notable:

- `mongodb`: `^6.0.0 || ^7.0.0` → `>=6.0.0` (MongoDB 8.x now supported)
- `fastify`: `^5.7.4` → `>=5.0.0`
- `zod`: `^4.0.0` → `>=4.0.0`
- `bullmq`, `ioredis`, all `@fastify/*`, `@sinclair/typebox`, `pino-pretty`, `fastify-raw-body`

### Tests

- **`tests/core/id-field-params-schema.test.ts`** — 6 tests: safety net, adapter context, E2E routes with custom ID formats, user override precedence
- **`tests/core/list-query-normalization.test.ts`** — 5 tests with MongoKit-like, SQL-style, composition-based parsers
- **`tests/docs/openapi-integration.test.ts`** — 7 full integration tests with real `MongoMemoryServer` + MongoKit `Repository` + `arcCorePlugin` + `openApiPlugin`, AJV strict mode logger attached, verifies zero warnings + OpenAPI docs generation + real CRUD requests

**Suite total: 218 files, 3053 passing, 0 failures.**

## 2.6.2

### Audit Plugin — Per-Resource Opt-In

- **`autoAudit: { perResource: true }`** — cleanest opt-in pattern. Only resources with `audit: true` in their `defineResource()` config are auto-audited. No more growing `exclude` lists.
  ```typescript
  // app.ts
  await fastify.register(auditPlugin, { autoAudit: { perResource: true } });

  // order.resource.ts
  defineResource({ name: 'order', audit: true });

  // payment.resource.ts — only audit deletes
  defineResource({ name: 'payment', audit: { operations: ['delete'] } });
  ```
- **`autoAudit: { include: [...] }`** — allowlist mode (centralized config alternative)
- **Distributed sink** — multiple `customStores` fan out audit entries in parallel (primary + replica + cold archive)
- **Read auditing & MCP actions** — `fastify.audit.custom()` works from any handler (additionalRoutes, MCP tools, compliance endpoints). 8 flexibility tests cover the surface.

### loadResources Improvements

- **Discovers ANY named export with `toPlugin()`** — not just `default`/`resource`. The common `export const userResource = defineResource(...)` convention now works.
- **Better error messages** — vitest hint added to `.js→.ts` failure messages. Windows drive-letter guard prevents misleading "protocol 'd:'" errors.

### Test Helpers

- **`preloadResources(import.meta.glob(...))`** — vitest workaround for resources that need bootstrap (engine init) or transitive `node_modules` imports. Eager and async variants.

### DX Fixes

- **`developmentPreset` pino-pretty fallback** — gracefully falls back to JSON logging if `pino-pretty` is not installed (common when `NODE_ENV` selects dev preset in production where dev deps are pruned).
- **`ResourceLike` exported** from `@classytic/arc/factory` — typed wrapper for users building their own resource loaders.
- **No index signature on `ResourceLike`** — `ResourceDefinition` is now assignable without `as any` casts.
- **TestHarness/HttpTestHarness type fixes** — missing class property declarations added.

### Security

- **JSON parser prototype poisoning** — `secure-json-parse` now a direct dependency (was relying on Fastify's transitive). Fastify's `onProtoPoisoning` protection is preserved when handling empty DELETE/GET bodies.

### Factory Refactor

- **`createApp.ts` split into 4 modules** — `registerSecurity`, `registerAuth`, `registerArcPlugins`, `registerResources`. Each independently testable. 58 new unit tests.
- **`resourcePrefix`** — register all resources under a URL prefix
- **`skipGlobalPrefix`** — per-resource opt-out (webhooks, admin routes)
- **`bootstrap[]`** — domain init after `plugins()`, before `resources`
- **`afterResources`** — post-registration hook
- **Duplicate resource detection** — warns before Fastify route conflicts
- **Testing preset disables `gracefulShutdown`** — fixes `MaxListenersExceededWarning` in multi-app test processes

### Test Coverage

- **3009+ tests across 212 files** (was 2900+)
- 15 audit tests (per-resource, allowlist, denylist, distributed, MCP, custom actions)
- 6 named-export discovery tests
- 11 preloadResources tests
- 58 factory module unit tests

## 2.6.0

### Security

- **JSON parser prototype poisoning fix** — replaced plain `JSON.parse()` with `secure-json-parse` in the custom content-type parser. Fastify's built-in proto-poisoning protection (`onProtoPoisoning`, `onConstructorPoisoning`) is now preserved when handling empty-body DELETE/GET requests.

### Factory & Boot Sequence

- **`resourcePrefix`** — register all resources under a URL prefix (e.g., `/api/v1`)
  ```typescript
  const app = await createApp({
    resourcePrefix: '/api/v1',
    resources: await loadResources(import.meta.url),
  });
  // product → /api/v1/products, order → /api/v1/orders
  ```
- **`skipGlobalPrefix`** — per-resource opt-out of `resourcePrefix`
  ```typescript
  defineResource({ name: 'webhook', prefix: '/hooks', skipGlobalPrefix: true })
  // stays at /hooks even with resourcePrefix: '/api/v1'
  ```
- **`bootstrap[]`** — domain init functions that run after `plugins()` but before `resources`
  ```typescript
  createApp({
    plugins: async (f) => { await connectDB(); },
    bootstrap: [inventoryInit, accountingInit],
    resources: await loadResources(import.meta.url),
  });
  ```
- **`afterResources`** — hook after resources are registered (for cross-resource wiring)
- **Boot order** — `plugins → bootstrap → resources → afterResources → onReady`
- **Duplicate resource detection** — warns on duplicate resource names before registration
- **`createApp()` refactored** into 4 modules: `registerSecurity`, `registerAuth`, `registerArcPlugins`, `registerResources` — each independently testable
- **Testing preset disables `gracefulShutdown`** — prevents `MaxListenersExceededWarning` in multi-app test processes

### Resource Loading

- **`loadResources(import.meta.url)`** — resolves dirname internally, works in both `src/` (dev) and `dist/` (prod)
- **`loadResources({ silent: true })`** — suppresses skip/failure warnings for factory files
- **Import compatibility** — works with relative imports, Node.js `#` subpath imports. tsconfig path aliases (`@/*`, `~/`) require explicit `resources: [...]`

### Schema & Validation

- **AJV strict-mode warnings fixed** — filter field normalization now strips all type-dependent keywords (`minimum`, `maximum`, `minLength`, `maxLength`, `pattern`, `format`, etc.) not just `type`

### Test Coverage

- 7 JSON parser security tests (prototype poisoning, empty body, malformed)
- 58 factory module unit tests (registerSecurity, registerAuth, registerArcPlugins, registerResources)
- 25 import compatibility tests (relative, `#` subpath, tsconfig aliases, `import.meta.url`)
- 14 boot sequence tests (order, bootstrap, afterResources, resourcePrefix)
- 11 resourcePrefix + skipGlobalPrefix E2E tests
- 7 full app E2E tests (complete boot simulation)

## 2.5.5

### Auth & Permissions

- **`roles()` helper** — checks both platform `user.role` AND org `scope.orgRoles` automatically. Drop-in fix for Better Auth org plugin users where `requireRoles(['admin'])` silently denied org-level admins.
  ```typescript
  import { roles } from '@classytic/arc/permissions';
  permissions: { create: roles('admin', 'editor') }  // checks both levels
  ```
- **`requireRoles({ includeOrgRoles: true })`** — backward-compatible option for existing code
- **`AdditionalRoute.handler` type** — now accepts `ControllerHandler` when `wrapHandler: true` (no more `as any`)
- **Denial messages do not leak held roles** — safe for action routes that return reason to clients

### Schema & Validation

- **Bracket notation filters work** — `?name[contains]=foo`, `?price[gte]=100` no longer rejected by Fastify. AJV validates structure; QueryParser validates content.
- **Subdocument arrays generate proper object schemas** — `[{ account: ObjectId, debit: Number }]` → `{ items: { type: 'object', properties: {...} } }`
- **`excludeFields` respected by Mongoose adapter** — removes from both `properties` AND `required` array
- **`readonlyFields` excluded from body schemas** — previously only stripped at runtime
- **`immutable` / `immutableAfterCreate` fields** — excluded from update body + stripped by BodySanitizer
- **Date fields no longer enforce `format: "date-time"`** — `"2026-01-15"` passes Fastify; Mongoose handles parsing
- **AJV strict-mode warnings fixed** — pagination/search keep types, only filter fields stripped
- **Mongoose type mapping** — Array elements, Mixed, Map, Buffer, Decimal128, UUID, SubDocument
- **Response schema `additionalProperties: true`** — virtuals not stripped by fast-json-stringify
- **`LookupOption.select`** — accepts `string | Record<string, 0 | 1>` (MongoKit compat)

### Factory & Resource Loading

- **`createApp({ resources })`** — register resources directly, no `toPlugin()` needed
- **`loadResources(dir)`** — auto-discover `*.resource.{ts,js,mts,mjs}` files from a directory
  ```typescript
  import { createApp, loadResources } from '@classytic/arc/factory';
  const app = await createApp({
    resources: await loadResources('./src/resources'),
  });
  ```
- **`loadResources` options** — `exclude`, `include`, `suffix`, `recursive`
- **`loadResources` import compatibility** — works with relative imports and Node.js `#` subpath imports (`package.json` `imports`). tsconfig path aliases (`@/*`, `~/`) require explicit `resources: [...]` instead.
- **`.js→.ts` resolution fixed in vitest** — `pathToFileURL` first ensures loader hooks intercept entire import chain
- **Parallel imports** — `Promise.all()` for all resource files
- **No double-execution on module errors** — evaluation errors reported once, not retried
- **Actionable error messages** — `.js` import failures get a hint about TS ESM convention
- **Resource registration errors** — descriptive messages with resource name

### Audit

- **DB-agnostic userId extraction** — Mongoose ObjectId, string, number (no `.toString()` mismatch)
- **MCP edits trigger auto-audit** — same BaseController → hooks → audit pipeline as REST
- **Manual audit from custom routes** — `fastify.audit.custom()` works in raw handlers

### MCP Integration

- Operator-suffixed filter fields (`price_gt`, `price_lte`)
- Auto-derive `filterableFields` and `allowedOperators` from `QueryParser`
- `GET /mcp/health` diagnostic endpoint
- Auth failure WARN logging

### Test Coverage

- 2,791 tests across 194 files
- 38 loadResources tests (patterns, .js→.ts, parallel, error handling)
- 16 multi-tenant hierarchy tests (org isolation, cross-org denial, team scoping)
- 15 query schema compatibility tests (bracket notation, combined filters)
- 14 business scenario tests (accounting subdocs, mixed tenant, plugin-added fields)
- 10 route prefix tests (custom, hyphenated, nested, conflicts)
- 48 permission tests (roles(), denial security, platform + org checks)
- 38 audit tests (userId extraction, change detection, auto-audit)

## 2.4.3

```typescript
import { mcpPlugin } from '@classytic/arc/mcp';
await app.register(mcpPlugin, { resources, auth: false });
// → list_products, get_product, create_product, update_product, delete_product
```

- **Stateless by default** — fresh server per request, scales horizontally
- **Three auth modes** — `false` (no auth), Better Auth OAuth 2.1, custom function
- **Multi-tenancy** — `organizationId` from auth auto-scopes all queries
- **Permission filters** — `PermissionResult.filters` enforced in MCP (same as REST)
- **Guards** — `guard(requireAuth, requireOrg, requireRole('admin'), handler)`
- **Schema discovery** — `arc://schemas` and `arc://schemas/{name}` MCP resources
- **Health endpoint** — `GET /mcp/health` for diagnostics
- **Per-resource overrides** — `include`, `names`, `toolNamePrefix`, `hideFields`
- **Custom tools co-located** — `order.mcp.ts` alongside `order.resource.ts`
- **CLI** — `arc generate resource product --mcp`, `arc generate mcp analytics`

### DX Improvements

- **`ArcRequest`** — typed Fastify request with `user`, `scope`, `signal`
- **`envelope(data, meta?)`** — response helper, no manual `{ success, data }` wrapping
- **`getOrgContext(req)`** — canonical org extraction from any auth type
- **`createDomainError(code, msg, status)`** — domain errors with auto HTTP status mapping
- **`onRegister(fastify)`** — resource lifecycle hook for wiring singletons
- **`preAuth`** — pre-auth handlers on routes for SSE `?token=` promotion
- **`streamResponse`** — auto SSE headers + bypasses response wrapper
- **`request.signal`** — Fastify 5 native AbortSignal on disconnect

### Test Coverage

- 2,448 tests across 166 files (up from 2,228)
- 40 MCP permission tests (auth, multi-tenancy, guards, field-level, composite)
- 31 MCP DX tests (include, names, prefix, disableDefaultRoutes, mcpHandler, CRUD lifecycle)
- 17 core DX tests (envelope, getOrgContext, createDomainError, onRegister, preAuth, streamResponse)

### Dependencies

- `@modelcontextprotocol/sdk` — optional peer dep (required for MCP)
- `zod` — optional peer dep (required for MCP)
- `@classytic/mongokit` — bumped to >=3.4.3 (exposes QueryParser getters)

## 2.4.1

### New Features

#### Metrics Plugin
Prometheus-compatible `/_metrics` endpoint with zero external dependencies. Tracks HTTP requests, CRUD operations, cache hits/misses, events, and circuit breaker state.

```typescript
const app = await createApp({
  arcPlugins: { metrics: true },
});
// GET /_metrics → Prometheus text format
```

#### API Versioning Plugin
Header-based (`Accept-Version`) or URL prefix-based (`/v2/`) versioning with deprecation + sunset headers.

```typescript
const app = await createApp({
  arcPlugins: { versioning: { type: 'header', deprecated: ['1'] } },
});
```

#### Bulk Operations Preset
`presets: ['bulk']` adds `POST /bulk`, `PATCH /bulk`, `DELETE /bulk` routes. DB-agnostic — calls `repo.createMany()`, `repo.updateMany()`, `repo.deleteMany()`. Permissions inherit from resource config.

```typescript
defineResource({
  name: 'product',
  presets: ['softDelete', 'bulk'],
});
```

#### Webhook Outbound Plugin
Fastify plugin that auto-dispatches Arc events to customer webhook endpoints with HMAC-SHA256 signing, pluggable `WebhookStore`, and delivery logging.

```typescript
await fastify.register(webhookPlugin);
await app.webhooks.register({
  id: 'wh-1',
  url: 'https://customer.com/webhook',
  events: ['order.created'],
  secret: 'whsec_abc123',
});
```

#### Event Outbox Pattern
Transactional outbox for at-least-once event delivery. Store events in the same DB transaction, relay to transport asynchronously.

```typescript
const outbox = new EventOutbox({ store: new MemoryOutboxStore(), transport });
await outbox.store(event);  // same transaction as DB write
await outbox.relay();       // publish pending to transport
```

#### Per-Tenant Rate Limiting
Scope-aware rate limit key generator. Isolates limits by org, user, or IP.

```typescript
const app = await createApp({
  rateLimit: { max: 100, timeWindow: '1m', keyGenerator: createTenantKeyGenerator() },
});
```

#### Compensating Transaction
In-process rollback primitive. Runs steps in order, compensates in reverse on failure. For distributed sagas, use Temporal/Inngest/Streamline.

```typescript
const result = await withCompensation('checkout', [
  { name: 'reserve', execute: reserveStock, compensate: releaseStock },
  { name: 'charge', execute: chargeCard, compensate: refundCard },
  { name: 'confirm', execute: sendEmail },
]);
```

#### RPC Schema Versioning
`schemaVersion` option on `createServiceClient` sends `x-arc-schema-version` header for contract compatibility between services.

### Improvements

- **Bulk preset** wired into `defineResource` via `BaseController.bulkCreate/bulkUpdate/bulkDelete`
- **Metrics** and **versioning** wired into `createApp` via `arcPlugins.metrics` and `arcPlugins.versioning`
- **CLI `arc init`** now includes `bulk` preset and `metrics` in generated projects
- **MongoKit v3.4** peer dependency — soft-delete batch ops work natively

### Documentation

- Updated `skills/arc/SKILL.md` with all new features and subpath imports
- Updated `skills/arc/references/integrations.md` with webhook plugin docs
- Updated `skills/arc/references/production.md` with metrics, versioning, outbox, bulk, saga, tenant rate limiting

### Test Coverage

- 2,100+ tests across 143 files
- 44 webhook tests (plugin lifecycle, auto-dispatch, HMAC, delivery log, store contract, timeout, error resilience)
- 20 bulk preset tests (route generation, BaseController methods, validation, DB-agnostic contract)
- 14 metrics wiring tests (registration, endpoint, auto HTTP tracking, programmatic recording)
- 10 versioning wiring tests (header/prefix extraction, deprecation, sunset)
- 15 compensation tests (forward execution, rollback, context passing, error collection, Fastify route integration)
- 7 MongoKit E2E tests (real MongoDB — bulk create/update/delete + soft-delete awareness)
- 7 streaming compatibility tests (NDJSON, SSE, Zod schema conversion)
