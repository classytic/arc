# Architecture

**Summary**: Map of the `src/` modules and where functionality lives.
**Sources**: src/, AGENTS.md §2.
**Last updated**: 2026-07-17 (dropped stale `adapters/` row + line-count table — 2.23 audit).

---

## Module map

```
src/
  core/          defineResource, BaseController, QueryResolver, createCrudRouter, routes, actions  → [[core]]
    middlewares/ auth/permission/pipeline/rate-limit/field-write preHandler assembly (routerShared re-exports)
    crud/        pure CRUD helpers — requestPipeline (repo-options, hooks, cache), resourceVerbs (count/distinct/exists)
  factory/       createApp — main entry point                                                      → [[factory]]
    types/       CreateAppOptions split (2.22) — app-options, auth, security, plugin-options; index barrel
  auth/          authPlugin (JWT), betterAuth adapter, sessionManager, redis-session              → [[auth]]
  permissions/   core + scope + dynamic + fields + presets + roleHierarchy                        → [[permissions]]
  scope/         RequestScope discriminated union + accessors                                     → [[request-scope]]
  events/        EventPlugin, transports (memory, redis pub/sub, redis streams), outbox           → [[events]]
  hooks/         HookSystem — before/after lifecycle                                              → [[hooks]]
  cache/         QueryCache, query-cache plugin, scope-aware keys, SWR                            → [[cache]]
  plugins/       health, tracing, requestId, response-cache, versioning, rate-limit, metrics, SSE, realtime → [[plugins]]
  integrations/  jobs (BullMQ), streamline, websocket, SSE, MCP, webhooks
    mcp/         createMcpServer, resourceToTools, defineTool, definePrompt, sessionCache         → [[mcp]]
  migrations/    MigrationRunner + MigrationStore interface (DB-agnostic)
  cli/           arc init, generate, doctor, describe, introspect, docs
  testing/       HttpTestHarness, mock helpers, createJwtAuthProvider, dbHelpers                  → [[testing]]
  docs/          OpenAPI spec generator, Scalar UI, externalPaths
  utils/         queryParser, stateMachine, compensate, retry, circuitBreaker, schemaConverter
  types/         shared type defs, Fastify declaration merges                                     → [[types]]
    resource/    ResourceConfig split (2.22) — config, routes, schemas, fields, hooks, actions, extensions, tenant, cache, presets, events, rate-limit; index barrel
  schemas/       JSON Schema generation from field rules
  pipeline/      guard, pipe, intercept, transform — execution pipeline stages
  middleware/    request-level middleware, multipartBody (file upload)
  audit/         auditPlugin, store interface + memory + repository adapter
  usage/         usagePlugin (2.22) — per-actor per-period counters; UsageStore + MemoryUsageStore → [[plugins]]
  idempotency/   idempotencyPlugin, MongoDB + Redis stores
  context/       async request context (AsyncLocalStorage)
  registry/      resource registry, introspection plugin
  discovery/     filesystem auto-discovery (also factory/loadResources)
  logger/        injectable logger interface
  presets/       bulk, softDelete, ownedByUser, slugLookup, tree, multiTenant, audited, search, files-upload → [[presets]]
```

**No `src/adapters/`** — removed in 2.12. The adapter contract lives in `@classytic/repo-core/adapter`; every kit-specific adapter ships from its kit (`@classytic/<kit>/adapter`) → [[adapters]].

## Heavy files (know before changing)

Exact line counts rot fast — run `find src -name "*.ts" | xargs wc -l | sort -rn | head` for current numbers. Files that stay dense by design:

- `src/integrations/streamline.ts` — largest single module
- `src/events/outbox.ts` — outbox relay + lease/claim semantics
- `src/core/BaseCrudController.ts` — CRUD orchestration; pure helpers extracted to `core/crud/`
- `src/events/transports/redis-stream.ts` — Streams consumer (PEL reclaim, DLQ, jittered backoff)
- `src/factory/types/app-options.ts` — CreateAppOptions surface
- `src/auth/betterAuth.ts`, `src/integrations/jobs.ts`, `src/hooks/HookSystem.ts`
- `src/cli/commands/init/` — scaffolding split across modules (was one ~3.4k-line file)

`src/core/routerShared.ts` is a thin re-export shim over `core/middlewares/`; `aggregation/validate.ts` split into `validate.ts` (checks) + `normalize.ts` (pure IR); `defineResource` Phase-0 shorthands live in `defineResource/normalizeConfig.ts`. The two mega type files split in 2.22 with exact-parity `index.ts` barrels (public surface unchanged): `src/types/resource.ts` → `src/types/resource/`, `src/factory/types.ts` → `src/factory/types/` (trees above). `src/docs/openapi.ts` is a 17-line barrel over `docs/openapi/`.

## Related
- [[core]] — `defineResource` is the fundamental unit everything else composes onto
- [[testing]] — which tests cover which module
