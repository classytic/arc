---
name: arc
description: |
  @classytic/arc — Resource-oriented backend framework for Fastify.
  Use when building REST APIs with Fastify, resource CRUD, defineResource, createApp,
  permissions, presets, database adapters, hooks, events, QueryCache, authentication,
  multi-tenant SaaS, OpenAPI, job queues, WebSocket, MCP tools, or production deployment.
  Triggers: arc, fastify resource, defineResource, createApp, BaseController, arc preset,
  arc auth, arc events, arc jobs, arc websocket, arc mcp, arc plugin, arc testing, arc cli,
  arc permissions, arc hooks, arc pipeline, arc factory, arc cache, arc QueryCache.
version: 2.11.0
license: MIT
metadata:
  author: Classytic
  version: "2.11.0"
tags:
  - fastify
  - rest-api
  - resource-framework
  - crud
  - permissions
  - multi-tenant
  - presets
  - typescript
  - cache
  - events
  - openapi
progressive_disclosure:
  entry_point:
    summary: "Resource-oriented Fastify framework: defineResource(), presets, permissions, QueryCache, events, multi-tenant, OpenAPI"
    when_to_use: "Building REST APIs with Fastify, resource CRUD, authentication, presets, caching, events, or production deployment"
    quick_start: "1. npm install @classytic/arc fastify 2. createApp({ preset: 'production', auth: { type: 'jwt', jwt: { secret } } }) 3. defineResource({ name, adapter, presets, permissions })"
  context_limit: 700
---

# @classytic/arc

Resource-oriented backend framework for Fastify. Database-agnostic, tree-shakable, production-ready.

**Requires:** Fastify `^5.7.4` | Node.js `>=22` | ESM only

## Install

```bash
# Install the Arc agent skill (Claude Code / AI agents)
npx skills add classytic/arc

# Install the npm package
npm install @classytic/arc fastify
npm install @classytic/mongokit mongoose    # MongoDB adapter
```

## Quick Start

```typescript
import { createApp } from '@classytic/arc/factory';
import mongoose from 'mongoose';

await mongoose.connect(process.env.DB_URI);

const app = await createApp({
  preset: 'production',
  auth: { type: 'jwt', jwt: { secret: process.env.JWT_SECRET } },
  cors: { origin: process.env.ALLOWED_ORIGINS?.split(',') },
  resources: [productResource, orderResource],   // canonical path — factory registers in the right lifecycle slot
});

await app.listen({ port: 8040, host: '0.0.0.0' });
```

For async-booted engines (repository wired in `bootstrap[]`), use the factory form:

```typescript
resources: async (fastify) => {
  const engine = await ensureCatalogEngine();
  return [buildProductResource(engine), buildCategoryResource(engine)];
}
```

Advanced escape hatch: `await app.register(productResource.toPlugin())` registers a single resource directly. Use only when you need manual control over the scope/prefix — the `resources` factory option is preferred.

## Security defaults (active in 2.11)

- **Field-write perms: `reject`** — requests carrying non-writable fields get 403 with denied-field list. Opt into silent strip: `defineResource({ onFieldWriteDenied: 'strip' })`.
- **multiTenant injects org on UPDATE** — body-supplied `organizationId` overwritten with caller's scope. Closes tenant-hop vector.
- **Elevation emits `arc.scope.elevated`** — audit via `fastify.events.subscribe(...)`.
- **`verifySignature(body, ...)`** throws on parsed body — pass `req.rawBody`.
- **Upload `sanitizeFilename`** strict by default. Pass `false` / `'*'` / custom fn to relax.
- **Idempotency `namespace`** option for shared-store prod+canary deployments.
- **`systemManaged` fields auto-strip from `required[]`** — framework-injected fields (tenant, audit) removed from create/update `required[]` so Fastify preValidation doesn't reject before arc's injection runs.

For removed APIs and version-by-version breaking changes, see [CHANGELOG.md](../../CHANGELOG.md). For the full tenant-pipeline walkthrough, see [docs/production-ops/tenant-pipeline.mdx](../../docs/production-ops/tenant-pipeline.mdx).

## defineResource()

Single API to define a full REST resource:

```typescript
import { defineResource, createMongooseAdapter, allowPublic, requireRoles } from '@classytic/arc';

const productResource = defineResource({
  name: 'product',
  adapter: createMongooseAdapter({ model: ProductModel, repository: productRepo }),
  controller: productController,  // optional — auto-created if omitted
  presets: ['softDelete', 'slugLookup', { name: 'multiTenant', tenantField: 'orgId' }],
  permissions: {
    list: allowPublic(),
    get: allowPublic(),
    create: requireRoles(['admin']),
    update: requireRoles(['admin']),
    delete: requireRoles(['admin']),
  },
  cache: { staleTime: 30, gcTime: 300, tags: ['catalog'] },

  // routeGuards — auto-apply to ALL routes (CRUD + custom + preset)
  routeGuards: [modeGuard, orgGuard.preHandler],

  // fieldRules — portable constraints + framework-injection hints
  schemaOptions: {
    fieldRules: {
      name: { minLength: 2, maxLength: 200, description: 'Product name' },
      price: { min: 0, max: 100000 },
      sku: { pattern: '^[A-Z]{3}-\\d{3}$' },
      status: { enum: ['draft', 'active', 'archived'] },
      deletedAt: { systemManaged: true },                 // arc stamps it — strip from body + required[]
      priceMode: { nullable: true },                      // Zod .nullable() lost through Mongoose — widen to accept null
    },
  },

  // Custom routes (compose with presets — softDelete adds /deleted, /:id/restore)
  routes: [
    { method: 'GET', path: '/stats', handler: 'getStats', permissions: requireAuth() },
    { method: 'POST', path: '/webhook', handler: webhookFn, raw: true, permissions: requireAuth() },
  ],

  // Actions — single POST /:id/action endpoint, discriminated on `action` body field
  actions: {
    approve: async (id, data, req) => service.approve(id, req.user._id),
    cancel: {
      handler: async (id, data, req) => service.cancel(id, data.reason, req.user._id),
      permissions: requireRoles('admin'),
      schema: { reason: { type: 'string' } },
    },
  },
  actionPermissions: requireAuth(),
});

// Register via createApp — canonical path:
//   createApp({ resources: [productResource] })
// Auto-generates: GET /, GET /:id, POST /, PATCH /:id, DELETE /:id
// + softDelete preset adds: GET /deleted, POST /:id/restore
```

## routeGuards + defineGuard

Resource-level guards that apply to **every** route (CRUD + custom + preset):

```typescript
import { defineGuard } from '@classytic/arc/utils';
import type { RouteHandlerMethod } from '@classytic/arc';

// Simple guard — reject if condition fails
const modeGuard: RouteHandlerMethod = async (req, reply) => {
  if (!req.headers['x-mode']) {
    reply.code(403).send({ error: 'Mode header required' });
  }
};

// Typed guard — resolve context once, extract anywhere
const orgGuard = defineGuard({
  name: 'org',
  resolve: (req) => {
    const orgId = req.headers['x-org-id'] as string;
    if (!orgId) throw new Error('Missing x-org-id');
    return { orgId, actorId: req.user?.id ?? 'system' };
  },
});

defineResource({
  name: 'procurement',
  routeGuards: [modeGuard, orgGuard.preHandler],  // all routes protected
  routes: [{
    method: 'GET', path: '/summary', raw: true, permissions: requireAuth(),
    handler: async (req, reply) => {
      const { orgId } = orgGuard.from(req);  // typed, no re-computation
      reply.send({ orgId, count: await Model.countDocuments() });
    },
  }],
  // ...
});
```

**Execution order:** auth → permissions → cache/idempotency → `routeGuards` → per-route `preHandler`

## fieldRules → OpenAPI + AJV

One definition, two outputs — constraints auto-map to OpenAPI schema + Fastify AJV validation. Extends repo-core's `FieldRule` floor with arc extensions.

```typescript
schemaOptions: {
  fieldRules: {
    name: { minLength: 2, maxLength: 200, description: 'Product name' },
    price: { min: 0, max: 100000 },
    sku: { pattern: '^[A-Z]{3}-\\d{3}$' },
    status: { enum: ['draft', 'active', 'archived'] },
    password: { hidden: true },                   // blocked from select + OpenAPI
    deletedAt: { systemManaged: true },           // blocked from input schemas; framework stamps it
    slug: { immutable: true },                    // excluded from update body
    priceMode: { nullable: true },                // widen JSON-Schema type to include null
    organizationId: { systemManaged: true, preserveForElevated: true }, // tenant field (auto-injected)
  },
},
```

| Flag | Effect |
|---|---|
| `systemManaged` | Strip from body on ingest, drop from `required[]`. Framework stamps the value (tenant, audit, engine-derived slug). |
| `preserveForElevated` | Elevated admins keep the field on ingest (platform-level cross-tenant writes). |
| `immutable` / `immutableAfterCreate` | Omit from update body. Inheritance: repo-core floor. |
| `optional` | Strip from `required[]` without touching `properties`. |
| `nullable` | Widen JSON-Schema `type` to include null (+ appends `null` to `enum` if present). |
| `hidden` | Block from response projection + OpenAPI. |
| `minLength` / `maxLength` / `min` / `max` / `pattern` / `enum` | Map to AJV validators + OpenAPI constraints. |
| `description` | Maps to OpenAPI `description`. |

Mongoose model-level constraints (`minlength`, `maxlength`, `min`, `max`, `enum`) take precedence. `fieldRules` supplements what the model doesn't declare. Kit schema generators see only the repo-core floor; arc's extensions apply post-kit via `mergeFieldRuleConstraints`.

See [docs/framework-extension/custom-adapters.mdx — Field Rules](../../docs/framework-extension/custom-adapters.mdx#field-rules--shaping-kit-generated-schemas) for the `systemManaged` decision table.

## Authentication

Auth uses a **discriminated union** with `type` field:

```typescript
// Arc JWT (with optional token extraction and revocation)
auth: {
  type: 'jwt',
  jwt: { secret, expiresIn: '15m', refreshSecret, refreshExpiresIn: '7d' },
  tokenExtractor: (req) => req.cookies?.['auth-token'] ?? null,  // optional
  isRevoked: async (decoded) => redis.sismember('revoked', decoded.jti),  // optional
}

// Better Auth (recommended for SaaS with orgs)
import { createBetterAuthAdapter } from '@classytic/arc/auth';
auth: { type: 'betterAuth', betterAuth: createBetterAuthAdapter({ auth, orgContext: true }) }

// Custom Fastify plugin (must decorate fastify.authenticate)
auth: { type: 'custom', plugin: myAuthPlugin }

// Custom function (decorates fastify.authenticate directly)
auth: { type: 'authenticator', authenticate: async (req, reply) => { ... } }

// Disabled
auth: false
```

**Decorates:** `app.authenticate`, `app.optionalAuthenticate`, `app.authorize`

### Better Auth + Mongoose populate bridge (`@classytic/arc/auth/mongoose`)

When BA uses `@better-auth/mongo-adapter`, it writes via the native `mongodb` driver and never registers Mongoose models. arc resources doing `Schema({ userId: { ref: 'user' } })` then throw `MissingSchemaError` on `.populate()`.

```typescript
import mongoose from 'mongoose';
import { registerBetterAuthMongooseModels } from '@classytic/arc/auth/mongoose';

// Default: core only (user/session/account/verification). Plugins are opt-in.
registerBetterAuthMongooseModels(mongoose, {
  plugins: ['organization', 'organization-teams', 'mcp'],
  // For separate @better-auth/* packages (passkey, sso, api-key):
  extraCollections: ['passkey', 'ssoProvider'],
  // Optional:
  usePlural: false,                                     // matches mongodbAdapter({ usePlural })
  modelOverrides: { user: 'profile' },                  // for custom user.modelName configs
});
```

**Plugin keys** (core BA only — separate packages use `extraCollections`):
- `organization` → `organization`, `member`, `invitation`
- `organization-teams` → `team`, `teamMember`
- `twoFactor` → `twoFactor`
- `jwt` → `jwks`
- `oidcProvider` / `oauthProvider` (alias) → `oauthApplication`, `oauthAccessToken`, `oauthConsent`
- `mcp` → reuses oidcProvider schema (per BA docs)
- `deviceAuthorization` → `deviceCode`

**Field-only plugins** (admin, username, phoneNumber, magicLink, emailOtp, anonymous, bearer, multiSession, siwe, lastLoginMethod, genericOAuth) need NO entry — `strict: false` stubs round-trip extra fields automatically.

Lives at a dedicated subpath so non-Mongoose users (Prisma/Drizzle/Kysely) never get Mongoose pulled into their bundle. Idempotent + de-dupes overlapping plugin sets, so `plugins: ['mcp', 'oidcProvider']` won't crash.

## Permissions

Function-based. A `PermissionCheck` returns `boolean | { granted, reason?, filters?, scope? }`:

```typescript
import {
  // Core
  allowPublic, requireAuth, requireRoles, requireOwnership,
  // Org-bound
  requireOrgMembership, requireOrgRole, requireTeamMembership,
  // Service / API key (OAuth-style)
  requireServiceScope,
  // App-defined scope dimensions (branch, project, region, …)
  requireScopeContext,
  // Parent-child org hierarchy
  requireOrgInScope,
  // Combinators
  allOf, anyOf, when, denyAll,
  // Dynamic ACL
  createDynamicPermissionMatrix,
} from '@classytic/arc';

permissions: {
  list: allowPublic(),
  get: requireAuth(),
  create: requireRoles(['admin', 'editor']),
  update: anyOf(requireOwnership('userId'), requireRoles(['admin'])),
  delete: allOf(requireAuth(), requireRoles(['admin'])),
}
```

**Mixed human + machine routes** — accept both an org admin and an API key:

```typescript
import { requireServiceScope } from '@classytic/arc';

permissions: {
  // Human admins OR API keys with the right OAuth scope
  create: anyOf(
    requireOrgRole('admin'),
    requireServiceScope('jobs:write'),
  ),

  // Org-bound API key with a specific scope (no human path)
  bulkImport: allOf(
    requireOrgMembership(),                  // accepts member, service, elevated
    requireServiceScope('jobs:bulk-write'),  // OAuth-style scope check
  ),
}
```

**Multi-level tenancy** — for app-defined scope dimensions beyond org/team
(branch, project, region, workspace, department, …):

```typescript
import { requireScopeContext } from '@classytic/arc';
import { multiTenantPreset } from '@classytic/arc/presets';

// 1. Populate scope.context in your auth function (from headers, JWT claims,
//    BA session fields — arc takes no position on the source).
authFn: async (request) => {
  const session = await myAuth.getSession(request);
  request.scope = {
    kind: 'member',
    userId: session.userId,
    userRoles: session.userRoles,
    organizationId: session.orgId,
    orgRoles: session.orgRoles,
    context: {
      branchId: request.headers['x-branch-id'],
      projectId: request.headers['x-project-id'],
    },
  };
}

// 2. Gate routes by context dimensions
permissions: {
  branchAdmin: allOf(requireOrgRole('admin'), requireScopeContext('branchId')),
  euOnly:      requireScopeContext('region', 'eu'),
  projectEdit: requireScopeContext({ projectId: undefined, region: 'eu' }),
}

// 3. Auto-filter resource queries across all dimensions in lockstep
defineResource({
  name: 'job',
  presets: [
    multiTenantPreset({
      tenantFields: [
        { field: 'organizationId', type: 'org' },
        { field: 'branchId',       contextKey: 'branchId' },
        { field: 'projectId',      contextKey: 'projectId' },
      ],
    }),
  ],
});
```

Fail-closed: missing dimensions → 403 with the specific missing field name.
Elevated scopes (platform admins) apply whatever resolves and skip the rest
(cross-context bypass).

**Parent-child org hierarchy** — for holding companies, MSPs managing
multiple tenants, white-label parent → child accounts. Arc takes no position
on the source: your auth function loads the chain from your own org table.

```typescript
import { requireOrgInScope } from '@classytic/arc';

// 1. Auth function loads ancestorOrgIds from your org table.
//    Order is closest-first (immediate parent → root).
authFn: async (request) => {
  const session = await myAuth.getSession(request);
  const ancestors = await orgRepo.findAncestors(session.orgId);
  request.scope = {
    kind: 'member',
    userId: session.userId,
    userRoles: session.userRoles,
    organizationId: session.orgId,
    orgRoles: session.orgRoles,
    ancestorOrgIds: ancestors.map(a => a.id),  // ['acme-eu', 'acme-holding']
  };
}

// 2. Gate routes — accepts current org or any ancestor in the chain
permissions: {
  // GET /orgs/:orgId/jobs — caller can act on any org in their hierarchy
  list: requireOrgInScope((ctx) => ctx.request.params.orgId),

  // Static target (rare): one route, one specific org
  holdingDashboard: requireOrgInScope('acme-holding'),

  // Composed: must be admin AND target must be in hierarchy
  childAdmin: allOf(
    requireOrgRole('admin'),
    requireOrgInScope((ctx) => ctx.request.params.orgId),
  ),
}
```

**No automatic inheritance** — every check is explicit. `multiTenantPreset`
does NOT auto-include ancestor data (would be a footgun). Sibling
subsidiaries naturally don't see each other's data because they aren't in
each other's chain. Elevated bypass still applies on the permission helper.

**Auth source agnostic** — `requireRoles()` checks platform roles
(`user.role`) AND org roles (`scope.orgRoles`) by default, so it works
identically with arc JWT, Better Auth user roles, and Better Auth org plugin.
`requireOrgMembership()` accepts `member`, `service` (API key), and
`elevated` scopes. `requireOrgRole()` is human-only by design — use
`anyOf(requireOrgRole(...), requireServiceScope(...))` for mixed routes.
`scope.context` and `scope.ancestorOrgIds` are populated by your own auth
function or adapter — arc doesn't bake in any specific dimension or transport.

### RequestScope (quick reference)

Five kinds, all opt-in. Always read via accessors from `@classytic/arc/scope`,
never via direct property access.

```typescript
type RequestScope =
  | { kind: 'public' }
  | { kind: 'authenticated'; userId?; userRoles? }
  | { kind: 'member';   userId?; userRoles; organizationId; orgRoles; teamId?; context?; ancestorOrgIds? }
  | { kind: 'service';  clientId; organizationId; scopes?; context?; ancestorOrgIds? }
  | { kind: 'elevated'; userId?; organizationId?; elevatedBy; context?; ancestorOrgIds? };
```

| Kind | Identity | Org context | Set by |
|---|---|---|---|
| `public` | none | none | Default for anonymous requests |
| `authenticated` | userId, userRoles | none | Logged in, no active org |
| `member` | userId, userRoles | organizationId + orgRoles (+ teamId, context, ancestorOrgIds) | BA org plugin / JWT custom auth |
| `service` | clientId, scopes | organizationId (required) | API key via `PermissionResult.scope` |
| `elevated` | userId | organizationId optional | Elevation plugin via `x-arc-scope: platform` header |

| Helper | `member` | `service` | `elevated` |
|---|---|---|---|
| `requireOrgMembership()` | ✅ | ✅ | ✅ |
| `requireOrgRole(roles)` | If role matches | ❌ deny w/ guidance | ✅ bypass |
| `requireServiceScope(scopes)` | ❌ | If scope matches | ✅ bypass |
| `requireScopeContext(...)` | If keys match | If keys match | ✅ bypass |
| `requireTeamMembership()` | If `teamId` set | (n/a) | ✅ bypass |
| `requireOrgInScope(target)` | If target in chain | If target in chain | ✅ bypass |

```typescript
import {
  isMember, isService, isElevated, hasOrgAccess,
  getOrgId, getUserId, getOrgRoles, getServiceScopes,
  getScopeContext, getAncestorOrgIds, isOrgInScope,
} from '@classytic/arc/scope';

if (hasOrgAccess(scope))   // member | service | elevated
if (isService(scope))      // narrows to API key
const orgId  = getOrgId(scope);                    // member | service | elevated
const branch = getScopeContext(scope, 'branchId'); // custom dimension
isOrgInScope(scope, 'acme-holding');               // pure predicate (no elevated bypass)
```

**Custom permission:**

```typescript
const requirePro = (): PermissionCheck => async (ctx) => {
  if (!ctx.user) return { granted: false, reason: 'Auth required' };
  return { granted: ctx.user.plan === 'pro' };
};
```

**Field-level permissions:**

```typescript
import { fields } from '@classytic/arc';

fields: {
  password: fields.hidden(),
  salary: fields.visibleTo(['admin', 'hr']),
  role: fields.writableBy(['admin']),
  email: fields.redactFor(['viewer'], '***'),
}
```

**Dynamic ACL (DB-managed):**

```typescript
const acl = createDynamicPermissionMatrix({
  resolveRolePermissions: async (ctx) => aclService.getRoleMatrix(orgId),
  cacheStore: new RedisCacheStore({ client: redis, prefix: 'acl:' }),
});
permissions: { list: acl.canAction('product', 'read') }
```

## Presets

| Preset | Routes Added | Controller Interface | Config |
|--------|-------------|---------------------|--------|
| `softDelete` | GET /deleted, POST /:id/restore | `ISoftDeleteController` | `{ deletedField }` |
| `slugLookup` | GET /slug/:slug | `ISlugLookupController` | `{ slugField }` |
| `tree` | GET /tree, GET /:parent/children | `ITreeController` | `{ parentField }` |
| `ownedByUser` | none (middleware) | — | `{ ownerField }` |
| `multiTenant` | none (middleware) | — | `{ tenantField }` OR `{ tenantFields: TenantFieldSpec[] }` (2.7.1+) |
| `audited` | none (middleware) | — | — |
| `bulk` | POST/PATCH/DELETE /bulk | — | `{ operations?, maxCreateItems? }` |
| `filesUpload` | POST /upload, GET /:id, DELETE /:id | — (uses `Storage` adapter) | `{ storage, sanitizeFilename?, allowedMimeTypes?, maxFileSize? }` |
| `search` | POST /search, /search-similar, /embed (opt-in) | — | `{ repository?, search?, similar?, embed?, routes? }` |

```typescript
// Single-field (default, backwards compatible)
presets: ['softDelete', { name: 'multiTenant', tenantField: 'organizationId' }]

// Multi-field — org + branch + project in lockstep (2.7.1+)
presets: [
  multiTenantPreset({
    tenantFields: [
      { field: 'organizationId', type: 'org' },                // → getOrgId(scope)
      { field: 'teamId',         type: 'team' },               // → getTeamId(scope)
      { field: 'branchId',       contextKey: 'branchId' },     // → scope.context.branchId
      { field: 'projectId',      contextKey: 'projectId' },
    ],
  }),
]

// Bulk: presets: ['bulk'] or bulkPreset({ operations: ['createMany', 'updateMany'] })
```

`multiTenant` recognizes `member`, `service` (API key), and `elevated`
scopes uniformly via `hasOrgAccess()`. Multi-field uses fail-closed
semantics: missing dimensions → 403 with the specific missing field name.
Elevated scopes apply whatever resolves and skip the rest.

### tenantField — When to Use and When to Disable

Arc defaults `tenantField` to `'organizationId'` on BaseController. This silently adds `{ organizationId: scope.organizationId }` to every query when the user has an org context. Correct for per-org resources, wrong for company-wide resources.

```typescript
// Per-org resource (default) — each org sees only its own data
defineResource({ name: 'invoice', ... });
// → queries auto-scoped: { organizationId: 'org-123' }

// Company-wide resource — ALL orgs share the same data
defineResource({ name: 'account-type', tenantField: false, ... });
// → no org filter applied, all users see all records

// Custom tenant field — your schema uses a different name
defineResource({ name: 'workspace-item', tenantField: 'workspaceId', ... });
// → queries scoped by workspaceId instead of organizationId
```

When to use `tenantField: false`:
- Lookup tables (account types, categories, currencies)
- Platform-wide settings or config
- Cross-org reports or analytics
- Single-tenant apps where org scoping isn't needed

### idField — Custom Primary Key

Default is `'_id'`. Override for resources keyed by a business identifier (UUID, slug, `ORD-2026-0001`, `job-5219f346-a4d`, etc.).

```typescript
defineResource({
  name: 'job',
  adapter: createMongooseAdapter(JobModel, jobRepository),
  idField: 'jobId',     // ← one line (or omit and auto-derive from repository.idField — see below)
});

// GET /jobs/job-5219f346-a4d  → controller runs { jobId: 'job-5219f346-a4d' }
// GET /jobs/<uuid>             → accepted (no ObjectId pattern enforcement)
```

Changes all three layers:
- **Fastify AJV** — strips any ObjectId pattern from `params.id` so custom formats aren't pre-rejected
- **BaseController** — `get`/`update`/`delete` query by `{ [idField]: id }` (merged with tenant + policy filters)
- **OpenAPI docs** — `spec.paths['/jobs/{id}']` emits a plain string `id` with description
- **MCP tools** — auto-generated CRUD tools use `idField` transparently

**Auto-derive from repository** (2.7.x+). If you don't set `idField` on `defineResource` but your `adapter.repository` exposes one (e.g. `new Repository(Model, [], {}, { idField: 'slug' })`), Arc picks it up automatically. Configure in one place, not two.

**URL path segment is ALWAYS `:id` and `req.params.id` is ALWAYS named `id`** — regardless of what `idField` is set to. `idField` controls the *lookup field*, not the *URL parameter name*. This is the same convention Stripe / GitHub / most REST APIs use:

```typescript
// idField: 'slug'
// Client sends:  POST /agents/sadman/action
// In handler:    req.params.id === 'sadman'       ← always keyed 'id'
//                repo.update(id, data)             ← mongokit resolves by slug via repo.idField
```

This applies to CRUD routes (`GET/PATCH/DELETE /:id`), action routes (`POST /:id/action`), and any `routes: [...]` entries that use `:id`.

**Common confusion pattern.** A 404 on `PATCH /agents/sadman` when `GET /agents/sadman` returns 200 looks like an `idField` bug but usually isn't. Check whether your **update permission** returns `filters` — arc merges those into the compound DB lookup (`{ slug: 'sadman', ...filters }`), and a filter that excludes the doc is what's returning null. Fix is in the permission, not `idField`.

User-provided `openApiSchemas.params` still overrides everything.

For custom adapters, honor the new `AdapterSchemaContext` passed to `generateSchemas(options, context?)` to emit the right `params.id` pattern from the start. Legacy adapters still work — Arc's safety net strips mismatched ObjectId patterns automatically.

## searchPreset (text + vector + embed)

Backend-agnostic routes for Elasticsearch / OpenSearch / Algolia / Typesense / Atlas `$vectorSearch` / Pinecone / Qdrant / Milvus. Opt-in per section; `mcp: false` skips per path.

```typescript
import { searchPreset } from '@classytic/arc/presets/search';

// A — auto-wire from a repo with search/searchSimilar/embed methods
// (mongokit's elasticSearchPlugin + vectorPlugin register exactly these).
// Each method's native calling convention is honoured:
//   search(query, options)          — positional (elasticSearchPlugin)
//   searchSimilar(VectorSearchParams) — single object (vectorPlugin)
//   embed(input)                    — single arg (vectorPlugin)
searchPreset({
  repository: productRepo,
  search: true,    // POST /search         → repo.search(body.query, body)
  similar: true,   // POST /search-similar → repo.searchSimilar(body)
  // embed omitted → /embed not mounted
})

// B — external backends + custom path + Zod schema
searchPreset({
  search: {
    path: '/full-text',
    schema: { body: z.object({ q: z.string().min(1) }) },
    handler: (req) => elastic.search({ index: 'products', q: req.body.q }),
  },
  similar: { handler: (req) => pinecone.query({ vector: req.body.vector, topK: 10 }), mcp: false },
  routes: [  // bespoke paths
    { method: 'GET', path: '/autocomplete', permissions: allowPublic(),
      handler: (req) => algolia.suggest((req.query as { q: string }).q) },
  ],
})
```

**Defaults:** search/similar → POST, permissions fall back to resource `list` → `allowPublic()`. Embed → POST + `requireAuth()`. Every field (`path`, `method`, `schema`, `permissions`, `mcp`, `summary`, `tags`, `operation`) is overridable per section. Zod v4 schemas auto-convert to JSON Schema for both Fastify validation and OpenAPI.

**MCP namespacing:** tool names are `{op}_{resource}` — many resources can register their own searchPreset under one `mcpPlugin` endpoint without colliding (`product_search`, `order_search`, …).

**When to use `routes` directly instead:** one-off search endpoints, or when you want full control without the preset's defaults.

## QueryCache

TanStack Query-inspired server cache with stale-while-revalidate and auto-invalidation on mutations.

```typescript
// Enable globally
const app = await createApp({ arcPlugins: { queryCache: true } });

// Per-resource config
defineResource({
  name: 'product',
  cache: {
    staleTime: 30,      // seconds fresh (no revalidation)
    gcTime: 300,         // seconds stale data kept (SWR window)
    tags: ['catalog'],   // cross-resource grouping
    invalidateOn: { 'category.*': ['catalog'] },  // event pattern → tag targets
    list: { staleTime: 60 },  // per-operation override
    byId: { staleTime: 10 },
  },
});
```

**Auto-invalidation:** POST/PATCH/DELETE bumps resource version. Old cached queries expire naturally via TTL.

**Runtime modes:** `memory` (default, zero-config) | `distributed` (requires `stores.queryCache: RedisCacheStore`)

**Response header:** `x-cache: HIT | STALE | MISS`

## Controllers (v2.11 mixin split)

`BaseController` was split in 2.11 from a 1,589-LOC god class into a mixin composition. `extends BaseController<Product>` still works exactly the same — a declaration-merged interface threads `TDoc` through every CRUD + preset method.

```typescript
import { BaseController } from '@classytic/arc';
import type { IRequestContext, IControllerResponse } from '@classytic/arc';

// Full surface: CRUD + SoftDelete + Tree + Slug + Bulk
class ProductController extends BaseController<Product> {
  constructor() { super(productRepo); }

  async getFeatured(req: IRequestContext): Promise<IControllerResponse<Product[]>> {
    const products = await this.repository.getAll({ filters: { isFeatured: true } });
    return { success: true, data: products };
  }
}
```

**Slim CRUD-only surface** (869 LOC instead of 1,650):

```typescript
import { BaseCrudController } from '@classytic/arc';
class ReportController extends BaseCrudController<Report> {}
```

**Pick specific mixins:**

```typescript
import { BaseCrudController, SoftDeleteMixin, BulkMixin } from '@classytic/arc';
class OrderController extends SoftDeleteMixin(BulkMixin(BaseCrudController)) {}
// → list/get/create/update/delete + getDeleted/restore + bulkCreate/bulkUpdate/bulkDelete
```

**Mixin surface:** `SoftDeleteMixin` (`getDeleted`, `restore`) · `TreeMixin` (`getTree`, `getChildren`) · `SlugMixin` (`getBySlug`) · `BulkMixin` (`bulkCreate`, `bulkUpdate`, `bulkDelete`). Each exported from `@classytic/arc` and `@classytic/arc/core`.

**Shared helpers** (protected on `BaseCrudController` so mixins can extend): `meta(req)`, `getHooks(req)`, `tenantRepoOptions(req)`, `resolveRepoId(id, existing)`, `notFoundResponse(reason)`, `resolveCacheConfig(op)`, `cacheScope(req)`.

**IRequestContext:** `{ params, query, body, user, headers, context, metadata, server }` — `user` is `Record<string, unknown> | undefined` (guard with `if (req.user)` on public routes)

**IControllerResponse:** `{ success, data?, error?, status?, meta?, headers? }`

## Adapters (Database-Agnostic)

```typescript
// Mongoose — canonical arc factory
import { createMongooseAdapter } from '@classytic/arc';
import { buildCrudSchemasFromModel } from '@classytic/mongokit';

const adapter = createMongooseAdapter({
  model: ProductModel,
  repository: productRepo,
  schemaGenerator: buildCrudSchemasFromModel,   // ← no cast; RouteSchemaOptions extends SchemaBuilderOptions
});

// Custom adapter — implement MinimalRepo from @classytic/repo-core/repository:
import type { MinimalRepo } from '@classytic/repo-core/repository';
// MinimalRepo<TDoc> = five-method floor (getAll, getById, create, update, delete)
// StandardRepo<TDoc> = MinimalRepo + optional batch ops, CAS, soft-delete, etc.
// Arc feature-detects optional methods at call sites.
```

- `createMongooseAdapter` is the **canonical arc export**. Use directly — no cast on `schemaGenerator` (arc's `RouteSchemaOptions extends SchemaBuilderOptions`; `ArcFieldRule extends FieldRule`).
- `createAdapter` is a **CLI-scaffolded host wrapper** (`src/lib/adapter.ts`). Keep for scaffolded apps; hand-built apps should import `createMongooseAdapter` directly.
- Built-in mongoose fallback detects `{ default: null }` on schema paths and widens the emitted JSON-Schema type automatically — no `fieldRules` entry needed for that case.

## Events

The factory auto-registers `eventPlugin` — no manual setup needed:

```typescript
// createApp() registers eventPlugin automatically (default: MemoryEventTransport)
const app = await createApp({
  stores: { events: new RedisEventTransport(redis) },  // optional, defaults to memory
  arcPlugins: {
    events: {                     // event plugin config (default: true, false to disable)
      logEvents: true,
      retry: { maxRetries: 3, backoffMs: 1000 },
    },
  },
});

await app.events.publish('order.created', { orderId: '123' });
await app.events.subscribe('order.*', async (event) => { ... });
```

CRUD events auto-emit: `{resource}.created`, `{resource}.updated`, `{resource}.deleted`.

**Transports:** Memory (default) | Redis Pub/Sub (fire-and-forget) | Redis Streams (durable, at-least-once, consumer groups, DLQ)

**Event Outbox** — at-least-once delivery via transactional outbox pattern. Pass `repository: RepositoryLike` (mongokit / prismakit / custom) for production, or `store: MemoryOutboxStore()` for dev. Arc adapts the repo to the `OutboxStore` contract internally — `create` / `findAll` / `deleteMany` / `findOneAndUpdate` cover save, claim, ack, fail, DLQ.

**Event contract (v2.9):** `EventMeta` = `id`, `timestamp`, optional `schemaVersion`, `correlationId`, `causationId`, `partitionKey`, `source`, `idempotencyKey`, `resource`, `resourceId`, `userId`, `organizationId`, `aggregate: { type, id }`. `createChildEvent(parent, ...)` inherits correlation/causation/source/idempotencyKey; aggregate stays explicit. `DeadLetteredEvent<T>` + optional `transport.deadLetter()` for typed DLQ. `withRetry({ transport })` auto-routes exhausted events — no custom plumbing for Kafka/SQS. `@classytic/primitives` mirrors these shapes — arc is source of truth.

**Outbox (v2.9):** `EventOutbox.store()` auto-maps `meta.idempotencyKey` → `dedupeKey`. `new EventOutbox({ failurePolicy: ({ attempts }) => ({ retryAt, deadLetter }) })` centralises retry/DLQ. `outbox.getDeadLettered(limit)` returns typed `DeadLetteredEvent[]`. `RelayResult.deadLettered` for per-batch DLQ count. Durable store: `new EventOutbox({ repository: new Repository(OutboxModel), transport })` (v2.9.1) — multi-worker claim, session-threaded writes, and dedupe semantics come from the repo's backing kit.

## Factory — createApp()

```typescript
const app = await createApp({
  preset: 'production',            // production | development | testing | edge
  runtime: 'memory',              // memory (default) | distributed
  auth: { type: 'jwt', jwt: { secret } },
  cors: { origin: ['https://myapp.com'] },
  helmet: true,                    // false to disable
  rateLimit: { max: 100 },         // false to disable
  ajv: { keywords: ['x-internal'] }, // custom AJV keywords for schema validation
  arcPlugins: {
    events: true,                  // event plugin (default: true, false to disable)
    emitEvents: true,              // CRUD event emission (default: true)
    queryCache: true,              // server cache (default: false)
    sse: true,                     // SSE streaming (default: false)
    caching: true,                 // ETag + Cache-Control (default: false)
  },
  stores: {                        // required when runtime: 'distributed'
    events: new RedisEventTransport({ client: redis }),
    queryCache: new RedisCacheStore({ client: redis }),
  },
});
```

## Hooks

**Inline on resource (recommended):**

```typescript
defineResource({
  name: 'chat',
  hooks: {
    beforeCreate: async (ctx) => { ctx.data.slug = slugify(ctx.data.name); },
    afterCreate: async (ctx) => { analytics.track('created', { id: ctx.data._id, user: ctx.user?.id }); },
    beforeUpdate: async (ctx) => { console.log('Updating', ctx.meta?.id, 'existing:', ctx.meta?.existing); },
    afterUpdate: async (ctx) => { await invalidateCache(ctx.data._id); },
    beforeDelete: async (ctx) => { if (ctx.data.isProtected) throw new Error('Cannot delete'); },
    afterDelete: async (ctx) => { await cleanupFiles(ctx.meta?.id); },
  },
});
```

`ResourceHookContext`: `{ data, user?, meta? }` — `data` is the document, `meta` has `id` and `existing` (for update/delete).

**App-level (cross-resource):**

```typescript
import { createHookSystem, beforeCreate, afterUpdate } from '@classytic/arc/hooks';

const hooks = createHookSystem();
beforeCreate(hooks, 'product', async (ctx) => { ctx.data.slug = slugify(ctx.data.name); });
afterUpdate(hooks, 'product', async (ctx) => { await invalidateCache(ctx.result._id); });
```

## Pipeline

```typescript
import { guard, transform, intercept } from '@classytic/arc/pipeline';

defineResource({
  pipe: {
    create: [
      guard('verified', async (ctx) => ctx.user?.verified === true),
      transform('inject', async (ctx) => { ctx.body.createdBy = ctx.user._id; }),
    ],
  },
});
```

## Query Parsing

Arc's default parser handles filters, sort, select, populate, and pagination. Swap in MongoKit's `QueryParser` for $lookup joins.

```
GET /products?page=2&limit=20&sort=-createdAt&select=name,price
GET /products?price[gte]=100&status[in]=active,featured&search=keyword
GET /products?after=<cursor_id>&limit=20                     # keyset pagination
GET /products?populate=category                               # ref-based populate
GET /products?populate[category][select]=name,slug            # populate with field select
GET /products?populate[category][select]=-internal            # exclude fields
GET /products?populate[category][match][isActive]=true        # populate with filter
```

**Lookup/join (no refs — $lookup via MongoKit QueryParser):**

```
GET /products?lookup[cat][from]=categories&lookup[cat][localField]=categorySlug&lookup[cat][foreignField]=slug&lookup[cat][single]=true
GET /products?lookup[cat][from]=categories&...&lookup[cat][select]=name,slug
```

Operators: `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `in`, `nin`, `like`, `regex`, `exists`

**Custom query parser (e.g., MongoKit >=3.4.5 for $lookup, whitelists, MCP auto-derive):**

```typescript
import { QueryParser } from '@classytic/mongokit';

defineResource({
  name: 'product',
  adapter: createMongooseAdapter({ model: ProductModel, repository: productRepo }),
  queryParser: new QueryParser({
    allowedFilterFields: ['status', 'category', 'orgId'],  // whitelist filter fields
    allowedSortFields: ['createdAt', 'price'],              // whitelist sort fields
    allowedOperators: ['eq', 'gte', 'lte', 'in'],          // whitelist operators
  }),
  // MCP auto-derives filterableFields from queryParser — no duplication needed
  schemaOptions: {
    query: {
      allowedPopulate: ['category', 'brand'],
      allowedLookups: ['categories', 'brands'],
    },
  },
});
```

## Error Classes

```typescript
import { ArcError, NotFoundError, ValidationError, createDomainError } from '@classytic/arc';
throw new NotFoundError('Product not found');                      // 404
throw createDomainError('MEMBER_NOT_FOUND', 'Not found', 404);    // domain error with code
throw createDomainError('SELF_REFERRAL', 'Cannot self-refer', 422, { field: 'referralCode' });
```

Error handler catches: `ArcError` → `.statusCode` (Fastify) → `.status` (MongoKit, http-errors) → `errorMap` → Mongoose/MongoDB → fallback 500. DB-agnostic — any error with `.status` or `.statusCode` gets the correct HTTP response.

## Compensating Transaction

In-process rollback for multi-step operations. Not a distributed saga — use Temporal/Streamline for that.

```typescript
import { withCompensation } from '@classytic/arc/utils';

const result = await withCompensation('checkout', [
  { name: 'reserve', execute: reserveStock, compensate: releaseStock },
  { name: 'charge', execute: chargeCard, compensate: refundCard },
  { name: 'notify', execute: sendEmail, fireAndForget: true },  // non-blocking
], { orderId }, {
  onStepComplete: (name, res) => fastify.events.publish(`checkout.${name}.done`, res),
});
// result: { success, completedSteps, results, failedStep?, error?, compensationErrors? }
```

## Testing

Three entry points — pick by what you're testing. Full details in [references/testing.md](references/testing.md).

```typescript
import {
  createTestApp,                 // turnkey Fastify + in-memory Mongo + auth + fixtures
  createHttpTestHarness,         // auto-generates ~16 CRUD/permission/validation tests
  expectArc,                     // fluent envelope matchers
  createTestFixtures,            // DB-agnostic seeding with per-record destroyers
} from '@classytic/arc/testing';

const ctx = await createTestApp({
  resources: [productResource],
  authMode: 'jwt',                    // 'jwt' | 'better-auth' | 'none'
  db: 'in-memory',                    // default
  connectMongoose: true,              // one-liner for Mongoose-backed resources
});
ctx.auth.register('admin', { user: { id: '1', roles: ['admin'] }, orgId: 'org-1' });

const res = await ctx.app.inject({
  method: 'POST', url: '/products',
  headers: ctx.auth.as('admin').headers,
  payload: { name: 'Widget' },
});
expectArc(res).ok().hidesField('password');
```

`TestAppContext` = `{ app, auth, fixtures, dbUri, close }`. `authMode: 'better-auth'` requires the caller to also pass `auth: { type: 'better-auth', ... }`.

## CLI

```bash
arc init my-api --mongokit --better-auth --ts
arc generate resource product              # standard resource
arc generate resource product --mcp        # resource + MCP tools file
arc generate mcp analytics                 # standalone MCP tools file
arc docs ./openapi.json --entry ./dist/index.js
arc introspect --entry ./dist/index.js
arc doctor
```

Set `"mcp": true` in `.arcrc` to always generate `.mcp.ts` files with resources.

## MCP (AI Agent Tools)

Expose Arc resources as MCP tools for AI agents. Stateless by default — fresh server per request, zero session overhead.

See [mcp reference](references/mcp.md) for full details.

```typescript
import { mcpPlugin } from '@classytic/arc/mcp';

// Stateless (default) — production-ready, scalable
await app.register(mcpPlugin, {
  resources: [productResource, orderResource],
  auth: false,                              // or: getAuth() | custom function
  exclude: ['credential'],
  overrides: { product: { operations: ['list', 'get'] } },
});

// Stateful — when you need server-initiated messages
await app.register(mcpPlugin, { resources, stateful: true, sessionTtlMs: 600000 });
```

Connect Claude CLI: `claude mcp add --transport http my-api http://localhost:3000/mcp`

**Auth** — three modes, user chooses: `false` | `getAuth()` (Better Auth OAuth 2.1) | custom function:

```typescript
// Human user auth
auth: async (headers) => {
  if (headers['x-api-key'] !== process.env.MCP_KEY) return null;
  return { userId: 'bot', organizationId: 'org-1', roles: ['admin'] };
},

// Service account / machine-to-machine (produces kind: "service" scope)
auth: async (headers) => ({
  clientId: 'ingestion-pipeline',
  organizationId: 'org-1',
  scopes: ['read:products', 'write:events'],
}),
```

`auth: false` → `ctx.user` is `null`, `scope.kind` is `"public"`. Permission guards like `!!ctx.user` correctly block anonymous callers.

**Guards** for custom tools: `guard(requireAuth, requireOrg, requireRole('admin'), handler)`

**AI SDK bridge** (v2.8.4+) — expose AI SDK `tool()` definitions over MCP without duplicating glue. Handles auth, guards, `{ error } → isError` translation, and thrown-error mapping:

```typescript
import { bridgeToMcp, buildMcpToolsFromBridges, getUserId, hasOrg, type McpBridge } from '@classytic/arc/mcp';

export const triggerJobBridge: McpBridge = {
  name: 'trigger_job',
  description: 'Start a job.',
  inputSchema: { phase: z.enum(['investigate', 'fix']) },
  annotations: { destructiveHint: true },
  buildTool: (ctx) => buildTriggerJobTool(getUserId(ctx) ?? ''),
  guard: (ctx) => (hasOrg(ctx) ? null : 'Organization scope required'),
};

await app.register(mcpPlugin, {
  resources,
  extraTools: buildMcpToolsFromBridges([triggerJobBridge], {
    exclude: process.env.DEPLOYMENT === 'readonly' ? ['trigger_job'] : [],
  }),
});
```

**Service scope**: When `clientId` is set in auth result, MCP produces `kind: "service"` RequestScope — works with `requireServiceScope()`, `getClientId()`, `getServiceScopes()`. No synthetic userId needed for machine principals.

**Multi-tenancy**: `organizationId` from auth flows into BaseController org-scoping automatically.

**Permission filters**: `PermissionResult.filters` from resource permissions flow into MCP tools — same as REST. Define once, works everywhere:

```typescript
permissions: {
  list: (ctx) => ({
    granted: !!ctx.user,
    filters: { orgId: ctx.user?.orgId, branchId: ctx.user?.branchId },
  }),
}
// MCP tools automatically scope queries by orgId + branchId
```

**Project structure** — custom MCP tools co-located with resources:

```
src/resources/order/
  order.resource.ts
  order.mcp.ts              ← defineTool('fulfill_order', { ... })
```

Generate: `arc generate resource order --mcp` | Wire: `extraTools: [fulfillOrderTool]`

**Auto-load resources** — no barrel files, no manual `toPlugin()`:

```typescript
import { createApp, loadResources } from '@classytic/arc/factory';

const app = await createApp({
  resourcePrefix: '/api/v1',                            // optional URL prefix
  resources: await loadResources(import.meta.url),      // discovers *.resource.ts
  auth: { type: 'jwt', jwt: { secret: process.env.JWT_SECRET } },
});
```

`loadResources()` discovers files matching `*.resource.{ts,js,mts,mjs}`, recursively. Pass `import.meta.url` for dev/prod parity (resolves to `src/` in dev, `dist/` in prod automatically). Discovers `default` export, `export const resource`, OR any named export with `toPlugin()` (e.g., `export const userResource`).

Options: `exclude`, `include`, `suffix`, `recursive`, `silent`.

**Per-resource opt-out of `resourcePrefix`** — for webhooks, admin routes:
```typescript
defineResource({ name: 'webhook', prefix: '/hooks', skipGlobalPrefix: true })
// Registers at /hooks even with createApp({ resourcePrefix: '/api/v1' })
```

**Boot sequence:**
```typescript
const app = await createApp({
  resourcePrefix: '/api/v1',
  plugins: async (f) => { await connectDB(); },     // 1. infra (DB, docs)
  bootstrap: [inventoryInit, accountingInit],        // 2. domain init (engines)
  resources: await loadResources(import.meta.url),   // 3. routes
  afterResources: async (f) => { subscribeEvents(f); }, // 4. post-wiring
  onReady: async (f) => { logger.info('ready'); },   // 5. lifecycle
});
```

**Audit per-resource opt-in** — no growing exclude lists:
```typescript
// Register audit plugin with perResource mode
await fastify.register(auditPlugin, { autoAudit: { perResource: true } });

// Opt-in at the resource level
defineResource({ name: 'order', audit: true });
defineResource({ name: 'payment', audit: { operations: ['delete'] } });
defineResource({ name: 'product' }); // not audited

// Manual custom() for MCP tools / custom routes / read auditing
app.post('/orders/:id/refund', async (req) => {
  await app.audit.custom('order', req.params.id, 'refund', { reason }, { user });
});
```

**Import compatibility:** `loadResources()` uses runtime `import()`. Works with relative imports (`./foo.js`) and Node.js `#` subpath imports (`#shared/utils.js` via `package.json` `imports`). Does **NOT** work with tsconfig path aliases (`@/*`, `~/`) — those are compile-time only.

**Vitest workaround** (rare): if resources need engine bootstrap or transitive `node_modules` imports that don't compose with dynamic import:
```typescript
import { preloadResources } from '@classytic/arc/testing';

export const preloadedResources = preloadResources(
  import.meta.glob('../../src/resources/**/*.resource.ts', { eager: true, import: 'default' }),
);
```

**Unified role check** — checks both platform AND org roles:

```typescript
import { roles } from '@classytic/arc/permissions';
permissions: {
  create: roles('admin', 'editor'),  // works with BA org roles + platform roles
  delete: roles('admin'),
}
// Also: requireRoles(['admin'], { includeOrgRoles: true }) for backward compat
```

**DX helpers:**

```typescript
// Typed request for raw routes — no more (req as any).user
import type { ArcRequest } from '@classytic/arc';
handler: async (req: ArcRequest, reply) => { req.user?.id; req.scope; req.signal; }

// Response envelope — no manual { success, data } wrapping
import { envelope } from '@classytic/arc';
reply.send(envelope(data, { total: 100 }));

// Canonical org extraction — replaces 19 duplicated patterns
import { getOrgContext } from '@classytic/arc/scope';
const { userId, organizationId, roles, orgRoles } = getOrgContext(request);

// Domain errors with auto HTTP status mapping
import { createDomainError } from '@classytic/arc';
throw createDomainError('SELF_REFERRAL', 'Cannot refer yourself', 422);

// Custom routes — always `routes: [...]` with optional `raw: true` for non-JSON
defineResource({
  routes: [{ method: 'GET', path: '/stats', handler: 'getStats', permissions: allowPublic() }],
});

// SSE auth — preAuth runs BEFORE auth middleware (EventSource can't set headers)
routes: [{ preAuth: [(req) => { req.headers.authorization = `Bearer ${req.query.token}`; }] }]

// SSE streaming — raw: true + stream the response
routes: [{ method: 'GET', path: '/stream', raw: true, handler: async (req, reply) => reply.send(stream) }]
```

## DX Helpers (v2.7.3+)

**Reply helpers** — consistent response envelopes (opt-in via `createApp({ replyHelpers: true })`):

```typescript
return reply.ok({ name: 'MacBook' });              // → 200 { success: true, data: {...} }
return reply.ok(product, 201);                      // → 201 { success: true, data: {...} }
return reply.fail('Not found', 404);                // → 404 { success: false, error: '...' }
return reply.fail(['err1', 'err2'], 422);           // → 422 { success: false, errors: [...] }
return reply.paginated({ docs, total, page, limit });
return reply.stream(csvReadable, { contentType: 'text/csv', filename: 'export.csv' });
```

**Error mappers** — class-based domain error → HTTP response (in `errorHandler` options):

```typescript
const app = await createApp({
  errorHandler: {
    errorMappers: [{
      type: AccountingError,
      toResponse: (err) => ({ status: err.status, code: err.code, message: err.message }),
    }],
  },
});
// Handlers just throw — Arc catches and maps automatically
```

**BigInt serialization** — opt-in via `createApp({ serializeBigInt: true })`. Converts BigInt → Number in all JSON responses.

**Multipart body middleware** — opt-in file upload for CRUD routes:

```typescript
import { multipartBody } from '@classytic/arc/middleware';

defineResource({
  name: 'product',
  adapter,
  middlewares: { create: [multipartBody({ allowedMimeTypes: ['image/png', 'image/jpeg'], maxFileSize: 5 * 1024 * 1024 })] },
  hooks: {
    'before:create': async (data) => {
      if (data._files?.image) { data.imageUrl = await uploadToS3(data._files.image); delete data._files; }
      return data;
    },
  },
});
```

`multipartBody()` is a no-op for JSON requests — safe to always add.

## Subpath Imports

```typescript
import { defineResource, BaseController, allowPublic } from '@classytic/arc';
import { createApp } from '@classytic/arc/factory';
import { MemoryCacheStore, RedisCacheStore, QueryCache } from '@classytic/arc/cache';
import { createBetterAuthAdapter, extractBetterAuthOpenApi } from '@classytic/arc/auth';
// Optional Mongoose stub-models bridge for `populate()` against Better Auth
// collections — subpath gate keeps Mongoose out of Prisma/Drizzle/Kysely bundles.
import { registerBetterAuthMongooseModels } from '@classytic/arc/auth/mongoose';
import type { ExternalOpenApiPaths } from '@classytic/arc/docs';
import { eventPlugin } from '@classytic/arc/events';
import { RedisEventTransport } from '@classytic/arc/events/redis';
import { healthPlugin, gracefulShutdownPlugin } from '@classytic/arc/plugins';
import { tracingPlugin } from '@classytic/arc/plugins/tracing';
import { auditPlugin } from '@classytic/arc/audit';
import { idempotencyPlugin } from '@classytic/arc/idempotency';
import { ssePlugin } from '@classytic/arc/plugins';
import { jobsPlugin } from '@classytic/arc/integrations/jobs';
import { websocketPlugin } from '@classytic/arc/integrations/websocket';
import { eventGatewayPlugin } from '@classytic/arc/integrations/event-gateway';
import { createHookSystem } from '@classytic/arc/hooks';
import { createTestApp } from '@classytic/arc/testing';
import { Type, ArcListResponse } from '@classytic/arc/schemas';
import { createStateMachine, CircuitBreaker, withCompensation, defineCompensation } from '@classytic/arc/utils';
import { defineMigration } from '@classytic/arc/migrations';
// Scope accessors
import {
  // Type guards
  isMember, isService, isElevated, isAuthenticated, hasOrgAccess,
  // Identity / org accessors
  getUserId, getUserRoles, getOrgId, getOrgRoles, getTeamId, getClientId,
  // Service scopes (OAuth-style strings on API keys)
  getServiceScopes,
  // App-defined scope dimensions (branch, project, region, …)
  getScopeContext, getScopeContextMap,
  // Parent-child org hierarchy
  getAncestorOrgIds, isOrgInScope,
  // Generic request-side helper
  getRequestScope,
} from '@classytic/arc/scope';
import { createTenantKeyGenerator } from '@classytic/arc/scope';
import { createRoleHierarchy } from '@classytic/arc/permissions';
import { metricsPlugin, versioningPlugin } from '@classytic/arc/plugins';
import { webhookPlugin } from '@classytic/arc/integrations/webhooks';
import { mcpPlugin, createMcpServer, defineTool, definePrompt, fieldRulesToZod, resourceToTools } from '@classytic/arc/mcp';
import { EventOutbox, MemoryOutboxStore } from '@classytic/arc/events';
import { bulkPreset, multiTenantPreset, type TenantFieldSpec } from '@classytic/arc/presets';
```

## References (Progressive Disclosure)

- **[auth](references/auth.md)** — JWT, Better Auth, API key auth, custom auth, multi-tenant
- **[events](references/events.md)** — Domain events, transports, retry, outbox pattern, auto-emission
- **[integrations](references/integrations.md)** — BullMQ jobs, WebSocket, EventGateway, Streamline, Webhooks
- **[mcp](references/mcp.md)** — MCP tools for AI agents, auto-generation from resources, custom tools, Better Auth OAuth 2.1
- **[multi-tenancy](references/multi-tenancy.md)** — Scope ladder, `tenantField` read sites, `PermissionResult.scope`, API key auth without a separate auth plugin
- **[production](references/production.md)** — Health, audit, idempotency, tracing, metrics, versioning, SSE, QueryCache, bulk ops, saga, RPC schema versioning, tenant rate limiting
- **[testing](references/testing.md)** — Test app, mocks, data factories, in-memory MongoDB
