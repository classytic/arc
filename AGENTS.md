# AGENTS.md — @classytic/arc

Deep contributor guide. For session-level context see [CLAUDE.md](CLAUDE.md). For release history see [CHANGELOG.md](CHANGELOG.md).

This file covers: philosophy, architecture, what not to do, testing workflow, build/publish, peer-dep policy, "adding a new X" patterns, and the glossary. Version numbers, test counts, and per-file line counts deliberately live nowhere here — they rot.

---

## 1. Philosophy

1. **Resource-oriented** — everything hangs off `defineResource()`. CRUD, schemas, auth, permissions, hooks, events all flow from one config.
2. **DB-agnostic via `@classytic/repo-core`** — arc never imports any DB driver directly. Every kit-specific adapter (Mongoose, Drizzle, Prisma, …) lives in its kit (`@classytic/mongokit/adapter`, `@classytic/sqlitekit/adapter`, `@classytic/prismakit/adapter`); the cross-framework adapter contract lives in `@classytic/repo-core/adapter`. Custom kits implementing `DataAdapter<TDoc>` plug in identically.
3. **Primitives, not opinions** — building blocks (outbox, hooks, role hierarchy, scope) NOT workflow engines or email senders. Streamline / Temporal / BullMQ are separate packages.
4. **Peer deps, never bundled** — every integration is optional. Arc's `dist/` forces nothing beyond `fastify`.
5. **Tree-shakable** — many subpath exports. Hosts import `@classytic/arc/factory`, `@classytic/arc/auth`, etc. Root barrel is essentials only.
6. **Prefer Node.js built-ins** — `node:crypto`, `node:util`, `structuredClone()`, `URL` / `URLSearchParams` over third-party.
7. **Fail-closed security** — `isRevoked` errors deny access, unauthenticated scope means no tenant filters applied, auth-less actions throw at boot.

---

## 2. Architecture

```
src/
  core/          defineResource · BaseCrudController + mixins → BaseController · QueryResolver · createCrudRouter · routerShared · schemaIR
  factory/       createApp (main entry point) · registerResources · loadResources
  auth/          JWT · Better Auth · sessions · revocation
  permissions/   core (auth/roles/ownership + combinators) · scope · dynamic (matrices) · fields · presets · roleHierarchy
  scope/         RequestScope discriminated union (public | authenticated | member | service | elevated)
  events/        EventPlugin · transports (memory, redis pub/sub, redis streams) · defineEvent · outbox
  hooks/         HookSystem · before/after lifecycle
  cache/         QueryCache · stores · SWR · keys
  plugins/       health · tracing · requestId · response-cache · versioning · rate-limit · metrics · SSE · gracefulShutdown
  integrations/  jobs (BullMQ) · websocket · SSE · MCP · webhooks · streamline bridge
    mcp/         createMcpServer · resourceToTools · defineTool · definePrompt · session-cache
  migrations/    MigrationRunner + MigrationStore (DB-agnostic)
  cli/           init · generate · doctor · describe · introspect · docs
  testing/       createHttpTestHarness · createTestApp · TestAuthSession · TestFixtures · expectArc
  docs/          OpenAPI spec · Scalar UI
  utils/         queryParser · stateMachine · compensate · retry · circuitBreaker · schemaConverter · store-helpers (internal)
  types/         shared type definitions · Fastify declaration merges (type-only)
  schemas/       JSON Schema from field rules
  pipeline/      guard · pipe · intercept · transform · executePipeline
  middleware/    request-level middleware · multipartBody (file upload)
  org/           organization plugin · membership
  audit/         audit plugin + stores
  idempotency/   idempotency plugin + stores
  context/       async request context (AsyncLocalStorage)
  registry/      resource registry · introspection plugin
  discovery/     filesystem auto-discovery
  logger/        injectable logger interface
  presets/       bulk · softDelete · ownedByUser · slugLookup · tree · multiTenant · audited · search · filesUpload
```

---

## 3. What NOT to do

These rules are non-negotiable. Violating them breaks users, the build, or the design.

| Rule | Why |
|------|-----|
| No `console.log` outside `cli/` | Use logger injection — hosts configure their own transports. |
| No DB driver imports anywhere in arc | Every kit-specific adapter (Mongoose, Drizzle, Prisma, …) lives in its kit's `/adapter` subpath. Arc has zero kit-bound adapters. |
| No `any`; `unknown` defaults stay | Type safety at boundaries. `as unknown as X` only as last resort. |
| No `@ts-ignore` | Fix the type. |
| No default exports | Named exports only; knip enforces. **Documented exception**: Fastify plugin entry files (`auditPlugin`, `authPlugin`, `eventPlugin`, `idempotencyPlugin`, `introspectionPlugin`) MAY `export default fp(plugin, …)` so `app.register(import('@classytic/arc/<plugin>'))` resolves via Node's import-default semantics. Each plugin ALSO ships a named export for hosts that prefer named imports. |
| No ESM+CJS dual package | ESM-only, intentionally. CJS hosts use dynamic `import()`. |
| No enums | `as const` objects or string literal unions. |
| No new dependencies without need | Check Node.js built-ins first. Add to `tsdown.config.ts neverBundle` if peer. |
| No Dockerfile / Helm / K8s | App-level concern, not framework. |
| No saga / workflow orchestration | Separate packages (Streamline, Temporal). |
| No skipping pre-commit hooks | Fix the underlying issue. |
| No speculative abstractions | Ship what's needed. |

---

## 4. Type conventions

### `request.user`

```typescript
user: Record<string, unknown> | undefined;   // ✓ required property, union with undefined
user?: Record<string, unknown>;              // ✗ conflicts with @fastify/jwt declaration merge
```

### `RequestScope`

Discriminated union on `kind`: `public | authenticated | member | service | elevated`. Always use accessors — never reach into properties directly.

```typescript
import {
  getUserId, getUserRoles, getOrgId, getServiceScopes,
  getScopeContext, getAncestorOrgIds, hasOrgAccess,
  requireUserId, requireOrgId, requireClientId, requireTeamId,
} from '@classytic/arc/scope';
```

The `requireXxxId(scope, hint?)` accessors return the value or throw an `ArcError` when absent — use these at handler boundaries instead of hand-rolling `if (!getOrgId(scope)) throw ...`. Status code splits by identity dimension: `requireUserId` / `requireClientId` throw `UnauthorizedError` (401, "you're not authenticated as the right principal"); `requireOrgId` / `requireTeamId` throw `OrgRequiredError` (403, "you're authenticated but lack the tenancy context").

Permission helpers that read scope: `requireOrgMembership`, `requireOrgRole` (humans-only), `requireServiceScope` (machines, OAuth-style), `requireScopeContext` (custom dimensions), `requireOrgInScope` (hierarchy), `requireTeamMembership`. Full behaviour matrix in `docs/getting-started/permissions.mdx`.

### Generics + the `TDoc extends AnyRecord` constraint

- `BaseController<TDoc extends AnyRecord = AnyRecord>` — the `extends` bound IS load-bearing here. The mixin-composed base (`SoftDeleteMixin(TreeMixin(SlugMixin(BulkMixin(BaseCrudController))))`) pins `AnyRecord`, so derived method returns (`ListResult<TDoc>`) must be assignable to the base's (`ListResult<AnyRecord>`). Declaration merging threads `TDoc` through the public interface while the runtime composition stays pinned.
- `defineResource<TDoc = AnyRecord>` — NO `extends` bound. Widens internally once at the BaseController boundary so hosts pass narrow domain types (Mongoose `HydratedDocument<T>`, Prisma row types, plain interfaces without index signatures).
- Every adapter factory (`createMongooseAdapter` from mongokit, `createDrizzleAdapter` from sqlitekit, `createPrismaAdapter` from prismakit, future kits) — NO `extends` bound. Mongoose's own document types don't carry index signatures; constraining here would fire on the exact idioms these factories accept.
- `RepositoryLike<TDoc = unknown> = MinimalRepo<TDoc> & Partial<StandardRepo<TDoc>>` — arc's compound, re-exported from `@classytic/repo-core/adapter`. Hosts can also import directly from `@classytic/repo-core/adapter` (canonical) or `@classytic/repo-core/repository` (underlying `MinimalRepo` / `StandardRepo`).

### Override utility types

Exported from `@classytic/arc`. Let subclass authors read the base's return shape:

```typescript
import type { ArcCreateResult, ArcListResult, ArcUpdateResult } from '@classytic/arc';

class ReviewController extends BaseController<IReview> {
  async create(ctx: IRequestContext): ArcCreateResult<this> {
    // `this` threads the concrete controller's TDoc — no need to restate
    // Promise<IControllerResponse<IReview>>
    return super.create(ctx);
  }
}
```

---

## 5. Testing

### Workflow

1. **Read the source + its tests before changing anything.**
2. **Add a failing test first** when fixing bugs — reproduce, then fix.
3. **Run targeted tests** using the table in [CLAUDE.md](CLAUDE.md). Never the full suite during dev.
4. **Biome check frequently** on changed files.
5. **Before commit:** `npx tsc --noEmit` + `npx biome check src/ --diagnostic-level=error` + targeted tests pass.

### Writing tests

- Mirror source structure: `src/foo/bar.ts` → `tests/foo/bar.test.ts`.
- Use `mongodb-memory-server` for MongoDB tests — never a real DB.
- Use `createHttpTestHarness` from `src/testing/` for HTTP round-trip.
- Use `TestAuthSession` / `TestAuthProvider` for auth-aware tests.
- Test success AND failure paths. Test error messages — they're part of the API contract.
- Use `toMatchObject` for partial assertions when objects have dynamic fields.

### The perf/leak lane

`tests/perf/**` runs in an isolated process (`--expose-gc`) via `npm run test:perf`. Keep leak + perf assertions out of the shared Vitest heap so GC noise from unrelated files can't cause false failures.

---

## 6. Build & publish

```bash
npm run build       # tsdown → dist/ (ESM-only, .mjs + .d.mts)
npm run typecheck   # tsc --noEmit (strict mode)
npm run lint        # biome check src/
npm run smoke       # scripts/smoke-test.mjs
npx knip            # dead-code detection
```

### Version injection

`__ARC_VERSION__` is replaced at build time via `tsdown.config.ts` `define`. The runtime reads this constant — never hardcode a version string.

### Pre-publish checklist

1. `npx tsc --noEmit` — zero type errors.
2. `npx biome check src/ --diagnostic-level=error` — zero lint errors.
3. `npm run test:ci` — main suite + isolated perf suite both green.
4. `npx knip` — review unused exports; no new dead code.
5. `npm run build` — clean `dist/`, every `package.json` exports entry has matching `.mjs` + `.d.mts`.
6. `npm run smoke` — CLI and critical subpath imports resolve.
7. [CHANGELOG.md](CHANGELOG.md) updated with migration notes for any breaking change.

### Subpath exports

Hosts import subpaths, not the root barrel:

```typescript
import { createApp } from '@classytic/arc/factory';
import { defineResource } from '@classytic/arc/core';
import { authPlugin } from '@classytic/arc/auth';
```

Every subpath must have matching `.mjs` + `.d.mts` in `dist/`. Type-only subpaths (like `./types`) produce `export {}` at runtime — that's correct, interfaces are erased.

### Release push + publish flow

See [RELEASING.md](RELEASING.md) — canonical for every `@classytic/*` package.

---

## 7. Peer dependencies

| Peer | Required? | Used by |
|------|-----------|---------|
| fastify | **Yes** | Everything |
| @classytic/primitives | **Yes** | Event types (`EventMeta`, `DomainEvent`, `EventTransport`, `createEvent`, ...) |
| @classytic/repo-core | No | `RepositoryLike`, adapter contract (`/adapter`), canonical pagination / tenant / errors / schema-generator contracts |
| better-auth | No | Better Auth integration |
| ioredis | No | Redis event transport, caching, sessions |
| bullmq | No | Job-queue integration |
| @opentelemetry/* | No | Tracing plugin |
| @classytic/streamline | No | Workflow bridge (separate package) |

**Removed in arc 2.12:** `@classytic/mongokit`, `@classytic/sqlitekit`, `mongoose`, `@prisma/client`. Every kit-specific adapter (Mongoose, Drizzle, Prisma) lives in its own kit — hosts depend on the kit and import from its `/adapter` subpath. The kit owns the driver peer dep. Arc has zero kit- or driver-bound peers.

**Rule:** never bundle peer deps. `tsdown.config.ts neverBundle` enforces at build time.

---

## 8. Security checklist

When touching auth, permissions, MCP, idempotency, or data handling:

- [ ] Token revocation: `isRevoked` remains fail-closed (errors = denied).
- [ ] Public routes: `request.user` is `undefined` — code guards properly.
- [ ] Field permissions: hidden fields not leaked in responses OR MCP tool schemas.
- [ ] Permission filters: row-level filters from `requireOwnership` / `multiTenantPreset` cannot be bypassed via query manipulation.
- [ ] Event data: sensitive fields stripped before publishing.
- [ ] MCP tools enforce same permissions as REST — arc feature-detects; verify both surfaces.
- [ ] Session ownership: validate session belongs to requesting user.
- [ ] Body sanitization: immutable fields stripped on update; `systemManaged` fields never trusted from the wire.
- [ ] Rate limiting: scoped per tenant when multi-tenant.
- [ ] Idempotency: body-hash fingerprint prevents replay with different payloads.

---

## 9. Adding a new X

### New preset

1. `src/presets/myPreset.ts` — factory returning `PresetDefinition`.
2. Export from `src/presets/index.ts`.
3. Tests in `tests/presets/my-preset.test.ts`.
4. Test composition with existing presets in `tests/presets/preset-conflicts.test.ts`.

### New plugin

1. `src/plugins/myPlugin.ts` — use `createPlugin()` helper.
2. Register in `src/factory/` if auto-loaded.
3. Tests in `tests/plugins/my-plugin.test.ts`.

### New event transport

1. `src/events/transports/myTransport.ts` — implement the transport interface.
2. Document at-least-once vs at-most-once guarantee in the file header.
3. Tests in `tests/events/my-transport.test.ts`.

### New adapter

Adapters live in their owning kit, never in arc. Ship the adapter from `@classytic/<kit>/adapter`. Steps:

1. In the kit, implement `DataAdapter` from `@classytic/repo-core/adapter` and expose the factory via the kit's `/adapter` subpath.
2. Return `Promise<unknown>` from minimum-contract methods (`MinimalRepo`). Implement `StandardRepo` optionals where the backend supports them.
3. The kit owns the driver peer dep (e.g. `mongoose`, `drizzle-orm`, `@prisma/client`) — arc does NOT.
4. Tests in the kit's test suite. Run arc's `tests/adapters/` against the kit-built adapter for cross-kit conformance.
5. Add the kit to `arc-code-review` migration tables + the relevant wiki pages if it's the first one to use a new strategy (e.g., column-based vs document-based).

### New CLI command

1. `src/cli/commands/myCommand.ts`. May use `process.stdout.write` (the exception to the no-console rule).
2. Register in `src/cli/index.ts`.
3. Tests in `tests/cli/my-command.test.ts`.

---

## 10. File naming conventions

| Pattern | Purpose | Example |
|---------|---------|---------|
| `index.ts` | Module entry point | `src/auth/index.ts` |
| `interface.ts` | Type-only contract | `src/events/interface.ts` |
| `types.ts` | Shared type defs | `src/factory/types.ts` |
| `*.test.ts` | Vitest test file | `tests/auth/token-revocation.test.ts` |
| `*Plugin.ts` | Fastify plugin | `src/org/organizationPlugin.ts` |
| `*.d.ts` | Ambient declarations | `src/optional-peers.d.ts` |

---

## 11. Glossary

| Term | Meaning in arc |
|------|---------------|
| Resource | A `defineResource()` config — the fundamental unit. |
| Adapter | Implements `DataAdapter` (`@classytic/repo-core/adapter`) — bridges arc to a database. Lives in the owning kit; arc retains zero kit-bound adapters. |
| Preset | Composable behaviour modifier (softDelete, bulk, ownedByUser, …). |
| Scope | `RequestScope` — discriminated union describing the current request's auth state. |
| Guard | Pipeline stage that allows or denies request execution. |
| Hook | Before/after lifecycle callback on resource operations. |
| Transport | Event-delivery mechanism (memory, redis pub/sub, redis streams). |
| Outbox | Pattern for guaranteed event delivery with DB-level atomicity. |
| MCP | Model Context Protocol — AI tool generation from resources. |
| RepositoryLike | `MinimalRepo<TDoc> & Partial<StandardRepo<TDoc>>` — arc's compound contract. |
| MinimalRepo / StandardRepo | Repo-core's contracts. Import directly from `@classytic/repo-core/repository`. |
| mongokit / sqlitekit / prismakit | `@classytic/mongokit` (MongoDB) / `@classytic/sqlitekit` (SQLite via Drizzle) / `@classytic/prismakit` (any DB via Prisma). |
| Streamline | `@classytic/streamline` — workflow / saga orchestration (separate package). |

---

## 12. Further reading

- [CHANGELOG.md](CHANGELOG.md) — release history, migration notes, breaking changes.
- [v3.md](v3.md) — v3 design notes and migration path.
- [docs/](docs/) — Nextra documentation site source (user-facing).
- [wiki/](wiki/) — concept pages for internal contributor use; load on demand.
- `skills/arc/` — Claude Code skill definitions.
