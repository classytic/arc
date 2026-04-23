# CLAUDE.md — @classytic/arc Quick Reference

> **Full guide:** See [@file AGENTS.md](AGENTS.md) for architecture details, gotchas, test mapping, patterns, and security checklist.
> **v3 plans:** See [@file v3.md](v3.md) for design notes and migration path.
> **Wiki:** [@file wiki/index.md](wiki/index.md) — concept pages. Load specific pages on demand instead of re-reading `src/` or `AGENTS.md`. After any change that invalidates a page: edit it, update `wiki/index.md` if adding/renaming, append one line to `wiki/log.md` (`YYYY-MM-DD — <page> — <change>`). Keep pages tight; link with `[[page-name]]` instead of duplicating.

## Identity

**@classytic/arc** — Resource-oriented backend framework on Fastify.
One `defineResource()` → REST API + auth + permissions + events + caching + OpenAPI + MCP.

**v2.10** | Node.js 22+ | TypeScript 6+ | ESM-only | Fastify 5+ | ~290 test files

## Commands

```bash
npx tsc --noEmit                                  # Typecheck
npx biome check src/ --diagnostic-level=error      # Lint (Biome only, no ESLint)
npm run test:main                                  # Main test suite (excludes perf)
npm run test:perf                                  # Isolated perf/leak suite (--expose-gc)
npm run test:ci                                    # Main suite + perf suite
npx vitest run tests/core/base-controller.test.ts  # Targeted test
npx knip                                           # Dead code detection
npm run build                                      # tsdown → dist/
npm run smoke                                      # Verify CLI + imports
```

## Rules (non-negotiable)

- **No `console.log`** in `src/` (except `cli/`) — use logger injection
- **No mongoose/prisma imports** in core — only in adapter files
- **No `any`** — use `unknown` (intentional for type safety)
- **No `@ts-ignore`** — fix the type
- **No default exports** — named exports only
- **No bundling peer deps** — check `tsdown.config.ts` neverBundle
- **No enums** — `as const` objects or string literal unions
- **No ESLint/Prettier** — Biome only
- **Prefer Node.js built-ins** — `node:crypto`, `structuredClone()`, `URL` over third-party

## Type Conventions

- `request.user: Record<string, unknown> | undefined` (required property, NOT optional `?:`)
- `RequestScope`: discriminated union on `kind` — use `getUserId(scope)` / `getUserRoles(scope)`
- `RepositoryLike` returns `Promise<unknown>` — intentional minimum contract
- `BaseController<TDoc = AnyRecord>` — `TDoc` inferred from Model, `unknown` default forces narrowing
- `EventMeta` (v2.9): `id`, `timestamp`, `schemaVersion?`, `correlationId?`, `causationId?`, `partitionKey?`, `source?`, `idempotencyKey?`, `resource?`, `resourceId?`, `userId?`, `organizationId?`, `aggregate?: { type: string; id: string }` — arc is source of truth; `@classytic/primitives` mirrors it. Domain packages narrow `aggregate.type` to a closed union via interface extension. `aggregate` is NOT inherited by `createChildEvent`; `source` + `idempotencyKey` ARE.
- Outbox (v2.9): `EventOutbox.store()` auto-maps `meta.idempotencyKey` → `OutboxWriteOptions.dedupeKey`. `failurePolicy({ event, error, attempts }) => { retryAt?, deadLetter? }` centralises retry/DLQ. `store.getDeadLettered?(limit)` returns `DeadLetteredEvent[]`. `RelayResult.deadLettered` counts per batch. Durable store (v2.9.1): `new EventOutbox({ repository, transport })` — arc adapts any `RepositoryLike` (mongokit/prismakit/custom) to the outbox contract internally; same pattern for `auditPlugin({ repository })` and `idempotencyPlugin({ repository })`.
- Permissions (v2.10): `permissions/` split into `core.ts` (auth/role/ownership + `allOf`/`anyOf`/`not`/`when`/`denyAll`), `scope.ts` (org/service/team/scope-context), `dynamic.ts` (matrices). New `not(check, reason?)` combinator inverts a check. Public import path `@classytic/arc/permissions` unchanged.

## Test Mapping (run the right tests)

| Changed | Run |
|---------|-----|
| `src/core/*` | `npx vitest run tests/core/` |
| `src/auth/*` | `npx vitest run tests/auth/` |
| `src/permissions/*` | `npx vitest run tests/permissions/ tests/e2e/rbac-permissions.test.ts` |
| `src/scope/*` | `npx vitest run tests/scope/ tests/e2e/elevation-plugin.test.ts` |
| `src/hooks/*` | `npx vitest run tests/hooks/` |
| `src/events/*` | `npx vitest run tests/events/` |
| `src/cache/*` | `npx vitest run tests/cache/` |
| `src/plugins/*` | `npx vitest run tests/plugins/` |
| `src/presets/*` | `npx vitest run tests/presets/` |
| `src/integrations/mcp/*` | `npx vitest run tests/integrations/mcp/` |
| `src/factory/*` | `npx vitest run tests/factory/ tests/e2e/full-app.test.ts` |
| `src/docs/*` | `npx vitest run tests/docs/` |
| `src/cli/*` | `npx vitest run tests/cli/` |
| `src/utils/*` | `npx vitest run tests/utils/` |
| `src/org/*` | `npx vitest run tests/e2e/org-scope-plugin.test.ts` |
| `src/pipeline/*` | `npx vitest run tests/pipeline/` |
| `src/middleware/*` | `npx vitest run tests/middleware/` |
| `src/migrations/*` | `npx vitest run tests/migrations/` |
| `src/schemas/*` | `npx vitest run tests/schemas/` |
| `src/logger/*` | `npx vitest run tests/logger/` |
| `src/discovery/*` | `npx vitest run tests/discovery/` |
| `src/utils/queryParser*` | `npx vitest run tests/utils/ tests/property/` |
| `src/auth/authPlugin*` | `npx vitest run tests/auth/ tests/property/jwt-bearer*` |

**Never run the full suite during dev** — use targeted tests. `test:ci` is for release/CI; perf tests run separately on purpose to avoid GC-noise flakes.

## Architecture (29 modules)

```
src/
  core/          — defineResource, BaseCrudController + 4 mixins (v2.11 split) → composed BaseController, QueryResolver, createCrudRouter, routes + actions
  factory/       — createApp (main entry point)
  adapters/      — RepositoryLike interface + mongoose/prisma adapters
  auth/          — JWT, Better Auth, sessions
  permissions/   — core (auth/roles/ownership + combinators), scope (org/service/team), dynamic (matrices), fields, presets, roleHierarchy
  scope/         — RequestScope discriminated union
  events/        — EventPlugin, transports (memory, redis pub/sub, redis streams)
  hooks/         — HookSystem, before/after lifecycle
  cache/         — QueryCache, stores, SWR
  plugins/       — health, tracing, requestId, response-cache, versioning, rate-limit, metrics, SSE
  integrations/  — jobs (BullMQ), websocket, SSE, MCP (stateless/stateful, service scope), webhooks
  migrations/    — MigrationRunner + MigrationStore (DB-agnostic)
  cli/           — init, generate, doctor, describe, introspect, docs
  testing/       — HttpTestHarness, mocks, auth helpers
  docs/          — OpenAPI, Scalar UI
  utils/         — queryParser, stateMachine, compensate, retry, circuitBreaker
  types/         — shared types, Fastify declaration merges
  schemas/       — JSON Schema from field rules
  pipeline/      — guard, pipe, intercept, transform
  middleware/    — request-level middleware, multipartBody (file upload for CRUD)
  org/           — organization plugin, membership
  audit/         — audit trail plugin + stores
  idempotency/   — idempotency plugin + stores
  context/       — async request context
  registry/      — resource registry, introspection
  discovery/     — auto-discovery + filesystem resource loader (also factory/loadResources)
  logger/        — injectable logger interface
  presets/       — bulk, softDelete, ownedByUser, slugLookup, tree, multiTenant, audited, search, files-upload
```

## Gotchas

1. `request.user` is `undefined` on public routes — always guard
2. `isRevoked` is fail-closed — errors = access denied (by design)
3. Redis Streams are at-least-once — handlers must be idempotent
4. `select` is never normalized to string — preserved as-is for DB agnosticism
5. Type-only subpaths (`./org/types`) produce `export {}` at runtime — correct
6. MCP `auth: false` → `ctx.user` is `null` (not `"anonymous"`) — guards work correctly
7. Event WAL skips `arc.*` internal events — prevents startup timeout with durable stores
8. `multipartBody()` is a no-op for JSON requests — safe to always add to create/update middlewares
9. Event publishing is fire-and-forget (`failOpen: true`) — use outbox for guaranteed delivery
10. Presets compose but order matters — test combinations
11. **Field-write perms default to `reject` (403)** — opt into silent `strip` via `onFieldWriteDenied: 'strip'`
12. **Elevation always emits `arc.scope.elevated`** — apps that want audit can subscribe; `onElevation` callback still works
13. **multiTenant injects org on UPDATE too** (v2.9) — body-supplied `organizationId` is overwritten with caller's scope
14. `verifySignature(body, ...)` throws `TypeError` if body isn't string/Buffer — pass `req.rawBody`, not parsed body
15. **Plugins set response headers at `onRequest` or `preSerialization`, never `onSend`** (v2.10.2) — async `onSend` races with Fastify's `onSendEnd → safeWriteHead` flush path and produces `ERR_HTTP_HEADERS_SENT` under slow responses. Use `onRequest` when the header is derivable from the request (requestId, versioning), `preSerialization` when the payload is needed (caching, response-cache, idempotency). `isReplyCommitted()` in [src/utils/reply-guards.ts](src/utils/reply-guards.ts) remains for third-party plugin authors; arc's own plugins no longer use it.
16. **Four new subpaths in v2.10.8** — `@classytic/arc/middleware` (`multipartBody`, `ParsedFile`, `middleware`, `sortMiddlewares`), `@classytic/arc/pipeline` (`guard`, `intercept`, `pipe`, `transform`, `executePipeline`, `NextFunction`), `@classytic/arc/context` (`requestContext`), `@classytic/arc/logger` (`arcLog`, `configureArcLogger`). These symbols are **no longer** re-exported from the root `@classytic/arc` — import from the subpath. The root-barrel shortcut was pulling module graphs into every consumer; removing it restores the "root = essentials only" policy already stated in [src/index.ts](src/index.ts).
17. **BaseController threads tenant into repo options (v2.10.8)** — every CRUD call (`create`, `update`, `delete`, `getAll`, `getById`/`getOne` via `fetchDetailed`) spreads `{ [tenantField]: orgId }` at the TOP of the options object. Plugin-scoped repos (mongokit's `multiTenantPlugin`) read `context.organizationId` directly — not `context.data.organizationId`. Multi-field tenancy via `multiTenantPreset` stashes resolved fields on `request._tenantFields`, which the helper merges too. See [src/core/BaseController.ts](src/core/BaseController.ts) `tenantRepoOptions()`.
18. **Actions with no permission now fail-closed (v2.10.8)** — `actions: { send: async (...) => ... }` shorthand used to silently become auth-only. Now the fallback chain is: per-action `permissions` → resource-level `actionPermissions` → `permissions.update` (with a warn) → boot-time throw. Public actions must opt in via `allowPublic()` explicitly.
19. **`FastifyInstance.arc` is optional in v2.10.8** — the declare-module merge now types `arc?: ArcCore`. Apps that never register `arcCorePlugin` get correct "possibly undefined" types; apps that do can still use `fastify.arc!` or narrow. Fixes host `interface X extends FastifyInstance { arc?: MyArc }` collisions.
20. **AccessControl is dialect-agnostic (v2.10.8)** — the 200-LOC Mongo-syntax fallback matcher was removed. Policy-filter evaluation now delegates to `DataAdapter.matchesFilter`; if none is supplied, arc falls back to `simpleEqualityMatcher` (exported from `@classytic/arc/utils`) which handles flat key-equality and fail-closes on operator-shaped values. Mongokit / sqlitekit users are unaffected — the compound-filter path evaluates at the DB layer. Custom minimal adapters should either supply `matchesFilter` or ensure their `getOne(compoundFilter)` applies filters natively.
21. **`tenantField` gets auto-injected `systemManaged: true` + `preserveForElevated: true` (v2.10.8)** — `defineResource` stamps both rules on `schemaOptions.fieldRules[tenantField]` unless the host overrides. `BodySanitizer` honors `preserveForElevated` to let elevated admins pick a target org via the request body; member/service callers still have the field stripped.
22. **`ListResult<TDoc>` honors repo-core's three `getAll` shapes (v2.10.8)** — `BaseController.list`, `executeListQuery`, and `IController.list` return `OffsetPaginationResult<TDoc> | KeysetPaginationResult<TDoc> | TDoc[]`. Previously arc narrowed to offset-only and called bare arrays "non-conforming" — directly contradicting repo-core's published contract. Consumers narrow on shape.
23. **Dev preset `rateLimit: false` (v2.10.8 behavior change)** — the `development` preset no longer applies `{ max: 1000, timeWindow: '1 minute' }`. HMR / test-runner / auth-heartbeat traffic was tripping the limit. Workflows that specifically needed to see 429s locally should either declare an explicit `rateLimit: { ... }` in `createApp` or move to the `testing` preset (also `rateLimit: false`).
24. **Always read `resolvedConfig.X` in `defineResource.ts`, never raw `config.X` (v2.10.8)** — `resolvedConfig` is the post-preset, post-auto-inject canonical copy. Touching raw `config` after line ~187 risks shipping a half-wired feature (2.10.6 had exactly this bug — `config.schemaOptions` was passed to `adapter.generateSchemas()` while `BodySanitizer` correctly read `resolvedConfig.schemaOptions`, so OpenAPI docs and runtime diverged). The tenant field auto-inject now lives in the shared util `autoInjectTenantFieldRules` ([src/core/schemaOptions.ts](src/core/schemaOptions.ts)) so future adapter hook additions can't repeat the mistake.
25. **`config.hooks` handlers get `ctx.scope` + `ctx.context` (v2.10.8)** — inline `hooks: { beforeCreate, afterCreate, … }` handlers receive the lightweight `scope: { organizationId?, userId?, orgRoles? }` projection plus the full `context` for advanced access. No more `resource._pendingHooks.push(...)` workaround to read tenant/user. Projection logic is shared with `IRequestContext.scope` via `buildRequestScopeProjection` ([src/scope/projection.ts](src/scope/projection.ts)) — controllers and hooks read tenant/user the exact same way.
26. **`BaseController` is now a mixin composition (v2.11.0)** — the 1,589-line god class was split into [BaseCrudController.ts](src/core/BaseCrudController.ts) + 4 mixin files under [src/core/mixins/](src/core/mixins/). `class BaseController extends SoftDeleteMixin(TreeMixin(SlugMixin(BulkMixin(BaseCrudController))))` is the natural composition; a companion `interface BaseController<TDoc, TRepo>` is declaration-merged so CRUD + preset methods all thread `TDoc`. Hosts extending `BaseController` keep working; hosts that want slim CRUD extend `BaseCrudController` for a 869-LOC surface, or compose specific mixins. Shared helpers (`meta`, `getHooks`, `tenantRepoOptions`, `resolveRepoId`, `notFoundResponse`, `resolveCacheConfig`, `cacheScope`, `executeListQuery`, `executeGetQuery`) moved `private` → `protected` so mixins can extend cleanly.
27. **`systemManaged` fields stripped from body `required[]` (v2.11.0)** — `stripSystemManagedFromBodyRequired` in [src/core/schemaOptions.ts](src/core/schemaOptions.ts) walks `resolvedConfig.schemaOptions.fieldRules` after adapter schema generation and strips every `systemManaged: true` field from `createBody.required[]` + `updateBody.required[]`. Closes the `@classytic/primitives` engine-default `tenant: { required: true }` conflict where Fastify preValidation rejected `POST /pricelists` with `must have required property 'organizationId'` before `multiTenantPreset`'s inject-from-`x-organization-id` preHandler could run. `multiTenantPreset` now declares `systemManaged: true` fieldRules on every tenant dimension, so hosts using the preset WITHOUT a resource-level `tenantField` are covered automatically — no more per-consumer `createEngine({ tenant: { required: false } })` workaround.
28. **`@classytic/arc/types` is truly type-only (v2.11.0)** — value exports (`AUTHENTICATED_SCOPE`, `PUBLIC_SCOPE`, `isAuthenticated`, `isElevated`, `isMember`, `getOrgId`, `getOrgRoles`, `getTeamId`, `hasOrgAccess`) moved to `@classytic/arc/scope` (where they've always been exported from too). `envelope` moved to `@classytic/arc/utils/envelope`. `getUserId(user: UserLike)` moved to `@classytic/arc/utils/userHelpers` (the scope-flavored `getUserId(scope)` in `/scope/types.ts` is a different helper and stays). Root barrel still re-exports `envelope` + `getUserId` for DX. `/types/base.ts` now has zero runtime emit.
29. **Root barrel explicit exports (v2.11.0)** — `export * from "./constants.js"` replaced with an explicit named re-export list at [src/index.ts](src/index.ts). `validateResourceConfig` / `assertValidConfig` / `formatValidationErrors` relocated from root → `@classytic/arc/utils` (dev tooling, not runtime essentials).
30. **`resourceToTools` split into 4 units (v2.11.0)** — the 850-LOC MCP tool generator is now a 260-LOC orchestrator delegating to focused units: [input-schema.ts](src/integrations/mcp/input-schema.ts), [crud-tools.ts](src/integrations/mcp/crud-tools.ts), [route-tools.ts](src/integrations/mcp/route-tools.ts), [action-tools.ts](src/integrations/mcp/action-tools.ts), with shared helpers in [tool-helpers.ts](src/integrations/mcp/tool-helpers.ts). When editing MCP tool generation, go to the matching file — not `resourceToTools.ts` unless you're changing orchestration.

## Removed in v2.10 (no longer exported)

- `@classytic/arc/policies` — pluggable policy engine; `permissions/` covers every documented use case (RBAC, ownership, tenant filters via `requireOrgInScope`)
- `@classytic/arc/rpc` — inter-service HTTP client; orphaned with no internal users
- `@classytic/arc/dynamic` — `ArcDynamicLoader`; `factory/loadResources` is the only filesystem loader

## Removed from root barrel in v2.10.8 (moved to subpaths)

- `requestContext`, `RequestStore` — `@classytic/arc/context`
- `arcLog`, `configureArcLogger`, `ArcLogger`, `ArcLoggerOptions`, `ArcLogWriter` — `@classytic/arc/logger`
- `middleware`, `sortMiddlewares`, `NamedMiddleware` — `@classytic/arc/middleware` (also now exposes `multipartBody`, `ParsedFile`, `MultipartBodyOptions` which had no public path at all before)
- `guard`, `intercept`, `pipe`, `transform`, `Guard`, `Interceptor`, `PipelineConfig`, `PipelineContext`, `PipelineStep`, `Transform` — `@classytic/arc/pipeline` (also now exposes `executePipeline`, `NextFunction`, `OperationFilter`)

## Removed in v2.9 (no longer exported)

- `createActionRouter` / `buildActionBodySchema` — use `defineResource({ actions: { ... } })`
- `ResourceConfig.onRegister` — use `actions` or resource `hooks`
- `PluginResourceResult.additionalRoutes` — plugins return `routes: RouteDefinition[]` instead

## Peer Deps (never bundle)

| Peer | Min | Required? |
|------|-----|-----------|
| fastify | >=5.0.0 | **Yes** |
| @classytic/mongokit | >=3.10.2 | No |
| @classytic/repo-core | >=0.1.0 | No |
| @classytic/sqlitekit | >=0.1.0 | No |
| mongoose | >=9.0.0 | No |
| better-auth | >=1.6.2 | No |
| ioredis | >=5.0.0 | No |
| bullmq | >=5.0.0 | No |
| @prisma/client | >=5.0.0 | No |

## Files

- [AGENTS.md](AGENTS.md) — Full agent guide (architecture, gotchas, patterns, security)
- [v3.md](v3.md) — v3 design notes
- [knip.config.ts](knip.config.ts) — Dead code detection config
- [biome.json](biome.json) — Lint/format config
- [tsdown.config.ts](tsdown.config.ts) — Build config
- [vitest.config.ts](vitest.config.ts) — Test config
- `skills/arc/` — Claude Code skill definitions
- `docs/` — Nextra documentation site
