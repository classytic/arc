# AGENTS.md — @classytic/arc Agent & Contributor Guide

> Comprehensive context for AI agents, contributors, and maintainers working on Arc.
> For quick reference, see [CLAUDE.md](CLAUDE.md). This file is the deep guide.

---

## 1. Project Identity

**@classytic/arc** is a resource-oriented backend framework built on Fastify. One `defineResource()` call produces a production-ready REST API with auth, permissions, events, caching, OpenAPI docs, and MCP (AI tool) generation.

| Fact | Value |
|------|-------|
| Version | 2.6.0 |
| Runtime | Node.js 22+ (ESM-only) |
| Language | TypeScript 6+ (strict mode) |
| Build | tsdown (not tsc, not esbuild directly) |
| Test | Vitest + mongodb-memory-server |
| Lint | Biome (not ESLint, not Prettier) |
| Dead code | Knip (`knip.config.ts`) |
| Package manager | npm (lockfile committed) |
| Only required peer dep | fastify >=5.0.0 |

### Core Philosophy

1. **Resource-oriented** — everything is a `defineResource()`. CRUD, schemas, auth, permissions, hooks, events all hang off the resource definition.
2. **DB-agnostic** — Arc never imports mongoose, prisma, or any database directly. Adapters implement `RepositoryLike`. MongoKit is recommended but optional.
3. **Primitives not opinions** — building blocks (outbox, hooks, role hierarchy, scope), NOT workflow engines or email senders.
4. **Optional peer deps, never bundled** — every integration is an optional peer dep. Arc's dist must never force-install anything.
5. **Tree-shakable** — 88+ subpath exports. Users import `@classytic/arc/factory`, `@classytic/arc/auth`, etc.
6. **No hardcoding** — different users use different databases, auth systems, message brokers, and deployment targets.
7. **No console.log in runtime** — use `fastify.log` or injectable logger interfaces. CLI may use `process.stdout.write`.
8. **Prefer Node.js built-ins** — `node:crypto`, `node:util`, `structuredClone()`, `URL`/`URLSearchParams` over third-party equivalents.

---

## 2. Architecture Map

```
src/                          181 files across 32 modules
  core/                       defineResource, BaseController (939L), QueryResolver, createCrudRouter, createActionRouter
  factory/                    createApp — the main entry point users call
  adapters/                   RepositoryLike interface + mongoose/prisma adapters
  auth/                       authPlugin (JWT), betterAuth adapter, sessionManager, redis-session
  permissions/                RBAC (989L), role hierarchy, field-level permissions, presets
  scope/                      RequestScope discriminated union (public|authenticated|member|service|elevated)
  events/                     EventPlugin, transports (memory, redis pub/sub, redis streams), defineEvent
  hooks/                      HookSystem (724L) — before/after lifecycle on resources
  cache/                      QueryCache, query-cache plugin, scope-aware cache keys
  plugins/                    health, tracing, requestId, response-cache, versioning, rate-limit, metrics, SSE, gracefulShutdown
  policies/                   PolicyInterface (row-level security, field masking)
  integrations/               jobs (BullMQ), streamline, websocket, SSE, MCP, webhooks
    mcp/                      createMcpServer, resourceToTools, defineTool, definePrompt, sessionCache
  migrations/                 MigrationRunner + MigrationStore interface (DB-agnostic)
  cli/                        arc init (3434L), generate, doctor, describe, introspect, docs
  testing/                    HttpTestHarness, mock helpers, createJwtAuthProvider, dbHelpers
  docs/                       OpenAPI spec generator (924L), Scalar UI, externalPaths
  utils/                      queryParser, stateMachine, compensate, retry, circuitBreaker, schemaConverter
  types/                      shared type definitions (1443L), Fastify declaration merges
  schemas/                    JSON Schema generation from field rules
  pipeline/                   guard, pipe, intercept, transform — execution pipeline stages
  middleware/                 request-level middleware system
  org/                        organizationPlugin, orgMembership, org types
  audit/                      auditPlugin, MongoDB audit store
  idempotency/                idempotencyPlugin, MongoDB + Redis stores
  context/                    async request context (AsyncLocalStorage)
  registry/                   resource registry, introspection plugin
  discovery/                  dynamic resource loading
  dynamic/                    ArcDynamicLoader
  logger/                     injectable logger interface
  rpc/                        serviceClient for inter-service calls
  presets/                    bulk, softDelete, ownedByUser, slugLookup, tree, multiTenant, audited
  constants.ts                shared constants
```

### Key File Size Reference

| File | Lines | Complexity | Test coverage |
|------|-------|------------|---------------|
| `src/cli/commands/init.ts` | 3,434 | High — scaffolding | Low (3 test files) |
| `src/types/index.ts` | 1,443 | Medium — type defs | `tests/types/` |
| `src/permissions/index.ts` | 989 | High — RBAC engine | `tests/permissions/` |
| `src/core/BaseController.ts` | 939 | High — request pipeline | `tests/core/base-controller.test.ts` |
| `src/docs/openapi.ts` | 924 | Medium — spec gen | `tests/docs/` |
| `src/hooks/HookSystem.ts` | 724 | Medium — lifecycle | `tests/hooks/` |
| `src/factory/types.ts` | 621 | Low — type defs | Covered by factory tests |

---

## 3. What NOT To Do

These rules are non-negotiable. Violating them will break users, the build, or the design.

| Rule | Why |
|------|-----|
| **Don't add `console.log`** to any file in `src/` outside `cli/` | Use logger injection. Users configure their own log transports |
| **Don't import mongoose/prisma** in core modules | Only in adapter files. Arc is DB-agnostic |
| **Don't add features "just in case"** | No speculative abstractions. Ship what's needed |
| **Don't make Arc ESM+CJS dual** | ESM-only, intentionally. CJS users use dynamic import |
| **Don't add `@ts-ignore`** | Fix the type instead. Use `as unknown as X` only as last resort |
| **Don't bundle optional peer deps** | Check `tsdown.config.ts` `deps.neverBundle` |
| **Don't use enums** | Use `as const` objects or string literal unions |
| **Don't replace `unknown` with `any`** | `unknown` defaults are intentional for type safety |
| **Don't add Dockerfile/Helm/K8s** | App-level concerns, not framework-level |
| **Don't add saga/workflow orchestration** | Use Streamline/Temporal for that |
| **Don't skip pre-commit hooks** | Fix the underlying issue instead |
| **Don't add default exports** | Named exports only (knip enforces this) |
| **Don't use third-party where Node.js built-in works** | `node:crypto`, `structuredClone()`, `URL` over uuid/lodash |

---

## 4. Type System Conventions

### request.user

```typescript
// Correct — required property, union with undefined
user: Record<string, unknown> | undefined;

// WRONG — optional property (breaks @fastify/jwt declaration merge)
user?: Record<string, unknown>;
```

`request.user` is undefined on public routes. Always guard: `if (request.user)`.

### RequestScope

Discriminated union on `kind`: `public | authenticated | member | service | elevated`.
The `service` kind covers API-key / machine-to-machine auth (custom auth
checks install it via `PermissionResult.scope`). All org-bound kinds
(member, service, elevated) optionally carry `context?: Readonly<Record<string, string>>`
for app-defined dimensions and `ancestorOrgIds?: readonly string[]` for
parent-child org chains.

```typescript
// Always use accessors, not direct property access
import {
  getUserId, getUserRoles, getOrgId, getServiceScopes,
  getScopeContext, getAncestorOrgIds, hasOrgAccess,
} from '@classytic/arc/scope';

const id      = getUserId(scope);                       // works for all scope kinds
const roles   = getUserRoles(scope);                    // string[]
const orgId   = getOrgId(scope);                        // member | service | elevated
const scopes  = getServiceScopes(scope);                // service kind only
const branch  = getScopeContext(scope, 'branchId');     // custom dimensions
const parents = getAncestorOrgIds(scope);               // parent orgs (always returns array)
hasOrgAccess(scope);                                    // member | service | elevated
```

Permission helpers that read scope: `requireOrgMembership`, `requireOrgRole`
(humans-only), `requireServiceScope` (machines-only, OAuth-style),
`requireScopeContext` (custom dimensions), `requireOrgInScope` (hierarchy),
`requireTeamMembership`. See `docs/getting-started/permissions.mdx` for the
full helper × scope-kind behavior table.

### Generics

- `BaseController<TDoc = AnyRecord>` — `TDoc` is auto-inferred from Mongoose `Model<T>`
- `MongooseAdapter<TDoc = unknown>` — `unknown` default forces narrowing (safer than `any`)
- `RepositoryLike` returns `Promise<unknown>` intentionally — minimum contract
- Never replace `unknown` defaults with `any`. They exist to enforce type safety at boundaries.

### Field Rules

v2: `schemaOptions.fieldRules: Record<string, { type: string }>` (stringly-typed)
v3 (planned): `fields: { name: field.string().required() }` (type-safe builder)

---

## 5. Testing

### Structure

```
tests/                         184 test files, 2700+ tests
  core/                        BaseController, QueryResolver, ActionRouter, lifecycle, schemas
  auth/                        JWT, Better Auth, sessions, tokens, revocation
  permissions/                 RBAC, field permissions, dynamic matrix
  scope/                       scope identity, getUserId
  hooks/                       HookSystem, introspection
  events/                      transports, correlation, fault tolerance, types
  cache/                       QueryCache, stores, SWR, tags, events, scope
  plugins/                     health, SSE, caching, response-cache, metrics, tracing, requestId, versioning
  presets/                     bulk, softDelete, ownedByUser, slugLookup, tree, multiTenant
  integrations/                websocket, jobs, webhooks, event-gateway
    mcp/                       createMcpServer, resourceToTools, defineTool, auth, permissions, DX
  docs/                        OpenAPI, Better Auth OpenAPI
  cli/                         pluralize, normalize-args, introspect, docs-command, doctor, init, generate
  factory/                     cors, resources-option, load-resources
  adapters/                    type-inference
  audit/                       audit-trail, auto-audit
  rpc/                         service-client, resilience
  dynamic/                     ArcDynamicLoader
  utils/                       query-parser, circuit-breaker, schemaConverter, response-schemas, error-cause
  types/                       type-ergonomics, type-inference
  e2e/                         full-app, rbac, elevation, org-scope, multi-tenant, no-auth, populate, query-*
  scenarios/                   jwt-org, dynamic-matrix, custom-auth, single-tenant, permission-presets
  security/                    policy injection, body fidelity, release blockers, auth checks
  setup.ts                     shared Vitest setup
```

### Test Coverage Gaps (remaining)

Most modules now have dedicated tests. These still rely on indirect coverage only:

| Module | Source files | Notes |
|--------|-------------|-------|
| `context/` | 2 | AsyncLocalStorage — tested indirectly via `request-context.test.ts` |
| `discovery/` | 1 | `loadResources()` — tested via `factory/load-resources.test.ts` |
| `idempotency/` | 9 | Plugin + stores — tested via `security/idempotency-body-hash.test.ts` |
| `registry/` | 3 | Resource registry — tested via `plugins/plugin-registry.test.ts` |
| `testing/` | 7 | Test utilities — used everywhere but not self-tested |

**Recently added dedicated tests:** pipeline/ (4 files), org/, policies/, middleware/, cache/keys, schemas/, logger/, migrations/

### Which Tests to Run (by file changed)

**Always run the specific test first. Never run the full suite during development — it takes minutes. CI catches cross-cutting issues.**

| Changed file(s) | Run these tests |
|-----------------|-----------------|
| `src/core/BaseController.ts` | `npx vitest run tests/core/base-controller.test.ts tests/core/access-control.test.ts tests/core/body-sanitizer.test.ts` |
| `src/core/createActionRouter.ts` | `npx vitest run tests/core/createActionRouter.test.ts tests/security/action-router-auth.test.ts` |
| `src/core/QueryResolver.ts` | `npx vitest run tests/core/query-resolver.test.ts tests/e2e/query-operators.test.ts tests/e2e/query-features.test.ts` |
| `src/auth/*` | `npx vitest run tests/auth/` |
| `src/auth/betterAuth.ts` | `npx vitest run tests/auth/better-auth-adapter.test.ts tests/auth/better-auth-e2e.test.ts` |
| `src/permissions/*` | `npx vitest run tests/permissions/ tests/e2e/rbac-permissions.test.ts tests/scenarios/permission-presets.test.ts` |
| `src/scope/*` | `npx vitest run tests/scope/ tests/e2e/elevation-plugin.test.ts tests/scenarios/jwt-org-scoping.test.ts` |
| `src/hooks/*` | `npx vitest run tests/hooks/ tests/core/resource-hooks.test.ts` |
| `src/events/*` | `npx vitest run tests/events/` |
| `src/cache/*` | `npx vitest run tests/cache/` |
| `src/plugins/*` | `npx vitest run tests/plugins/` |
| `src/presets/*` | `npx vitest run tests/presets/` |
| `src/integrations/mcp/*` | `npx vitest run tests/integrations/mcp/` |
| `src/integrations/websocket*` | `npx vitest run tests/integrations/websocket*.test.ts` |
| `src/integrations/jobs*` | `npx vitest run tests/integrations/jobs*.test.ts` |
| `src/factory/*` | `npx vitest run tests/factory/ tests/e2e/full-app.test.ts` |
| `src/docs/*` | `npx vitest run tests/docs/` |
| `src/cli/*` | `npx vitest run tests/cli/` |
| `src/utils/*` | `npx vitest run tests/utils/` |
| `src/adapters/*` | `npx vitest run tests/adapters/ tests/core/base-controller.test.ts` |
| `src/org/*` | `npx vitest run tests/e2e/org-scope-plugin.test.ts tests/scenarios/jwt-org-scoping.test.ts` |
| `src/policies/*` | `npx vitest run tests/policies/ tests/security/policy-filter-*.test.ts` |
| `src/pipeline/*` | `npx vitest run tests/pipeline/ tests/core/base-controller.test.ts` |
| `src/middleware/*` | `npx vitest run tests/middleware/` |
| `src/migrations/*` | `npx vitest run tests/migrations/` |
| `src/schemas/*` | `npx vitest run tests/schemas/ tests/core/auto-schema-generation.test.ts` |
| `src/logger/*` | `npx vitest run tests/logger/` |
| `src/idempotency/*` | `npx vitest run tests/security/idempotency-body-hash.test.ts` |
| `src/rpc/*` | `npx vitest run tests/rpc/` |
| `src/dynamic/*` | `npx vitest run tests/dynamic/` |
| `src/types/*` | `npx vitest run tests/types/` |
| Any `src/testing/*` | `npx vitest run tests/e2e/full-app.test.ts` (uses HttpTestHarness) |

### Running Tests

```bash
# Specific file (fastest feedback loop)
npx vitest run tests/core/base-controller.test.ts

# Specific directory
npx vitest run tests/auth/

# Pattern match
npx vitest run -t "permission"

# Full suite (CI only — takes ~2 minutes)
npx vitest run

# Watch mode during development
npx vitest tests/core/base-controller.test.ts
```

### Writing Tests

- Mirror source structure: `src/foo/bar.ts` → `tests/foo/bar.test.ts`
- Use `mongodb-memory-server` for all MongoDB tests — never a real DB
- Use `HttpTestHarness` from `src/testing/` for HTTP round-trip tests
- Use `createJwtAuthProvider` for auth-aware tests
- OTel tests: use `describe.skip` when `@opentelemetry/api` is not installed
- Always test both success AND failure paths
- Test error messages — they're part of the API contract
- Use `toMatchObject` for partial assertions (not `toEqual` when object has dynamic fields)

---

## 6. Architecture Gotchas

Things that will bite you if you don't know about them.

### 1. request.user is required, not optional

`@fastify/jwt` declares `request.user` as a required property. Arc types it as `Record<string, unknown> | undefined`. You cannot use `user?:` (optional property) because it conflicts with the declaration merge. On public routes, `request.user` is `undefined`.

### 2. RepositoryLike returns Promise<unknown>

This is intentional. `RepositoryLike` is the minimum contract any adapter must implement. `BaseController` casts internally. If you're writing an adapter, return `Promise<unknown>` — the controller handles narrowing.

### 3. Redis Streams are at-least-once, not exactly-once

The event transport does not deduplicate. Consumer groups handle offset tracking, but if a consumer crashes mid-processing, it will re-receive the event. Design handlers to be idempotent.

### 4. isRevoked is fail-closed

If the `isRevoked` callback throws an error, the token is treated as revoked (access denied). This is a security design choice — errors should block, not grant access.

### 5. select is never forced to string

`QueryResolver` preserves `select` in its original format (string, array, or MongoDB-style object projection). This is intentional for DB-agnostic compatibility. Don't normalize it.

### 6. Type-only subpath exports produce `export {}` at runtime

Subpaths like `./org/types` and `./integrations` only export TypeScript interfaces. After compilation, the `.mjs` file contains `export {}`. This is correct — interfaces are erased. Don't try to add runtime exports to make them "not empty".

### 7. Event publishing is fire-and-forget by default

`failOpen: true` means if event publishing fails, the HTTP request still succeeds. For guaranteed delivery, use the outbox pattern. Don't change the default — it protects user-facing latency.

### 8. CLI init.ts is 3,434 lines

This is the scaffolding generator. It's intentionally large because it generates complete project structures. Don't try to split it into many tiny files — the template logic is sequential and benefits from being in one place. But it needs more tests.

### 9. Presets compose, but order matters

Multiple presets on a single resource can conflict (e.g., `softDelete` + `bulk` both modify the delete route). `tests/presets/preset-conflicts.test.ts` validates known conflicts. Always test preset combinations.

### 10. MCP tools are auto-generated from resources

`resourceToTools()` inspects the resource definition and creates CRUD tool definitions. If you change field rules, permissions, or route structure, the MCP tools change too. Always run MCP tests after resource changes.

---

## 7. Development Workflow

### Before Writing Code

1. **Understand the module** — Read the source file AND its tests before changing anything
2. **Check for existing patterns** — Search codebase for similar implementations: `grep -r "pattern" src/`
3. **Identify blast radius** — Use the test mapping (Section 5) to know what might break

### Writing Code

1. **Add tests first** when fixing bugs (reproduce the bug as a failing test)
2. **Run targeted tests** as you work (never the full suite)
3. **Biome check frequently**: `npx biome check src/path/to/file.ts`
4. **No new dependencies** unless absolutely necessary — prefer Node.js built-ins

### Before Committing

```bash
# Quick validation (do this always)
npx tsc --noEmit                                    # Zero type errors
npx biome check src/ --diagnostic-level=error        # Zero lint errors
npx vitest run tests/path/to/changed-module/         # Targeted tests pass

# Full validation (before publish or major changes)
npx vitest run                                       # All 173 test files pass
npx knip                                             # No new dead code
npm run build                                        # Clean dist output
npm run smoke                                        # CLI and imports work
```

### Commit Messages

Follow conventional commits. Keep it short and focused on WHY, not WHAT.

```
fix(auth): fail-closed on isRevoked errors
feat(mcp): operator-suffixed filter fields in schemas
refactor(core): extract body sanitizer from BaseController
test(permissions): add field-level permission edge cases
```

---

## 8. Build & Publish

### Build Pipeline

```bash
npm run build       # tsdown → dist/ (ESM-only, .mjs + .d.mts)
npm run typecheck   # tsc --noEmit (strict mode)
npm run lint        # biome check src/
npm run smoke       # node scripts/smoke-test.mjs
npx knip            # dead code detection
```

### Version Injection

`__ARC_VERSION__` is replaced at build time via `tsdown.config.ts` define. The runtime reads this constant — never hardcode a version string.

### Pre-Publish Checklist

1. `npx tsc --noEmit` — zero type errors
2. `npx biome check src/ --diagnostic-level=error` — zero lint errors
3. `npx vitest run` — all tests pass (210+ files, 2900+ tests, 0 failures)
4. `npx knip` — review unused exports, no new dead code
5. `npm run build` — dist/ output clean
6. Verify subpath exports resolve:
   - Every `package.json` exports entry has matching `.mjs` + `.d.mts` in `dist/`
   - Type-only subpaths produce `export {}` at runtime (correct)
   - `./testing` requires Vitest runtime — cannot be imported outside tests
7. `npm run smoke` — CLI works, critical imports resolve
8. `npx knip` reports only intentional public API

### Subpath Exports

Arc has 88+ subpath exports. Users import specific paths:

```typescript
import { createApp } from '@classytic/arc/factory';
import { defineResource } from '@classytic/arc/core';
import { authPlugin } from '@classytic/arc/auth';
```

Never import from the root barrel in production code. Every subpath must have matching `.mjs` + `.d.mts` in `dist/`.

---

## 9. Peer Dependencies

| Peer | Min Version | Required? | Used by |
|------|-------------|-----------|---------|
| fastify | >=5.0.0 | **Yes** | Everything |
| @classytic/mongokit | >=3.5.0 | No | Recommended MongoDB adapter |
| mongoose | >=9.0.0 | No | Mongoose adapter |
| @prisma/client | >=5.0.0 | No | Prisma adapter |
| better-auth | >=1.5.5 | No | Better Auth integration |
| @classytic/streamline | >=2.0.0 | No | Streamline integration |
| ioredis | >=5.0.0 | No | Redis event transport, caching, sessions |
| bullmq | >=5.0.0 | No | Job queue integration |
| @opentelemetry/* | various | No | Tracing plugin |

**Rule:** Never bundle peer deps. `tsdown.config.ts` `deps.neverBundle` enforces this at build time.

---

## 10. Documentation & Skills

| Location | Purpose |
|----------|---------|
| `CLAUDE.md` | Quick agent reference (links here) |
| `AGENTS.md` | This file — comprehensive guide |
| `v3.md` | v3 design notes and migration plan |
| `docs/` | Nextra documentation site source |
| `skills/arc/` | Claude Code skill definitions |
| `skills/arc/references/` | Auth, production, integrations, events, MCP references |
| `knip.config.ts` | Dead code detection configuration |
| `biome.json` | Linter/formatter configuration |
| `tsdown.config.ts` | Build configuration |
| `vitest.config.ts` | Test configuration |

### Skills

Skills are installed via: `npx skills add classytic/arc`

The skill is indexed at skills.sh under `classytic/arc/arc`.

---

## 11. v3 Planning

See [v3.md](v3.md) for the full design document. Key changes:

- `field.string().required()` — type-safe field definitions
- `model: Model` — auto-detect adapter (no manual `createMongooseAdapter`)
- `routes: [...]` — replaces `additionalRoutes` + `wrapHandler`
- `filter: [...]` — single source of truth (no more dual config)
- `public()`, `auth()`, `roles()`, `owner()` — permission shorthand
- `createApp({ resources })` — no `toPlugin()` (already shipped in v2.5.2)

**Zero breaking changes** — all v2 config fields accepted with deprecation warnings.

---

## 12. Security Checklist

When touching auth, permissions, MCP, or data handling:

- [ ] Token revocation: `isRevoked` remains fail-closed (errors = denied)
- [ ] Public routes: `request.user` is undefined — code guards properly
- [ ] Field permissions: hidden fields not leaked in responses or MCP schemas
- [ ] Policy filters: cannot be bypassed via query manipulation
- [ ] Event data: sensitive fields stripped before publishing
- [ ] MCP auth: tools enforce same permissions as REST endpoints
- [ ] Session ownership: validate session belongs to requesting user
- [ ] Body sanitization: immutable fields stripped on update
- [ ] Rate limiting: scoped per tenant when multi-tenant
- [ ] Idempotency: body hash prevents replay with different payloads

---

## 13. Common Patterns

### Adding a new preset

1. Create `src/presets/myPreset.ts`
2. Implement preset factory returning `PresetDefinition`
3. Export from `src/presets/index.ts`
4. Add tests in `tests/presets/my-preset.test.ts`
5. Test composition with existing presets in `tests/presets/preset-conflicts.test.ts`

### Adding a new plugin

1. Create `src/plugins/myPlugin.ts`
2. Use `createPlugin()` helper from `src/plugins/createPlugin.ts`
3. Register in `src/factory/` if it should be auto-loaded
4. Add tests in `tests/plugins/my-plugin.test.ts`

### Adding a new event transport

1. Create `src/events/transports/myTransport.ts`
2. Implement the transport interface from `src/events/index.ts`
3. Add tests in `tests/events/my-transport.test.ts`
4. Document at-least-once vs at-most-once guarantee

### Adding a new adapter

1. Create `src/adapters/myAdapter.ts`
2. Implement `RepositoryLike` interface from `src/adapters/interface.ts`
3. Return `Promise<unknown>` from all methods
4. Add as optional peer dep in `package.json`
5. Add to `tsdown.config.ts` `deps.neverBundle`
6. Add to `knip.config.ts` `ignoreDependencies`
7. Test in `tests/adapters/my-adapter.test.ts`

### Adding a CLI command

1. Create `src/cli/commands/myCommand.ts`
2. Register in `src/cli/index.ts`
3. May use `process.stdout.write` (exception to no-console rule)
4. Test in `tests/cli/my-command.test.ts`

---

## 14. File Naming Conventions

| Pattern | Location | Example |
|---------|----------|---------|
| `index.ts` | Module entry point | `src/auth/index.ts` |
| `interface.ts` | Type-only interface | `src/adapters/interface.ts`, `src/cache/interface.ts` |
| `types.ts` | Shared type defs | `src/factory/types.ts`, `src/pipeline/types.ts` |
| `*.test.ts` | Test files | `tests/auth/token-revocation.test.ts` |
| `*Plugin.ts` | Fastify plugin | `src/org/organizationPlugin.ts` |
| `*-entry.ts` | Dynamic import entry | `src/plugins/tracing-entry.ts` |
| `*.d.ts` | Ambient declarations | `src/optional-peers.d.ts` |

---

## 15. Glossary

| Term | Meaning in Arc |
|------|---------------|
| **Resource** | A `defineResource()` config object — the fundamental unit |
| **Adapter** | Implements `RepositoryLike` — bridges Arc to a database |
| **Preset** | Composable behavior modifier (softDelete, bulk, ownedByUser, etc.) |
| **Scope** | `RequestScope` — discriminated union describing the current request's auth state |
| **Guard** | Pipeline stage that allows/denies request execution |
| **Hook** | Before/after lifecycle callback on resource operations |
| **Transport** | Event delivery mechanism (memory, Redis pub/sub, Redis streams) |
| **Outbox** | Pattern for guaranteed event delivery with DB-level atomicity |
| **MCP** | Model Context Protocol — AI tool generation from resources |
| **MongoKit** | `@classytic/mongokit` — recommended MongoDB adapter with query parser |
| **Streamline** | `@classytic/streamline` — workflow/saga orchestration (separate package) |
