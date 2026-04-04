# Changelog

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
