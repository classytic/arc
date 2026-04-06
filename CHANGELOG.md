# Changelog

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
