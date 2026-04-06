# CLAUDE.md — @classytic/arc Quick Reference

> **Full guide:** See [@file AGENTS.md](AGENTS.md) for architecture details, gotchas, test mapping, patterns, and security checklist.
> **v3 plans:** See [@file v3.md](v3.md) for design notes and migration path.

## Identity

**@classytic/arc** — Resource-oriented backend framework on Fastify.
One `defineResource()` → REST API + auth + permissions + events + caching + OpenAPI + MCP.

**v2.5.5** | Node.js 22+ | TypeScript 6+ | ESM-only | Fastify 5+ | 194 test files, 2788+ tests

## Commands

```bash
npx tsc --noEmit                                  # Typecheck
npx biome check src/ --diagnostic-level=error      # Lint (Biome only, no ESLint)
npx vitest run                                     # Full test suite
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
| `src/policies/*` | `npx vitest run tests/policies/ tests/security/policy-filter-*.test.ts` |
| `src/middleware/*` | `npx vitest run tests/middleware/` |
| `src/migrations/*` | `npx vitest run tests/migrations/` |
| `src/schemas/*` | `npx vitest run tests/schemas/` |
| `src/logger/*` | `npx vitest run tests/logger/` |
| `src/rpc/*` | `npx vitest run tests/rpc/` |

**Never run the full suite during dev** — use targeted tests. CI catches cross-cutting issues.

## Architecture (32 modules)

```
src/
  core/          — defineResource, BaseController (939L), QueryResolver, createCrudRouter
  factory/       — createApp (main entry point)
  adapters/      — RepositoryLike interface + mongoose/prisma adapters
  auth/          — JWT, Better Auth, sessions
  permissions/   — RBAC (989L), role hierarchy, field-level
  scope/         — RequestScope discriminated union
  events/        — EventPlugin, transports (memory, redis pub/sub, redis streams)
  hooks/         — HookSystem (724L), before/after lifecycle
  cache/         — QueryCache, stores, SWR
  plugins/       — health, tracing, requestId, response-cache, versioning, rate-limit, metrics, SSE
  policies/      — row-level security, field masking
  integrations/  — jobs (BullMQ), websocket, SSE, MCP, webhooks
  migrations/    — MigrationRunner + MigrationStore (DB-agnostic)
  cli/           — init (3434L), generate, doctor, describe, introspect, docs
  testing/       — HttpTestHarness, mocks, auth helpers
  docs/          — OpenAPI (924L), Scalar UI
  utils/         — queryParser, stateMachine, compensate, retry, circuitBreaker
  types/         — shared types (1443L), Fastify declaration merges
  schemas/       — JSON Schema from field rules
  pipeline/      — guard, pipe, intercept, transform
  middleware/    — request-level middleware
  org/           — organization plugin, membership
  audit/         — audit trail plugin + stores
  idempotency/   — idempotency plugin + stores
  context/       — async request context
  registry/      — resource registry, introspection
  discovery/     — dynamic resource loading
  dynamic/       — ArcDynamicLoader
  logger/        — injectable logger interface
  rpc/           — inter-service client
  presets/       — bulk, softDelete, ownedByUser, slugLookup, tree, multiTenant, audited
```

## Gotchas

1. `request.user` is `undefined` on public routes — always guard
2. `isRevoked` is fail-closed — errors = access denied (by design)
3. Redis Streams are at-least-once — handlers must be idempotent
4. `select` is never normalized to string — preserved as-is for DB agnosticism
5. Type-only subpaths (`./org/types`) produce `export {}` at runtime — correct
6. Event publishing is fire-and-forget (`failOpen: true`) — use outbox for guaranteed delivery
7. Presets compose but order matters — test combinations

## Peer Deps (never bundle)

| Peer | Min | Required? |
|------|-----|-----------|
| fastify | >=5.0.0 | **Yes** |
| @classytic/mongokit | >=3.5.0 | No |
| mongoose | >=9.0.0 | No |
| better-auth | >=1.5.5 | No |
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
