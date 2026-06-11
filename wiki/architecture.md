# Architecture

**Summary**: Map of the 29 `src/` modules and where functionality lives.
**Sources**: src/, AGENTS.md §2.
**Last updated**: 2026-06-11.

---

## Module map

```
src/
  core/          defineResource, BaseController, QueryResolver, createCrudRouter, routes, actions  → [[core]]
    middlewares/ auth/permission/pipeline/rate-limit/field-write preHandler assembly (routerShared re-exports)
    crud/        pure CRUD helpers — requestPipeline (repo-options, hooks, cache), resourceVerbs (count/distinct/exists)
  factory/       createApp — main entry point                                                      → [[factory]]
  adapters/      RepositoryLike interface + mongoose/prisma adapters                               → [[adapters]]
  auth/          authPlugin (JWT), betterAuth adapter, sessionManager, redis-session              → [[auth]]
  permissions/   core + scope + dynamic + fields + presets + roleHierarchy                        → [[permissions]]
  scope/         RequestScope discriminated union + accessors                                     → [[request-scope]]
  events/        EventPlugin, transports (memory, redis pub/sub, redis streams), outbox           → [[events]]
  hooks/         HookSystem — before/after lifecycle                                              → [[hooks]]
  cache/         QueryCache, query-cache plugin, scope-aware keys, SWR                            → [[cache]]
  plugins/       health, tracing, requestId, response-cache, versioning, rate-limit, metrics, SSE → [[plugins]]
  integrations/  jobs (BullMQ), streamline, websocket, SSE, MCP, webhooks
    mcp/         createMcpServer, resourceToTools, defineTool, definePrompt, sessionCache         → [[mcp]]
  migrations/    MigrationRunner + MigrationStore interface (DB-agnostic)
  cli/           arc init, generate, doctor, describe, introspect, docs
  testing/       HttpTestHarness, mock helpers, createJwtAuthProvider, dbHelpers                  → [[testing]]
  docs/          OpenAPI spec generator, Scalar UI, externalPaths
  utils/         queryParser, stateMachine, compensate, retry, circuitBreaker, schemaConverter
  types/         shared type defs, Fastify declaration merges                                     → [[types]]
  schemas/       JSON Schema generation from field rules
  pipeline/      guard, pipe, intercept, transform — execution pipeline stages
  middleware/    request-level middleware, multipartBody (file upload)
  audit/         auditPlugin, store interface + memory + repository adapter
  idempotency/   idempotencyPlugin, MongoDB + Redis stores
  context/       async request context (AsyncLocalStorage)
  registry/      resource registry, introspection plugin
  discovery/     filesystem auto-discovery (also factory/loadResources)
  logger/        injectable logger interface
  presets/       bulk, softDelete, ownedByUser, slugLookup, tree, multiTenant, audited, search, files-upload → [[presets]]
```

## Heavy files (know before changing)

| File | Lines | Notes |
|---|---|---|
| `src/cli/commands/init.ts` | ~3,400 | Scaffolding; intentionally monolithic |
| `src/types/index.ts` | ~1,650 | Shared type defs (split planned v2.11) |
| `src/core/BaseCrudController.ts` | ~960 | CRUD orchestration; pure helpers extracted to `core/crud/` (2026-06) |
| `src/events/outbox.ts` | ~910 | Outbox relay + lease/claim semantics |
| `src/docs/openapi.ts` | ~920 | Spec gen |
| `src/events/transports/redis-stream.ts` | ~800 | Streams consumer (PEL reclaim, DLQ, jittered backoff) |
| `src/hooks/HookSystem.ts` | ~720 | Lifecycle |
| `src/permissions/dynamic.ts` | ~480 | Runtime matrix + cache + cross-node invalidation |

`src/core/routerShared.ts` is now a 65-line re-export shim over `core/middlewares/`; `aggregation/validate.ts` split into `validate.ts` (checks) + `normalize.ts` (pure IR); `defineResource` Phase-0 shorthands live in `defineResource/normalizeConfig.ts`.

## Related
- [[core]] — `defineResource` is the fundamental unit everything else composes onto
- [[testing]] — which tests cover which module
