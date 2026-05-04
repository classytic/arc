# CLAUDE.md — @classytic/arc

Loaded every session. Every line must earn its place.

- **Deep guide:** [AGENTS.md](AGENTS.md)
- **Release history / migrations:** [CHANGELOG.md](CHANGELOG.md)
- **v3 design:** [v3.md](v3.md)
- **Concept pages:** [wiki/index.md](wiki/index.md). Load on demand instead of re-reading `src/`. After any change that invalidates a page: edit it, update `wiki/index.md`, append one line to `wiki/log.md`. Keep pages tight; link with `[[page-name]]` instead of duplicating.

## What arc is

Resource-oriented backend framework on Fastify. One `defineResource()` call → REST API + auth + permissions + events + caching + OpenAPI + MCP tools. Node.js 22+, TypeScript strict, ESM-only, Fastify 5+.

## Commands

```bash
npx tsc --noEmit                                  # Typecheck
npx biome check src/ --diagnostic-level=error     # Lint (Biome, no ESLint/Prettier)
npx vitest run tests/path/to/file.test.ts         # Targeted test — preferred during dev
npm run test:main                                 # Main suite (excludes perf)
npm run test:ci                                   # Release gate — main + isolated perf
npm run build                                     # tsdown → dist/
npm run smoke                                     # CLI + subpath imports
npx knip                                          # Dead-code detection
npm run push -- main                              # Push as classytic-bot[bot] (see below)
```

**Never run the full suite during dev.** Use the targeted test table. `test:ci` is for release.

## Release workflow

See [RELEASING.md](RELEASING.md) — canonical commit/push/publish steps for every `@classytic/*` package.

## Non-negotiable rules

- **No `console.log` in `src/`** (except `cli/`) — use logger injection.
- **No DB driver imports anywhere in arc** — kit-specific adapters live in their kits (`@classytic/<kit>/adapter`). arc is DB-agnostic.
- **No `any`** — use `unknown`; `as unknown as X` is a last resort, not a shortcut.
- **No `@ts-ignore`** — fix the type.
- **No default exports** — named exports only (knip enforces). **Documented exception**: Fastify plugin entry files (`auditPlugin`, `authPlugin`, `eventPlugin`, `idempotencyPlugin`, `introspectionPlugin`) MAY `export default fp(plugin, …)` so `app.register(import('@classytic/arc/<plugin>'))` resolves via Node's import-default semantics. Each of those files ALSO ships a named export for hosts that prefer named imports. Non-plugin code follows the rule strictly.
- **No bundling peer deps** — check `tsdown.config.ts` `deps.neverBundle`.
- **No enums** — `as const` objects or string literal unions.
- **Prefer Node.js built-ins** — `node:crypto`, `structuredClone()`, `URL` over third-party equivalents.

## Type conventions

- `request.user: Record<string, unknown> | undefined` — **required** property, NOT optional (`?:` conflicts with `@fastify/jwt` declaration merge). Guard with `if (request.user)` on public routes.
- `RequestScope` is a discriminated union on `kind`. Use `getUserId(scope)` / `getOrgId(scope)` / `hasOrgAccess(scope)` from `@classytic/arc/scope` — never reach into properties directly. For handler boundaries that must have an id, prefer the throwing accessors `requireOrgId(scope, hint?)` / `requireUserId(scope, hint?)` / `requireClientId(scope, hint?)` / `requireTeamId(scope, hint?)` — they return the value or throw a `403` `ArcError`.
- `RepositoryLike<TDoc = unknown> = MinimalRepo<TDoc> & Partial<StandardRepo<TDoc>>`. Arc feature-detects optional methods at call sites. Kits declare only what they implement.
- `BaseController<TDoc extends AnyRecord = AnyRecord>` — the `extends` bound is load-bearing (mixin-composed base pins `AnyRecord`). `defineResource` and all adapter factories are UNCONSTRAINED; they widen internally so narrow domain types (Mongoose `HydratedDocument<T>`, Prisma row types) flow without host-side casts.

## Test mapping

Run the minimum that covers your change:

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
| `src/utils/store-helpers*` | `npx vitest run tests/adapters/ tests/core/base-controller.test.ts` |
| `src/docs/*` | `npx vitest run tests/docs/` |
| `src/cli/*` | `npx vitest run tests/cli/` |
| `src/utils/queryParser*` | `npx vitest run tests/utils/ tests/property/` |
| `src/auth/authPlugin*` | `npx vitest run tests/auth/ tests/property/jwt-bearer*` |

## Load-bearing gotchas

Non-obvious design choices that won't be caught by tests. Release-tagged changes live in [CHANGELOG.md](CHANGELOG.md); only keep entries here if they'd bite a contributor walking in cold.

- **`request.user` is `undefined` on public routes** — always guard.
- **`isRevoked` is fail-closed** — errors = access denied. Security design choice.
- **Redis Streams are at-least-once** — handlers must be idempotent.
- **`select` is never normalized** — preserved as-is (string / array / projection object) for DB agnosticism.
- **Type-only subpath exports produce `export {}` at runtime** — correct; interfaces are erased.
- **Event publishing is fire-and-forget** (`failOpen: true`). Use outbox for guaranteed delivery.
- **Dual-publish dev-warn** — calling both `app.events.publish()` and an `eventStrategy: 'auto'` resource hook for the same event in development triggers a one-shot warning. Pick one path (manual publish OR `eventStrategy`).
- **Plugins set response headers at `onRequest` or `preSerialization`, never `onSend`** — async `onSend` races with Fastify's `onSendEnd → safeWriteHead` flush path and produces `ERR_HTTP_HEADERS_SENT` under slow responses.
- **Always read `resolvedConfig.X` in `defineResource.ts`, never raw `config.X`** — `resolvedConfig` is the post-preset, post-auto-inject canonical copy. Touching raw `config` after presets apply ships half-wired features.
- **Presets compose but order matters** — test combinations (`tests/presets/preset-conflicts.test.ts`).
- **MCP tools feature-detect the same permission chain as CRUD** — if you change field rules or permissions, run MCP tests too.
- **Field-write perms default to `reject` (403)** — opt into silent `strip` via `defineResource({ onFieldWriteDenied: 'strip' })`.
- **`multipartBody()` is a no-op for JSON requests** — safe to always add to create/update middleware.
- **`verifySignature(body, …)` throws `TypeError` if body isn't string/Buffer** — pass `req.rawBody`, not parsed body.

## Lifecycle

Arc's boot order is **fixed** (do not reorder; do not skip slots):

```
1. Arc core (security, auth, events)
2. plugins()                  ← infra (DB, SSE, docs)
3. bootstrap[]                ← domain init (engines, singletons)
4. resources factory (if any) ← resolved here — engine state is live
5. resources[]                ← register each, split by resourcePrefix / skipGlobalPrefix
6. afterResources()           ← post-registration wiring
7. onReady / onClose          ← Fastify lifecycle hooks
```

`resources` accepts an array OR a function (sync or async) that receives the Fastify instance and returns an array. The function form runs AFTER `bootstrap[]` — use it when a resource's adapter depends on an engine that boots asynchronously (`await ensureCatalogEngine()` / `await createFlowEngine()`). This is the **canonical answer** to "my repository lives in an async-booted engine"; before 2.11.x hosts wrote per-resource lazy-bridge adapters (boilerplate). Contract: explicit `resources` wins over `resourceDir` auto-discovery, including when the factory returns `[]`.

## Peer deps (never bundle)

| Peer | Min | Required? |
|------|-----|-----------|
| fastify | >=5.0.0 | **Yes** |
| @classytic/primitives | >=0.3.0 | **Yes** |
| @classytic/repo-core | >=0.3.1 | No |
| better-auth | >=1.6.2 | No |
| ioredis | >=5.0.0 | No |
| bullmq | >=5.0.0 | No |

**Removed in arc 2.12:** `@classytic/mongokit`, `@classytic/sqlitekit`, `mongoose`, `@prisma/client`. Every kit-specific adapter — Mongoose, Drizzle, AND Prisma — ships from its kit (`@classytic/mongokit/adapter@>=3.13.0`, `@classytic/sqlitekit/adapter@>=0.3.0`, `@classytic/prismakit/adapter@>=0.1.0`); hosts depend on the kit directly. The kit owns the driver peer. Custom kits implementing `DataAdapter<TDoc>` from `@classytic/repo-core/adapter` plug in identically.

`@classytic/repo-core@>=0.4.0` publishes the `MinimalRepo` / `StandardRepo` contract plus the canonical pagination, tenant, error, schema-generator, AND adapter contracts (`/adapter` subpath: `DataAdapter`, `RepositoryLike`, `AdapterRepositoryInput`, `AdapterFactory`, `OpenApiSchemas`, `SchemaMetadata`, `FieldMetadata`, `RelationMetadata`, `asRepositoryLike`, `isRepository`, ...). Hosts import those from repo-core directly — arc re-exports only `RepositoryLike`. See the gotcha under "Type conventions" above. `@classytic/primitives` owns the canonical event types (`EventMeta`, `DomainEvent`, `EventTransport`, `createEvent`, `createChildEvent`, `matchEventPattern`, ...); arc re-exports the runtime `MemoryEventTransport` only. `mergeFieldRuleConstraints` + `applyNullable` now live in `@classytic/repo-core/schema`. Arc 2.12 ships zero kit-specific adapters — any kit (mongokit, sqlitekit, prismakit, future pgkit, custom) plugs in via the `/adapter` subpath.

## Files

- [AGENTS.md](AGENTS.md) — deep guide (architecture, workflow, security checklist, glossary)
- [CHANGELOG.md](CHANGELOG.md) — release history + migration notes
- [v3.md](v3.md) — v3 design notes
- [wiki/](wiki/) — concept pages; loaded on demand
- [knip.config.ts](knip.config.ts) · [biome.json](biome.json) · [tsdown.config.ts](tsdown.config.ts) · [vitest.config.ts](vitest.config.ts)
