# CLAUDE.md — @classytic/arc

Loaded every session. Every line must earn its place.

## Where a fact lives — ONE place each

| File | Owns | Budget |
|---|---|---|
| **CLAUDE.md** (this) | commands, non-negotiables, type conventions, peers, test map, gotchas | ≤150 lines |
| [AGENTS.md](AGENTS.md) | architecture, testing standard, security checklist, adding a new X | ≤120 lines |
| [wiki/](wiki/index.md) | **agent-facing** concept pages — internals, contracts, invariants | ≤150 lines/page |
| [docs/](docs/) | **host-facing** guides (published site) — usage, never internals | n/a |
| [changelog/v2.md](changelog/v2.md) | what changed and why, per release | n/a |
| [CHANGELOG.md](CHANGELOG.md) | index only — one line per minor | ≤4KB |
| [wiki/log.md](wiki/log.md) | recent decisions — a recency signal | ~10 entries, ≤150 chars each |

**Never restate a fact another file owns — link to it.** These files load into context; duplication is paid on every session forever, and two copies drift.

**No rotting metrics anywhere**: line counts, test counts, file sizes, "N tests green". They are wrong within a release and teach nothing.

After a change that invalidates a wiki page: edit the page, update the index if pages moved, add ONE line to `wiki/log.md` (drop the oldest). Detail goes in `changelog/v2.md`, not the log.

**v3 design:** [v3.md](v3.md)

## What arc is

Resource-oriented backend framework on Fastify. One `defineResource()` call → REST API + auth + permissions + events + caching + OpenAPI + MCP tools. Node.js 22+, TypeScript strict, ESM-only, Fastify 5+.

## Commands

```bash
npm run typecheck                                 # Typecheck BOTH lanes (src + tests/types via tsconfig.types.json)
npx biome check src/ --diagnostic-level=error     # Lint (Biome, no ESLint/Prettier)
npx vitest run tests/path/to/file.test.ts         # Targeted test — preferred during dev
npm run test:main                                 # Main suite (excludes perf; ws files auto-serialized via vitest projects)
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
- **No DB driver imports anywhere in arc** (enforced by `check:boundaries`; a lazy `await import()` behind an injectable port may be allowlisted in `LAZY_DRIVER_ALLOWED` with a reason) — kit-specific adapters live in their kits (`@classytic/<kit>/adapter`). arc is DB-agnostic.
- **No `any`** — use `unknown`; `as unknown as X` is a last resort, not a shortcut.
- **No `@ts-ignore`** — fix the type.
- **No default exports** — named exports only (knip enforces). **Documented exception**: Fastify plugin entry files MAY `export default fp(plugin, …)` so `app.register(import('@classytic/arc/<subpath>'))` resolves via Node's import-default semantics. The exception is the *class* of `fp()`-wrapped plugin entries (auth, audit, events, plugins/*, scope/elevation, scim, docs, registry, idempotency, webhooks, core/arcCorePlugin — grep `export default fp` for the authoritative list), not a fixed name list. Each of those files ALSO ships a named export for hosts that prefer named imports. Non-plugin code follows the rule strictly.
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
| `src/usage/*` | `npx vitest run tests/usage/` |
| `src/testing/*` | `npx vitest run tests/testing/` |
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
0. beforeBoot()               ← pre-everything (DB connect; runs before module
                                thunks resolve and before Fastify exists) — 2.21
0.5 module graph resolve      ← thunks import + topo-sort (pure; fail-fast);
                                module errorMappers merge into the error handler
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
| fastify | >=5.8.5 | **Yes** |
| @classytic/primitives | >=0.21.0 | **Yes** |
| @classytic/repo-core | >=0.17.0 | **Yes** |
| better-auth | >=1.6.2 | No |
| ioredis | >=5.0.0 | No |
| bullmq | >=5.0.0 | No |

**Removed in arc 2.12:** `@classytic/mongokit`, `@classytic/sqlitekit`, `mongoose`, `@prisma/client`. Every kit-specific adapter — Mongoose, Drizzle, AND Prisma — ships from its kit (`@classytic/mongokit/adapter@>=3.13.0`, `@classytic/sqlitekit/adapter@>=0.3.0`, `@classytic/prismakit/adapter@>=0.1.0`); hosts depend on the kit directly. The kit owns the driver peer. Custom kits implementing `DataAdapter<TDoc>` from `@classytic/repo-core/adapter` plug in identically.

`@classytic/repo-core@>=0.4.0` publishes the `MinimalRepo` / `StandardRepo` contract plus the canonical pagination, tenant, error, schema-generator, AND adapter contracts (`/adapter` subpath: `DataAdapter`, `RepositoryLike`, `AdapterRepositoryInput`, `AdapterFactory`, `OpenApiSchemas`, `SchemaMetadata`, `FieldMetadata`, `RelationMetadata`, `asRepositoryLike`, `isRepository`, ...). Hosts import those from repo-core directly — arc re-exports only `RepositoryLike`. See the gotcha under "Type conventions" above. `@classytic/primitives` owns the canonical event types (`EventMeta`, `DomainEvent`, `EventTransport`, `createEvent`, `createChildEvent`, `matchEventPattern`, ...) AND the outbox contract (`@classytic/primitives/outbox` >=0.14: `OutboxStore`, option types, `OutboxOwnershipError`, `InvalidOutboxEventError` — arc 2.24 removed its duplicate/re-export; import from primitives). `EventTransport.subscribe` is OPTIONAL as of primitives 0.14 (publish-only transports) — arc's `eventPlugin` subscribe path guards it (`typeof transport.subscribe !== 'function'` → clear error / `failOpen` no-op). Ownership rule: primitives owns pure cross-package contracts, arc owns runtime (`EventOutbox`, `MemoryOutboxStore`, `repositoryAsOutboxStore`, `exponentialBackoff`) — arc re-exports the runtime `MemoryEventTransport` only. `mergeFieldRuleConstraints` + `applyNullable` now live in `@classytic/repo-core/schema`. Arc 2.12 ships zero kit-specific adapters — any kit (mongokit, sqlitekit, prismakit, pgkit, custom) plugs in via the `/adapter` subpath.

## Files

- [AGENTS.md](AGENTS.md) — deep guide (architecture, workflow, security checklist, glossary)
- [CHANGELOG.md](CHANGELOG.md) — release history + migration notes
- [v3.md](v3.md) — v3 design notes
- [wiki/](wiki/) — concept pages; loaded on demand
- [skills/](skills/) — ONLY arc's own skills: `arc`, `arc-code-review`, `arc-module-publishing`, shipped in the npm package (`files`). Third-party skills (`better-auth-best-practices`, `fastify-best-practices`, `visa-best-practices`, ...) never go here — they live as junctions in `.claude/skills/` pointing into `.agents/skills/` (managed by `npx skills`, pinned in `skills-lock.json`).
- [knip.config.ts](knip.config.ts) · [biome.json](biome.json) · [tsdown.config.ts](tsdown.config.ts) · [vitest.config.ts](vitest.config.ts)
