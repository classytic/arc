# Architecture

**Summary**: Map of the 29 `src/` modules and where functionality lives.
**Sources**: src/, AGENTS.md §2.
**Last updated**: 2026-04-21.

---

## Module map

```
src/
  core/          defineResource, BaseController, QueryResolver, createCrudRouter, routes, actions  → [[core]]
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
  org/           organizationPlugin, orgMembership, org types
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
| `src/core/BaseController.ts` | ~1,440 | AccessControl + BodySanitizer + QueryResolver |
| `src/docs/openapi.ts` | ~920 | Spec gen |
| `src/hooks/HookSystem.ts` | ~720 | Lifecycle |
| `src/permissions/dynamic.ts` | ~480 | Runtime matrix + cache + cross-node invalidation |

## Related
- [[core]] — `defineResource` is the fundamental unit everything else composes onto
- [[testing]] — which tests cover which module
