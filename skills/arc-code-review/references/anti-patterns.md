# Arc Anti-Pattern Detection Catalog

Every entry below has: **detection** (greppable regex / file pattern), **severity**, **why it matters**, and **fix** (with arc API citation). Run each detection against `src/` (excluding `node_modules`, `dist`, `coverage`, `*.test.*`).

Severity legend: 🔴 Critical · 🟠 High · 🟡 Medium · 🟢 Low

---

## §1. Manual query parsing 🟡

**Detection (Grep):**
```
pattern: "req\\.query\\.(filter|sort|page|limit|search|q)\\b"
glob: "**/*.{ts,js}"
output_mode: content
```
Also: `\\$or\\s*:\\s*\\[`, `\\$and\\s*:\\s*\\[`, `\\$regex`, `Number\\(req\\.query\\.`, `parseInt\\(req\\.query\\.`.

**Anti-pattern:**
```typescript
const filters: any = {};
if (req.query.status) filters.status = req.query.status;
if (req.query.minPrice) filters.price = { $gte: Number(req.query.minPrice) };
if (req.query.q) {
  filters.$or = [
    { name: { $regex: req.query.q, $options: 'i' } },
    { description: { $regex: req.query.q, $options: 'i' } },
  ];
}
const items = await Product.find(filters)
  .skip((Number(req.query.page) - 1) * 20)
  .limit(20);
```

**Why critical-adjacent:** ad-hoc parsing is a ReDoS vector (no regex bounds), bypasses field whitelists, and silently diverges across resources.

**Fix:** Arc's built-in parser handles filters, operators, sort, pagination, populate, select.
```typescript
defineResource({
  name: 'product',
  schemaOptions: {
    query: {
      filterableFields: { status: { type: 'string' }, price: { type: 'number' } },
      allowedPopulate: ['category'],
    },
  },
});
// GET /products?status=active&price[gte]=100&sort=-createdAt&page=2&limit=20&populate=category
```
For MongoDB-specific operators (`$lookup`, geo): use `QueryParser` from `@classytic/mongokit`:
```typescript
import { QueryParser } from '@classytic/mongokit';
defineResource({
  queryParser: new QueryParser({
    allowedFilterFields: ['status', 'category'],
    allowedSortFields: ['createdAt', 'price'],
    allowedOperators: ['eq', 'gte', 'lte', 'in'],
  }),
});
```
ReDoS protection, max-depth, max-limit are enforced.

---

## §2. Hand-written Fastify route schemas 🟡

**Detection:**
```
pattern: "fastify\\.(get|post|patch|put|delete)\\([^,]+,\\s*\\{\\s*schema\\s*:"
multiline: true
```
Or: `properties\\s*:\\s*\\{` near `route\\(|fastify\\.(get|post|patch)`.

**Anti-pattern:**
```typescript
fastify.post('/products', {
  schema: {
    body: {
      type: 'object',
      properties: {
        name: { type: 'string', minLength: 1 },
        price: { type: 'number', minimum: 0 },
      },
      required: ['name', 'price'],
    },
    response: { 200: { type: 'object', properties: { id: {...}, name: {...} } } },
  },
  handler: async (req) => Product.create(req.body),
});
```

**Why:** Schema duplicates Mongoose model + diverges over time. No OpenAPI sync.

**Fix:**
```typescript
defineResource({
  name: 'product',
  schemaOptions: {
    fieldRules: {
      name: { type: 'string', minLength: 1, required: true },
      price: { type: 'number', minimum: 0, required: true },
    },
  },
});
```
Body, response, and OpenAPI auto-derive. Mongoose model constraints take precedence; `fieldRules` supplements.

---

## §3. Manual CRUD routes 🟠

**Detection:** Multiple `fastify.(get|post|patch|delete)` calls for the same path stem.
```
pattern: "fastify\\.(get|post|patch|put|delete)\\(['\"]\\/(\\w+)"
output_mode: content
```
Group hits by capture group 2 (path stem). Three or more methods on the same stem ⇒ candidate for `defineResource`.

**Anti-pattern:** A `routes/products.ts` file with `GET /products`, `GET /products/:id`, `POST /products`, `PATCH /products/:id`, `DELETE /products/:id` each implemented inline.

**Why high:** One resource gets a fix (e.g., pagination, error handling) and the others drift. Arc generates all five identically.

**Fix:** Replace the whole file with one `defineResource`. See [migration-recipes.md §1](migration-recipes.md).

---

## §4. Manual permission checks inside handlers 🔴

**Detection:**
```
pattern: "(req|request)\\.user\\.(role|roles)\\b|user\\.role\\s*[!=]==|roles\\.includes\\("
output_mode: content
```
Also: `if\\s*\\(\\s*!\\s*req\\.user\\s*\\)`, `throw\\s+new\\s+Error\\(['\"](Unauthorized|Forbidden)`.

**Anti-pattern:**
```typescript
fastify.post('/products', async (req, reply) => {
  if (!req.user) throw new Error('Unauthorized');                       // 401 hand-rolled
  if (!req.user.roles.includes('admin')) throw new Error('Forbidden');  // 403 hand-rolled
  if (product.createdBy !== req.user.id) throw new Error('Not yours');  // ownership
  // proceed
});
```

**Why critical:**
- Inconsistent error shape (Error vs ArcError). Frontend gets unpredictable bodies.
- `req.user.id` vs `req.user._id` mismatches between routes silently bypass ownership.
- No row-level filter — admin sees `Product.find()` with no tenant scope.

**Fix:** Declarative permission combinators. Permissions run at framework level, `filters` propagate into the repo query (row-level ABAC):
```typescript
import {
  allowPublic, requireAuth, requireRoles, requireOwnership,
  requireOrgMembership, requireOrgRole, requireServiceScope,
  allOf, anyOf,
} from '@classytic/arc';

defineResource({
  permissions: {
    list:   allowPublic(),
    get:    allowPublic(),
    create: requireRoles(['admin', 'editor']),
    update: anyOf(requireRoles(['admin']), requireOwnership('createdBy')),
    delete: requireRoles(['admin']),
  },
});
```
For mixed human + service: `anyOf(requireOrgRole('admin'), requireServiceScope('jobs:bulk-write'))`.

---

## §5. Manual `toJSON` transforms / response field stripping 🔴

**Detection:**
```
pattern: "schema\\.set\\(['\"]toJSON['\"]|toJSON\\s*=\\s*function|delete\\s+(ret|obj|doc)\\.(password|__v|secret)"
output_mode: content
```
Also: `onSerialization` Fastify hook bodies that delete fields.

**Anti-pattern:**
```typescript
userSchema.set('toJSON', {
  transform: (_doc, ret) => {
    delete ret.password;
    delete ret.__v;
    delete ret.secretToken;
    return ret;
  },
});
```

**Why critical:** Easy to forget on a new field; password leaks happen this way. Also breaks lean reads (the transform doesn't fire on `.lean()` results).

**Fix:** `fieldRules.hidden` (or field-level read permission) — applies at framework serialization for both REST and MCP, and works with lean reads:
```typescript
import { fields } from '@classytic/arc';

defineResource({
  schemaOptions: {
    fieldRules: {
      password:    { hidden: true },
      __v:         { hidden: true },
      secretToken: { hidden: true },
      salary:      fields.visibleTo(['admin', 'hr']),
      email:       fields.redactFor(['viewer'], '***'),
    },
  },
});
```

---

## §6. Hand-maintained OpenAPI / Swagger 🟡

**Detection:**
- Files: `openapi.yaml`, `openapi.json`, `swagger.yaml`, `swagger.json`, `api-spec.*` checked into the repo.
- `@fastify/swagger` registered with hand-written `swagger.definitions`.

**Why medium:** Spec drifts from code; consumers integrate against stale docs.

**Fix:** `arc docs ./openapi.json --entry ./dist/index.js` — emits OpenAPI from registered resources. Wire into `prebuild` or CI.
```typescript
import { SpecGenerator } from '@classytic/arc/docs';
const spec = await app.arc.docs.getSpec({ title: 'My API', version: '1.0.0' });
```

---

## §7. Manual event emission 🟠

**Detection:**
```
pattern: "(eventBus|emitter|events|pubsub)\\.(emit|publish)\\(['\"](\\w+)\\.(created|updated|deleted)"
output_mode: content
```

**Anti-pattern:**
```typescript
const product = await Product.create(req.body);
await eventBus.emit('product.created', { id: product._id });
// ... and somebody forgets it on PATCH
```

**Why high:** Inconsistent emission breaks downstream consumers (search index, audit log, cache invalidation). Test coverage rarely catches missing emits.

**Fix:** Arc auto-emits `{resource}.created` / `.updated` / `.deleted` on every CRUD. Custom events go through hooks:
```typescript
defineResource({
  name: 'product',
  events: {
    created: { description: 'Product created' },
    priceChanged: { description: 'Price updated', schema: { oldPrice, newPrice } },
  },
  hooks: {
    afterUpdate: async (ctx) => {
      if (ctx.data.price !== ctx.meta?.existing?.price) {
        await ctx.fastify.events.publish('product.priceChanged', {
          id: ctx.data._id,
          oldPrice: ctx.meta.existing.price,
          newPrice: ctx.data.price,
        });
      }
    },
  },
});
```
For guaranteed delivery, use `EventOutbox` (transactional outbox pattern).

---

## §8. Manual cache invalidation 🟡

**Detection:**
```
pattern: "(redis|cache)\\.(del|invalidate|set)\\(['\"](\\w+)[-:_]"
output_mode: content
```
Also: hand-rolled cache key strings.

**Anti-pattern:**
```typescript
const product = await Product.create(req.body);
await cache.del(`product-${product._id}`);
await cache.del('products-list');  // forgot the org-scoped key
```

**Fix:** Arc's `QueryCache` invalidates by tag on every mutation. Enable via `arcPlugins.queryCache: true` and declare tags per resource:
```typescript
defineResource({
  cache: {
    staleTime: 30,
    gcTime: 300,
    tags: ['catalog'],
    invalidateOn: { 'category.*': ['catalog'] },  // cross-resource
  },
});
```
Modes: `memory` (default) / `distributed` (requires `stores.queryCache: RedisCacheStore`). Response header: `x-cache: HIT | STALE | MISS`.

---

## §9. Bypassing RequestScope 🔴

**Detection:**
```
pattern: "req(uest)?\\.user\\.(_id|id|orgId|organizationId|tenantId|parentOrgId|teamId)"
output_mode: content
```

**Anti-pattern:**
```typescript
const userId = req.user._id;          // crashes on public route
const orgId  = req.user.orgId;        // undefined for service tokens
const parent = req.user.parentOrgId;  // not real — fragile custom field
```

**Why critical:**
- Crashes on public routes (`request.user` is `Record<string, unknown> | undefined`).
- Doesn't differentiate `member` vs `service` vs `elevated` scope kinds.
- Org hierarchy not honored (no ancestor lookup).
- Inconsistent across routes.

**Fix:** Always use accessors from `@classytic/arc/scope`:
```typescript
import {
  getUserId, getOrgId, getOrgRoles, getServiceScopes,
  getScopeContext, getAncestorOrgIds,
  isMember, isService, isElevated, isAuthenticated, hasOrgAccess,
  isOrgInScope,
} from '@classytic/arc/scope';

if (!isAuthenticated(req.scope)) return reply.unauthorized();
const userId = getUserId(req.scope);          // typed, undefined-safe
const orgId  = getOrgId(req.scope);
const branch = getScopeContext(req.scope, 'branchId');
const inOrg  = isOrgInScope(req.scope, 'acme-eu');
```
For permissions, prefer combinators (`requireOrgRole`, `requireScopeContext`, `requireOrgInScope`) over accessor logic in handlers.

---

## §10. Mongoose/Prisma imports outside adapters 🟠

**Detection:**
```
pattern: "^import\\s+.*\\b(mongoose|@prisma/client|drizzle-orm)\\b"
glob: "src/**/*.{ts,js}"
output_mode: content
```
Then exclude allowed paths: `src/**/adapter*.ts` (host-side adapter file), `src/db/**` (depending on convention), and `src/**/*.model.ts` (model definition is OK).

**Anti-pattern:** `import mongoose from 'mongoose'` in `src/services/`, `src/hooks/`, `src/routes/`, or any `.resource.ts`.

**Why high:** Defeats arc's DB-agnostic boundary. Forces every consumer of that file to pull a database driver. Migration to a different DB becomes a multi-thousand-LOC rewrite instead of swapping one adapter file.

**Fix:** Mongoose calls go in:
1. `*.model.ts` — schema definition only.
2. `*.repository.ts` — extends `Repository<TDoc>` from `@classytic/mongokit` (or implements `MinimalRepo`).
3. `*.adapter.ts` — `createMongooseAdapter({ model, repository })`.

Resources, hooks, and services consume `RepositoryLike<TDoc>` — never the model directly.

---

## §11. `console.log` in `src/` 🟢

**Detection:**
```
pattern: "console\\.(log|warn|error|info|debug)\\("
glob: "src/**/*.{ts,js}"
output_mode: content
```
Allowed: `src/cli/**`, scripts, examples.

**Fix:** Use Fastify's logger via `request.log` / `app.log`, or arc's logger if exposed.

---

## §12. `any` and `@ts-ignore` 🟢

**Detection:**
```
pattern: ":\\s*any\\b|<any>|as\\s+any\\b|@ts-ignore|@ts-expect-error"
glob: "src/**/*.ts"
```

**Fix:** Use `unknown` + type narrowing. `as unknown as X` is a last resort, not a shortcut. Never `@ts-ignore` — fix the type. For repo casts, prefer `RepositoryLike<TDoc>` from `@classytic/arc`.

---

## §13. Default exports 🟢

**Detection:**
```
pattern: "^export\\s+default\\b"
glob: "src/**/*.ts"
```

**Fix:** Named exports only. `export const productResource = defineResource({...})`. Knip enforces in arc itself; client projects should follow.

**Exception:** `*.resource.ts` files used by `loadResources()` may use `export default` because the loader recognizes both `default` export AND `export const resource`. Prefer named for grep-ability.

---

## §14. Reimplementing presets manually 🟡

**Detection:** Look for handler names + route paths that match preset signatures:

| Preset | Handler / route fingerprint |
|---|---|
| `softDelete` | `getDeleted`, `restore`, `GET /deleted`, `POST /:id/restore`, field `deletedAt` with manual filtering on every read |
| `slugLookup` | `getBySlug`, `GET /slug/:slug`, `GET /by-slug/:slug` |
| `tree` | `getChildren`, `getTree`, `GET /tree`, `GET /:id/children`, manual `parentId` field |
| `bulk` | `bulkCreate`, `bulkUpdate`, `bulkDelete`, `POST /bulk`, `PATCH /bulk`, `DELETE /bulk` |
| `multiTenant` | Every find call appended with `organizationId: req.user.orgId` |
| `ownedByUser` | Every find call appended with `userId: req.user.id` |
| `audited` | Manual write to an audit collection on every mutation |
| `filesUpload` | `multer`, `@fastify/multipart` ad-hoc routes per resource |
| `search` | `POST /search`, `/search-similar`, `/embed` hand-rolled |

**Fix:**
```typescript
defineResource({
  presets: [
    'softDelete',
    { name: 'multiTenant', tenantField: 'organizationId' },
    { name: 'slugLookup', slugField: 'slug' },
    'bulk',
    { name: 'filesUpload', storage: s3Storage, allowedMimeTypes: ['image/*'] },
  ],
});
```
Multi-level tenancy (branch/project/region) — use `multiTenantPreset({ tenantFields: TenantFieldSpec[] })`.

---

## §15. Hand-written MCP tools 🟡

**Detection:**
```
pattern: "CallToolRequestSchema|setRequestHandler\\(\\s*Call|inputSchema\\s*:\\s*\\{\\s*type\\s*:\\s*['\"]object"
output_mode: content
```
Or: a file pattern of `tools.ts`/`mcp.ts` defining `name`, `description`, `inputSchema`, `handler` objects manually.

**Fix:** Resources auto-generate MCP tools (5 CRUD + custom routes + actions). Permissions and field rules carry over.
```typescript
import { mcpPlugin } from '@classytic/arc/mcp';

await app.register(mcpPlugin, {
  resources: [productResource, orderResource],
  auth: false,                            // or getAuth() / custom
  exclude: ['credential'],
  overrides: { product: { operations: ['list', 'get'] } },
});
```
For domain-specific tools, use `extraTools` + `buildMcpToolsFromBridges([...])` instead of hand-rolling MCP server plumbing.

---

## §16. Custom search routes / query language 🟡

**Detection:** `GET /search`, `GET /:resource/search`, `/find`, `/lookup` with custom param parsing.

**Fix:** Either use arc's standard `QueryParser` syntax (`?search=...&filter=...`), or `searchPreset` for full-text/vector backends:
```typescript
import { searchPreset } from '@classytic/arc/presets/search';

defineResource({
  presets: [searchPreset({
    search:  { handler: (req) => elastic.search({ index: 'products', q: req.body.q }) },
    similar: { handler: (req) => pinecone.query({ vector: req.body.vector, topK: 10 }) },
  })],
});
```

---

## §17. `request.user` access without guard on public routes 🔴

**Detection:**
```
pattern: "(req|request)\\.user\\.\\w+"
output_mode: content
```
Then for each hit, check whether the enclosing route is `allowPublic()` or has no `permissions`. Crashes happen on public routes.

**Fix:** Always guard:
```typescript
if (req.user) {
  const userId = req.user.id;
  // ...
}
// or: use scope accessors which return undefined safely
```
Arc rule: `request.user: Record<string, unknown> | undefined`. The property is required (not optional `?:`), but the value is union-with-undefined.

---

## §18. Custom controller without forwarding `tenantField`/`schemaOptions`/`idField` 🟠

**Detection:** A `class FooController extends BaseController` where the constructor doesn't forward `tenantField`, `idField`, `schemaOptions`, `cache`, `onFieldWriteDenied`.

**Why:** When you pass your own controller to `defineResource({ controller })`, arc CANNOT thread these into it. They must be forwarded through `super(repo, opts)` AND mirrored on the `defineResource` call.

**Fix:**
```typescript
class ProductController extends BaseController<Product> {
  constructor(opts: { tenantField?: string | false; idField?: string } = {}) {
    super(productRepo, { resourceName: 'product', ...opts });
  }
}

defineResource({
  name: 'product',
  controller: new ProductController({ tenantField: 'organizationId', idField: '_id' }),
  tenantField: 'organizationId',     // mirror!
  idField: '_id',                    // mirror!
});
```
Or skip the custom controller entirely — arc's auto-built `BaseController` handles 90% of cases. Use `BaseCrudController` + `SoftDeleteMixin`/`BulkMixin`/etc. for slim CRUD-only.

---

## §19. `tenantField` left at default for company-wide tables 🟠

**Detection:** Resources for lookup tables, platform settings, or cross-org reports that don't set `tenantField: false`.

**Why:** Default `tenantField: 'organizationId'` silently scopes queries to caller's org. For an `account-type` lookup table or `currency` table, this returns empty results forever.

**Fix:**
```typescript
defineResource({ name: 'account-type', tenantField: false });   // company-wide
defineResource({ name: 'workspace-item', tenantField: 'workspaceId' });  // different scope
```

---

## §20. Wrong lifecycle slot for async-booted engines 🟠

**Detection:** A resource adapter that depends on an engine initialized inside the same module (e.g., `await ensureCatalogEngine()`) is exported as a static `defineResource()` at module top — which runs before `bootstrap[]`.

**Anti-pattern:**
```typescript
// product.resource.ts — runs at IMPORT time, before bootstrap
const engine = await ensureCatalogEngine();  // top-level await
export const productResource = defineResource({ adapter: engine.adapter() });
```

**Fix:** Use the factory form for `resources` so it runs *after* `bootstrap[]`:
```typescript
const app = await createApp({
  bootstrap: [async () => { await ensureCatalogEngine(); }],
  resources: async () => {
    const engine = await getCatalogEngine();
    return [buildProductResource(engine), buildCategoryResource(engine)];
  },
});
```
Or via `loadResources` with `context`:
```typescript
resources: async () => loadResources(import.meta.url, { context: { engine } }),
// Each *.resource.ts then exports: (ctx) => defineResource({ adapter: ctx.engine.adapter() })
```

---

## §21. Field-write denied as silent strip when reject is needed (or vice versa) 🟡

**Detection:** Resources with sensitive fields (`role`, `permissions`, `tenantId`, `organizationId`) that don't declare `onFieldWriteDenied`. Default is `reject` (403 with denied list) — usually correct. If client set `'strip'`, sensitive denied writes silently disappear.

**Fix:** Explicit choice per resource:
```typescript
defineResource({ onFieldWriteDenied: 'reject' });   // default — explicit
defineResource({ onFieldWriteDenied: 'strip' });    // only for low-stakes UX flows
```
Tests should assert 403 on protected-field write attempts.

---

## §22. Manual idempotency 🟠

**Detection:** Hand-rolled deduplication via `Idempotency-Key` header reads, custom Redis/Mongo lookup, retry tables.

**Fix:** Arc ships `idempotencyPlugin`:
```typescript
import { idempotencyPlugin } from '@classytic/arc/idempotency';
await app.register(idempotencyPlugin, { repository: idempotencyRepo, ttlMs: 24 * 3600_000 });
```
Requires `getOne`, `deleteMany`, `findOneAndUpdate` on the repo (mongokit + sqlitekit conform).

---

## §23. Manual audit log 🟡

**Detection:** Every mutation handler appends to an `audit_logs` / `events` / `history` collection inline.

**Fix:** Per-resource opt-in via `auditPlugin`:
```typescript
await fastify.register(auditPlugin, { autoAudit: { perResource: true } });
defineResource({ name: 'order', audit: true });
defineResource({ name: 'payment', audit: { operations: ['delete'] } });
```
Or `presets: ['audited']`.

---

## §24. Manual rate limiting per route 🟡

**Detection:** `@fastify/rate-limit` registered per-route with hand-tuned configs.

**Fix:** Per-resource `rateLimit: RateLimitConfig` on `defineResource`, or global at `createApp({ rateLimit })`.

---

## §25. Webhook signature verification on parsed body 🔴

**Detection:**
```
pattern: "verifySignature\\(.*req\\.body"
output_mode: content
```

**Why critical:** `verifySignature(body, ...)` throws `TypeError` if body isn't string/Buffer. Parsed body silently fails verification → forged webhooks accepted.

**Fix:** `verifySignature(req.rawBody, ...)`. Mark webhook routes `raw: true` and ensure `@fastify/raw-body` is registered (arc registers it automatically when needed).

---

## §26. Multipart/file upload handled with multer or ad-hoc parsing 🟡

**Detection:** `multer`, `formidable`, `busboy` used directly; or `req.body` consumed without `multipartBody` middleware.

**Fix:**
```typescript
import { multipartBody } from '@classytic/arc/middleware';
defineResource({
  middlewares: { create: [multipartBody({ allowedMimeTypes: ['image/png'], maxFileSize: 5 * 1024 * 1024 })] },
});
```
Or `presets: [{ name: 'filesUpload', storage, allowedMimeTypes, maxFileSize }]`.
`multipartBody()` is a no-op for JSON requests — safe to always add to create/update.

---

## §27. SSE auth via query string without `preAuth` 🔴

**Detection:** SSE/EventSource routes that read `req.query.token` and call `verify()` inline.

**Fix:** EventSource can't set headers, so arc's `preAuth` slot copies `?token=` into the `Authorization` header before auth runs:
```typescript
routes: [
  {
    method: 'GET', path: '/stream', raw: true,
    preAuth: [(req) => { req.headers.authorization = `Bearer ${req.query.token}`; }],
    permissions: requireAuth(),
    handler: async (req, reply) => reply.send(stream),
  },
],
```

---

## §28. Mongoose without mongokit 🟠

**Detection:** `package.json` has `mongoose` but not `@classytic/mongokit`. Or `import { Schema, model } from 'mongoose'` paired with hand-rolled repository classes (`class FooRepository`).

**Why high:** Every Mongoose model + repo class is duplicating mongokit's hook engine, plugin system, pagination, multi-tenant scoping, soft-delete, audit trail, transaction helpers. A 150 LOC repo class typically reduces to ~30 LOC with mongokit.

**Fix:** Full migration recipe → [mongokit-migration.md](mongokit-migration.md).

---

## §29. `app.register(authPlugin)` instead of `createApp({ auth })` 🟢

**Detection:** Manual JWT plugin registration with `@fastify/jwt`, hand-rolled `app.authenticate` decorator.

**Fix:** `createApp({ auth: { type: 'jwt', jwt: { secret, ... } } })` decorates `app.authenticate`, `app.optionalAuthenticate`, `app.authorize` and wires permission checks. For Better Auth, `createApp({ auth: { type: 'betterAuth', betterAuth: createBetterAuthAdapter({ auth, orgContext: true }) } })`.

---

## §30. Missing `arc-discovered` resources because of tsconfig path aliases 🟢

**Detection:** Resources defined under `import.meta.url`-discovered directories don't appear in routes; resource files import other resource files via `@/foo` aliases.

**Why:** `loadResources()` uses Node's resolver. `@/*` path aliases are compile-time only, not Node-resolvable. Auto-discovery silently misses these files.

**Fix:** Use relative imports OR Node's `#` subpath imports (`"imports": { "#foo/*": "./src/foo/*.js" }` in `package.json`) for files that participate in `loadResources`. Path aliases work fine for type-only imports.

---

## §31. `select` field manipulated client-side 🟢

**Detection:** Code post-processing `select` value from query (normalizing case, splitting, building projection objects).

**Why:** Arc preserves `select` as-is for DB-agnosticism (Mongo `'name email'` vs SQL `['name', 'email']`). Client normalization is wasted work and divergent across resources.

**Fix:** Pass through. The repository / adapter handles its native shape.

---

## §32a. Importing pagination types from primitives or mongokit 🟠

**Detection:**
```
pattern: "from\\s+['\"]@classytic/(primitives/pagination|mongokit)['\"][^\\n]*\\b(OffsetPaginationResult|KeysetPaginationResult|AggregatePaginationResult|PaginationResult|toCanonicalList)\\b"
output_mode: content
```
Also `@classytic/arc-next/api` for `OffsetPaginationResponse` / `KeysetPaginationResponse` / `AggregatePaginationResponse` / `PaginatedResponse`.

**Why high:** Pagination types and the `toCanonicalList()` helper now live in `@classytic/repo-core/pagination` as the single source of truth (primitives' duplicate dropped, mongokit's local declarations dropped, arc-next's response types removed). Importing from any other package risks drift between the type the host believes and the one the kit actually returns.

**Fix:**
```typescript
import type {
  OffsetPaginationResult, KeysetPaginationResult,
  AggregatePaginationResult, PaginationResult,
} from '@classytic/repo-core/pagination';
import { toCanonicalList } from '@classytic/repo-core/pagination';
```
The wire envelope carries `method` ('offset' | 'keyset' | 'aggregate') as the discriminant; arc's `reply.sendList()` calls `toCanonicalList` internally.

---

## §32b. Importing event types from arc 🟠

**Detection:**
```
pattern: "from\\s+['\"]@classytic/arc/events['\"][^\\n]*\\b(EventMeta|DomainEvent|EventHandler|EventLogger|EventTransport|DeadLetteredEvent|PublishManyResult|createEvent|createChildEvent|matchEventPattern)\\b"
output_mode: content
```

**Why high:** Event types now live in `@classytic/primitives/events` as the single source of truth. Arc only re-exports the runtime `MemoryEventTransport`. Hosts importing event types from arc lock themselves to arc's version even when the type lives in primitives.

**Fix:**
```typescript
import type {
  EventMeta, DomainEvent, EventHandler, EventLogger, EventTransport,
  DeadLetteredEvent, PublishManyResult,
} from '@classytic/primitives/events';
import { createEvent, createChildEvent, matchEventPattern } from '@classytic/primitives/events';
import { MemoryEventTransport } from '@classytic/arc/events';   // runtime stays at arc
```

---

## §32c. Importing tenant config from primitives 🟡

**Detection:**
```
pattern: "from\\s+['\"]@classytic/primitives/tenant['\"]"
output_mode: content
```

**Why medium:** `TenantConfig`, `TenantStrategy`, `TenantFieldType`, `resolveTenantConfig`, `DEFAULT_TENANT_CONFIG`, `ResolvedTenantConfig` now live in `@classytic/repo-core/tenant`. Mongokit and sqlitekit both `extends Pick<TenantConfig, ...>` from repo-core.

**Fix:**
```typescript
import type { TenantConfig, ResolvedTenantConfig } from '@classytic/repo-core/tenant';
import { resolveTenantConfig, DEFAULT_TENANT_CONFIG } from '@classytic/repo-core/tenant';
```

---

## §32d. Importing error types from primitives or mongokit 🟠

**Detection:**
```
pattern: "from\\s+['\"]@classytic/(primitives/errors|mongokit)['\"][^\\n]*\\bHttpError\\b"
output_mode: content
```

**Why high:** `HttpError` (throwable contract), `ErrorContract` (wire shape), `ErrorDetail`, `ErrorCode`, `ERROR_CODES`, `toErrorContract()`, `statusToErrorCode()` all live in `@classytic/repo-core/errors`. `ArcError implements HttpError` from repo-core. Mongokit no longer publishes its own `HttpError`.

**Fix:**
```typescript
import type { HttpError, ErrorContract, ErrorDetail, ErrorCode } from '@classytic/repo-core/errors';
import { toErrorContract, statusToErrorCode, ERROR_CODES } from '@classytic/repo-core/errors';
```

---

## §32e. Hand-rolled `if (!getOrgId(scope)) throw …` 🟡

**Detection:**
```
pattern: "if\\s*\\(\\s*!\\s*getOrgId\\s*\\("
output_mode: content
```
Also: `if (!getUserId(...))`, `if (!getClientId(...))`, `if (!getTeamId(...))` followed by a manual throw.

**Why medium:** Arc 2.12 ships `requireOrgId(scope, hint?)` / `requireUserId(scope, hint?)` / `requireClientId(scope, hint?)` / `requireTeamId(scope, hint?)` which return the value or throw a 403 `ArcError`. Hand-rolled guards usually throw a generic `Error` (wrong status), forget the optional hint, or duplicate the same boilerplate at every call site.

**Fix:**
```typescript
import { requireOrgId, requireUserId } from '@classytic/arc/scope';

const orgId = requireOrgId(scope);                           // throws 403 if missing
const userId = requireUserId(scope, 'finalize-checkout');    // hint surfaces in error.details
```

---

## §32f. `createMongooseAdapter` without `schemaGenerator` 🟠

**Detection:**
```
pattern: "createMongooseAdapter\\s*\\(\\s*\\{[^}]*\\}\\s*\\)"
multiline: true
```
Then check whether the object literal includes a `schemaGenerator:` key.

Also: `createDrizzleAdapter` without `schemaGenerator: buildCrudSchemasFromTable`.

**Why high:** Arc 2.12 deleted the built-in mongoose / drizzle schema-gen fallback (~290 LOC). If `schemaGenerator` is omitted, OpenAPI bodies are emitted as `null` rather than silently inferred — the route still serves traffic but the docs / MCP tool input schemas are empty.

**Fix:**
```typescript
import { createMongooseAdapter } from '@classytic/mongokit/adapter';   // arc 2.12+
import { buildCrudSchemasFromModel } from '@classytic/mongokit';

createMongooseAdapter({
  model: ProductModel,
  repository: productRepo,
  schemaGenerator: buildCrudSchemasFromModel,   // required
});
```
For drizzle: `import { createDrizzleAdapter } from '@classytic/sqlitekit/adapter'` + `schemaGenerator: buildCrudSchemasFromTable` from `@classytic/sqlitekit`.

---

## §32g. Importing kit-specific adapters from `@classytic/arc` (any subpath) 🔴

**Detection:**
```
pattern: "from\\s+['\"]@classytic/arc(/adapters)?['\"][^\\n]*\\b(createMongooseAdapter|MongooseAdapter|createDrizzleAdapter|DrizzleAdapter|createPrismaAdapter|PrismaAdapter|PrismaQueryParser|InferMongooseDoc|MongooseDocument|isMongooseModel|MongooseAdapterOptions|DrizzleAdapterOptions|DrizzleColumnLike|DrizzleTableLike)\\b"
output_mode: content
```

Also: adapter contract types imported from arc — `import type { DataAdapter, AdapterRepositoryInput, AdapterFactory, OpenApiSchemas, SchemaMetadata, FieldMetadata, RelationMetadata, AdapterValidationResult, AdapterSchemaContext } from '@classytic/arc'` (any subpath). And: `mergeFieldRuleConstraints` from `@classytic/arc/adapters`. Any `from '@classytic/arc/adapters'` import — the entire subpath was removed in arc 2.12.

**Why critical:** This only worked in arc ≤ 2.x. Arc 2.12 moved every kit-specific adapter (Mongoose, Drizzle, Prisma) into its kit and the cross-framework adapter contract into `@classytic/repo-core/adapter`. The `@classytic/arc/adapters` subpath was removed entirely. Importing these names from arc fails to resolve on 3.x — the build breaks at install time. The new shape is **strict**: kit-specific things MUST come from the kit; the contract MUST come from repo-core.

**Fix:**
```typescript
// Mongoose
import {
  createMongooseAdapter, MongooseAdapter,
  type MongooseAdapterOptions, type InferMongooseDoc,
  type MongooseDocument, isMongooseModel,
} from '@classytic/mongokit/adapter';

// Drizzle
import {
  createDrizzleAdapter, DrizzleAdapter,
  type DrizzleAdapterOptions, type DrizzleColumnLike, type DrizzleTableLike,
} from '@classytic/sqlitekit/adapter';

// Prisma
import {
  createPrismaAdapter, PrismaAdapter, PrismaQueryParser,
} from '@classytic/prismakit/adapter';

// Cross-framework adapter contract
import type {
  DataAdapter, RepositoryLike, AdapterRepositoryInput,
  AdapterFactory, AdapterValidationResult, AdapterSchemaContext,
  OpenApiSchemas, SchemaMetadata, FieldMetadata, RelationMetadata,
} from '@classytic/repo-core/adapter';
import { asRepositoryLike, isRepository } from '@classytic/repo-core/adapter';

// Schema helpers
import { mergeFieldRuleConstraints, applyNullable } from '@classytic/repo-core/schema';
```

The `@classytic/arc/adapters` subpath has been **removed** in arc 2.12 — no symbols ship there anymore. `RepositoryLike` is re-exported from `@classytic/arc` for convenience, but importing from `@classytic/repo-core/adapter` is canonical. Custom kits implementing `DataAdapter<TDoc>` from `@classytic/repo-core/adapter` plug in identically.

---

## §32. Headers set in `onSend` hook 🔴

**Detection:**
```
pattern: "addHook\\(['\"]onSend"
output_mode: content
```
Then check whether the hook body sets headers (`reply.header(`, `reply.headers[`).

**Why critical:** Async `onSend` races with Fastify's `onSendEnd → safeWriteHead` flush path and produces `ERR_HTTP_HEADERS_SENT` under slow responses. Intermittent prod failures, hard to reproduce.

**Fix:** Set headers in `onRequest` (before handler) or `preSerialization` (before flush). Never `onSend`.

---

## Detection checklist (run-order)

Run sweeps in this order — early hits often invalidate later context:

1. §10 — driver imports outside adapters (most architecturally significant)
2. §28 — mongoose without mongokit (scope of mongokit migration)
3. §3 — manual CRUD route count (scope of defineResource migration)
4. §4 + §9 + §17 — auth/scope (security-critical)
5. §5 — toJSON / response stripping (security-critical)
6. §25, §27, §32 — webhook/SSE/header gotchas (security-critical)
7. §1, §2, §6, §16 — query/schema/openapi/search (style + drift)
8. §7, §8, §22, §23 — events/cache/idempotency/audit (silent inconsistency)
9. §14, §18, §19 — preset adoption + custom controller wiring
10. §11, §12, §13, §29, §30, §31 — style and edges
11. §32a–§32g — canonical-contract drift (pagination / events / tenant / errors / adapter imports), missing `requireOrgId` accessors, missing `schemaGenerator`, kit-specific adapter imports from arc (3.0 break)
