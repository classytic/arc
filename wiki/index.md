# Wiki Index

**For agents.** Concept pages = how arc works *now* (internals, contracts, invariants). Host-facing usage lives in [`docs/`](../docs/) and is not duplicated here.

Load only what you need. Hooks below are routing labels, not summaries.

## Meta
- [identity](identity.md) — what arc is, philosophy, non-negotiable rules
- [architecture](architecture.md) — module map, layering, what lives where
- [extension-decision](extension-decision.md) — WHICH seam for which need (preset/module/plugin/hook/action/adapter)
- [commands](commands.md) — typecheck, lint, test, build, release
- [peer-deps](peer-deps.md) — peer matrix, what may be bundled

## Core
- [core](core.md) — `defineResource`, `BaseController`, `QueryResolver`, `createCrudRouter`
- [factory](factory.md) — `createApp`, boot order, resource loading
- [modules](modules.md) — `defineModule`, transactional boot + rollback, `defer` disposers, `owns`
- [engine-backed-resources](engine-backed-resources.md) — factory-export pattern for async-booted engines
- [adapters](adapters.md) — adapter contract in repo-core; every kit ships its own factory
- [types](types.md) — `request.user`, generics, `unknown` defaults, `AnyRecord`

## Auth & permissions
- [auth](auth.md) — JWT, Better Auth, sessions, `isRevoked` fail-closed
- [permissions](permissions.md) — decision contract (PDP/PEP), policy filters, field perms
- [request-scope](request-scope.md) — `RequestScope` union + accessors
- Enterprise (SCIM, AP2/x402 mandates) — [`skills/arc/references/`](../skills/arc/references/)

## Runtime
- [events](events.md) — `EventPlugin`, transports, outbox, DLQ
- [delivery-guarantees](delivery-guarantees.md) — ONE matrix across every async channel
- [hooks](hooks.md) — before/after lifecycle, global hooks, `ctx.scope` identity
- [cache](cache.md) — `QueryCache`, SWR, scope-aware keys
- [plugins](plugins.md) — built-ins + the `onSend` header race rule
- [encryption](encryption.md) — JWE body / field-level AES-GCM via the `extensions` hatch
- [presets](presets.md) — bulk, softDelete, ownedByUser, multiTenant, …
- [mcp](mcp.md) — MCP tool generation; enforces the same chain as REST
- [static-assets](static-assets.md) — `assets` roots, the CORP trap, per-route CORS

## Quality
- [schema-pipeline](schema-pipeline.md) — how validation + OpenAPI/MCP schemas assemble
- [testing](testing.md) — test map, harness, async-wait standard
- [gotchas](gotchas.md) — numbered trap list
- [security](security.md) — checklist when touching auth/perms/data
- [removed](removed.md) — removed APIs + replacements, so agents don't reach for ghosts

Release history: [`changelog/v2.md`](../changelog/v2.md). Recent decisions: [log](log.md).
