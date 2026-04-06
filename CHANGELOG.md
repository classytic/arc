# Changelog

## 2.5.3

### Security Fixes

- **`roles()` no longer leaks held roles in denial messages** — action routes previously exposed `Had platform:[user] org:[member]` to clients
- **`loadResources()` no longer double-executes modules on error** — retries only on `ERR_UNSUPPORTED_ESM_URL_SCHEME` (Windows path format), not evaluation errors

### Schema & Validation

- **Subdocument arrays generate proper object schemas** — `[{ account: ObjectId, debit: Number }]` now produces `{ items: { type: 'object', properties: {...} } }` instead of `{ items: { type: 'string' } }`
- **AJV strict-mode warnings fixed** — pagination/search fields keep their types, only filter fields stripped
- **Date fields no longer enforce `format: "date-time"`** — `"2026-01-15"` passes Fastify validation; Mongoose handles parsing
- **`LookupOption.select` accepts projection objects** — `string | Record<string, 0 | 1>` (matches MongoKit)

### Performance

- **`loadResources()` imports in parallel** — `Promise.all()` instead of sequential `for...of await`

### Test Coverage

- 2,586 tests across 173 files (up from 2,539 / 170)
- 16 multi-tenant hierarchy tests (org isolation, cross-org denial, team scoping, `roles()` at both levels)
- 10 route prefix tests (custom, hyphenated, nested, conflicts, 404s)
- 14 business scenario tests (accounting subdocs, mixed tenant, plugin-added fields, date handling)
- 3 denial message security tests (no role leakage)
- Partial fieldRules regression test (required fields preserved)

## 2.5.2

### Auth & Permissions

- **`roles()` helper** — checks both platform `user.role` AND org `scope.orgRoles` automatically. Drop-in fix for Better Auth org plugin users where `requireRoles(['admin'])` silently denied org-level admins.
  ```typescript
  import { roles } from '@classytic/arc/permissions';
  permissions: { create: roles('admin', 'editor') }  // checks both levels
  ```
- **`requireRoles({ includeOrgRoles: true })`** — backward-compatible option to also check org roles
- **`AdditionalRoute.handler` type** — now accepts `ControllerHandler` when `wrapHandler: true` (no more `as any` casts)

### Schema & Query Fixes

- **Bracket notation filters work** — `?name[contains]=foo`, `?price[gte]=100` no longer rejected by Fastify schema validation. AJV validates structure only; QueryParser validates content.
- **`excludeFields` respected by Mongoose adapter** — computed fields excluded from create/update body schemas
- **`readonlyFields` excluded from body schemas** — previously only stripped at runtime
- **`immutable` / `immutableAfterCreate` fields** — excluded from update body schema AND stripped by BodySanitizer at runtime
- **`optionalFields` respected by Mongoose schema gen** — overrides Mongoose `isRequired`
- **Response schema `additionalProperties: true`** — virtuals and computed fields no longer stripped by fast-json-stringify
- **Mongoose type mapping** — Array element types detected, Mixed/Map/Buffer/Decimal128/UUID support

### Factory DX

- **`createApp({ resources })`** — register resources directly, no `toPlugin()` needed
  ```typescript
  const app = await createApp({ resources: [product, order], auth: false });
  ```
- **`loadResources(dir)`** — auto-discover `*.resource.ts` files from a directory
  ```typescript
  const app = await createApp({
    resources: await loadResources('./src/resources'),
  });
  ```
- **`loadResources` options** — `exclude`, `include`, `suffix`, `recursive`
- **Resource registration errors** — descriptive messages with resource name and fix hints
- **`loadResources` diagnostics** — warns about skipped files and import failures

### Audit

- **DB-agnostic userId extraction** — works with Mongoose ObjectId, string, number (no more `.toString()` type mismatch)
- **`MongoConnection` docs** — clarified: pass `mongoose.connection.db`, not `mongoose.connection`
- **MCP edits trigger auto-audit** — confirmed and tested (same BaseController → hooks → audit pipeline as REST)
- **Manual audit from custom routes** — `fastify.audit.custom()` works in `wrapHandler: false` handlers

### Test Coverage

- 2,539 tests across 170 files (up from 2,448 / 166)
- 17 query schema compatibility tests (bracket notation, combined filters, sort, pagination)
- 15 loadResources tests (discovery, exclude/include, E2E with createApp)
- 10 resources-option tests (CRUD lifecycle, mixed usage, error handling)
- 42 org permission tests (roles(), includeOrgRoles, platform + org checks)
- 38 audit tests (userId extraction, change detection, auto-audit, custom actions)

## 2.5.1

### MCP Operator Filters, v3 Notes

- Operator-suffixed filter fields in MCP schemas (`price_gt`, `price_lte`)
- Auto-derive `filterableFields` and `allowedOperators` from `QueryParser`
- v3 design notes added (internal planning doc)

## 2.5.0

### MCP Integration — AI Agent Tools

Expose Arc resources as MCP tools for Claude, Cursor, Copilot, and any MCP-compatible agent. Zero-config auto-generation from `defineResource()` or fully custom tools via `defineTool()`.

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
