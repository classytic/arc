# CLAUDE.md — Agent Context for @classytic/arc

## What is Arc

Arc is a **resource-oriented backend framework** built on Fastify. It turns resource definitions into production-ready REST APIs with auth, permissions, events, caching, OpenAPI docs, and MCP (AI tool) generation.

**Version:** 2.4.0
**Runtime:** Node.js 22+ (ESM-only)
**Language:** TypeScript 6+
**Build:** tsdown (not tsc, not esbuild directly)
**Test:** Vitest + mongodb-memory-server
**Lint:** Biome (not ESLint, not Prettier)
**Package manager:** npm (lockfile committed)

## Core Philosophy

1. **Resource-oriented** — everything is a `defineResource()`. CRUD, schemas, auth, permissions, hooks, events all hang off the resource definition.
2. **DB-agnostic** — Arc never imports mongoose, prisma, or any database directly. Adapters implement `RepositoryLike`. MongoKit is the recommended adapter but is an optional peer dep.
3. **Primitives not opinions** — Arc provides building blocks (outbox, hooks, role hierarchy, scope). It does NOT provide workflow engines, saga orchestrators, or email senders. Those are app-level or use Streamline/Temporal.
4. **Optional peer deps, never bundled** — Every integration (mongoose, better-auth, ioredis, bullmq, @opentelemetry/*) is an optional peer dep. Arc's dist must never force-install anything.
5. **Tree-shakable** — 88+ subpath exports. Users import `@classytic/arc/factory`, `@classytic/arc/auth`, etc. Never import from the root barrel in production code.
6. **No hardcoding** — Different users use different databases, auth systems, message brokers, and deployment targets. Arc must not assume any specific ecosystem.
7. **No console.log in runtime** — Use `fastify.log.warn/info/error` or injectable logger interfaces. CLI commands may use `process.stdout.write`.

## Architecture

```
src/
  core/          — defineResource, BaseController, QueryResolver, createCrudRouter
  factory/       — createApp (the main entry point users call)
  adapters/      — RepositoryLike interface + mongoose/prisma adapters
  auth/          — authPlugin (JWT), betterAuth adapter, sessionManager
  permissions/   — RBAC, role hierarchy, field-level permissions
  scope/         — RequestScope discriminated union (public|authenticated|member|elevated)
  events/        — EventPlugin, transports (memory, redis pub/sub, redis streams)
  hooks/         — HookSystem (before/after lifecycle on resources)
  cache/         — QueryCache (adapter-backed query result caching)
  plugins/       — health, tracing, requestId, response-cache, versioning, rate-limit
  policies/      — PolicyInterface (row-level security, field masking)
  integrations/  — jobs (BullMQ), streamline, websocket, SSE, MCP
  migrations/    — MigrationRunner + MigrationStore interface (DB-agnostic)
  cli/           — arc init, generate, doctor, describe, introspect, docs
  testing/       — HttpTestHarness, mock helpers, createJwtAuthProvider
  docs/          — OpenAPI spec generator, Scalar UI
  utils/         — queryParser, stateMachine, compensate, retry, circuitBreaker
  types/         — shared type definitions, Fastify declaration merges
```

## Key Conventions

### Types
- `request.user` is `Record<string, unknown> | undefined` (not optional property — matches @fastify/jwt's required declaration)
- `RequestScope` is a discriminated union on `kind`: public | authenticated | member | elevated
- All scopes carry `userId?: string` and `userRoles?: string[]`
- Use `getUserId(scope)` and `getUserRoles(scope)` accessors, not direct property access

### Generics & `unknown` Defaults
- `BaseController<TDoc = AnyRecord>`, `MongooseAdapter<TDoc = unknown>`, `createMongooseAdapter<TDoc = unknown>` all default to `unknown`/`AnyRecord`
- **This is intentional** — `TDoc` is auto-inferred from the Mongoose `Model<T>` argument. The `unknown` default only applies when no inference is possible, which forces the developer to narrow (safer than `any`)
- **Never replace `unknown` with `any`** — it breaks type safety downstream
- Mongoose 9 `InferSchemaType<typeof schema>` works with Arc automatically: `mongoose.model('P', schema)` creates `Model<Inferred>`, Arc infers `TDoc` from it
- `RepositoryLike` returns `Promise<unknown>` intentionally — it's the minimum contract. `BaseController` casts internally. Developers never call `RepositoryLike` methods directly
- `RepositoryLike` has 5 required methods + optional `getOne` (for AccessControl compound queries) + optional preset methods (bulk, softDelete, tree, slugLookup). See `src/adapters/interface.ts` for the full interface with JSDoc

### QueryResolver
- Accepts any query parser output (MongoKit, Arc built-in, custom)
- `select` is preserved in its original format (string, array, or object projection) — never forced to string
- `allowedPopulate` and `allowedLookups` on RouteSchemaOptions control what users can query
- `lookups` map to `$lookup` in MongoDB or `JOIN` in SQL — DB-agnostic interface

### Events
- Redis Streams transport is **at-least-once** (not exactly-once)
- Event publishing defaults to fire-and-forget (`failOpen: true`)
- Outbox pattern available for guaranteed delivery
- Cleanup is the user's responsibility (TTL index, cron job, etc.)

### Auth
- `isRevoked` on JwtAuthOption — fail-closed (errors = revoked)
- `tokenExtractor` for custom token sources (cookies, headers)
- Better Auth adapter bridges Fetch API ↔ Fastify
- `request.user` is undefined on public routes — always guard with `if (request.user)`

### MCP Integration
- `resourceToTools()` generates CRUD tool definitions from resource definitions
- Tools are security-scoped via auth bridge and guards
- Schema validation uses Zod generated from field rules

### CLI
- `arc doctor` is CLI tooling, not a runtime module. Primary: `npx @classytic/arc doctor`. Secondary: `import { doctor } from '@classytic/arc/cli'`
- `arc init` scaffolds full project with env validation, auth, and resource examples
- `arc generate resource <name>` creates model, repo, controller, schemas, resource files

## What NOT to do

- **Don't add console.log** to any file in `src/` outside `cli/`. Use logger injection.
- **Don't import mongoose/prisma** in core modules. Only in adapter files.
- **Don't add features "just in case"** — no speculative abstractions.
- **Don't create Dockerfile, Helm charts, or K8s manifests** — those are app-level.
- **Don't make Arc an ESM+CJS dual package** — it's ESM-only, intentionally.
- **Don't add `@ts-ignore`** — fix the type instead.
- **Don't bundle optional peer deps** — check `tsdown.config.ts` `deps.neverBundle`.
- **Don't use enums** — use `as const` objects or string literal unions.
- **Don't add features that belong in Streamline/Temporal** (saga orchestration, durable workflows).

## Testing

- **Unit tests** go in `tests/<module>/` mirroring `src/<module>/`
- **E2E tests** go in `tests/e2e/` — full Fastify + in-memory MongoDB
- **MCP tests** go in `tests/integrations/mcp/`
- Always use `mongodb-memory-server` for MongoDB tests — never a real DB
- OTel tests use `describe.skip` when `@opentelemetry/api` is not installed
- Run: `npx vitest run` (all), `npx vitest run tests/path` (specific)
- Current: 161 files, 2378 passed, 4 skipped, 0 failures

## Build & Publish

- `npm run build` → tsdown (output to `dist/`)
- `npm run typecheck` → `tsc --noEmit`
- `npm run lint` → `biome check src/` (Biome only — no ESLint, no Prettier)
- `npm run smoke` → `node scripts/smoke-test.mjs` (checks dist artifacts, CLI, imports)
- `npx knip` → dead code detection (config in `knip.config.ts`)
- `prepublishOnly` gates: typecheck → test → build → smoke
- Version is injected at build time via `tsdown.config.ts` define: `__ARC_VERSION__`

### Pre-publish checklist (run in order)

1. `npx tsc --noEmit` — zero type errors
2. `npx biome check src/ --diagnostic-level=error` — zero lint errors
3. `npx vitest run` — all tests pass
4. `npx knip` — review unused exports, no new dead code
5. `npm run build` — dist/ output clean (166 files)
6. Verify all 46 subpath exports resolve:
   - Every `package.json` exports entry has matching `.mjs` + `.d.mts` in `dist/`
   - Type-only subpaths (`./org/types`, `./integrations`) produce `export {}` at runtime — this is correct (interfaces erased)
   - `./testing` requires Vitest runtime — cannot be imported outside tests
7. `npm run smoke` — CLI works, critical imports resolve
8. `npx knip` reports only intentional public API (adapter types, consumer utilities)

## Skills & Documentation

- **Skills directory:** `skills/arc/` (in the repo, NOT in `~/.claude/skills/`)
- **Nextra docs:** `docs/` (getting-started, production-ops, framework-extension, ecosystem, testing)
- **Skill references:** `skills/arc/references/` (auth.md, production.md, integrations.md, events.md, mcp.md)
- Skills are installed via `npx skills add classytic/arc`

## Peer Dependencies (minimum versions)

| Peer | Min Version | Required? |
|------|-------------|-----------|
| fastify | >=5.0.0 | Yes |
| @classytic/mongokit | >=3.5.0 | No (recommended) |
| better-auth | >=1.5.5 | No |
| @classytic/streamline | >=2.0.0 | No |
| ioredis | >=5.0.0 | No |
| bullmq | >=5.0.0 | No |
| mongoose | >=9.0.0 | No |
| @prisma/client | >=5.0.0 | No |
