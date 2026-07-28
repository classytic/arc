# Wiki Index

One-line hooks per page. Load only what you need.

## Meta
- [identity](identity.md) — what arc is, philosophy, non-negotiable rules
- [architecture](architecture.md) — module map, what lives where, heavy files
- [extension-decision](extension-decision.md) — WHICH extension seam for WHICH need: preset vs module vs plugin vs hook vs pipeline vs action vs adapter vs subscriber
- [commands](commands.md) — typecheck, lint, test, build, release
- [peer-deps](peer-deps.md) — peer dep matrix, what's bundleable

## Core
- [core](core.md) — `defineResource`, `BaseController`, `QueryResolver`, `createCrudRouter`
- [factory](factory.md) — `createApp` entry point + resource loading
- [modules](modules.md) — `defineModule` domain composition, typed exports (`getModuleExports`), self-describing arms (`eventHandlers` + `boundary`, `healthChecks`, `scheduledJobs`, `errorMappers`), thunk-lazy packs, no-DI-container thesis
- [engine-backed-resources](engine-backed-resources.md) — factory-export pattern for async-booted engines (catalog / flow / revenue / etc.)
- [adapters](adapters.md) — adapter contract in repo-core; every kit (mongokit, sqlitekit, prismakit, custom) ships its adapter factory at `@classytic/<kit>/adapter`; arc 2.12 has zero kit-bound adapters
- [types](types.md) — `request.user`, generics, `unknown` defaults, `AnyRecord`

## Auth & permissions
- [auth](auth.md) — JWT, Better Auth, sessions, `isRevoked` fail-closed
- [permissions](permissions.md) — decision contract (`allow`/`deny`, PDP/PEP), AND-composed kit-portable policy filters, fail-closed ownership, static `explainAccess`, core/scope/dynamic split, combinators, field perms (incl. agent-auth: `requireDPoP`, `requireMandate`, `requireAgentScope`)
- [request-scope](request-scope.md) — `RequestScope` discriminated union + accessors (incl. `service.mandate` + `service.dpopJkt`)
- **Enterprise** — see [`skills/arc/references/{scim,agent-auth,enterprise-auth}.md`](../skills/arc/references/) for SCIM 2.0 + AP2 / x402 mandates + the in-vs-out matrix

## Runtime features
- [events](events.md) — `EventPlugin`, `EventMeta`, transports, outbox, DLQ
- [delivery-guarantees](delivery-guarantees.md) — ONE matrix: ordering/durability/retries/dedup/backpressure/shutdown/multi-replica across memory, pub/sub, Streams, outbox, SSE, realtime, jobs, schedules, webhooks
- [hooks](hooks.md) — `HookSystem` before/after lifecycle, global hooks + `ctx.scope` identity
- [cache](cache.md) — `QueryCache`, SWR, scope-aware keys
- [plugins](plugins.md) — built-in plugins + the onSend race rule (v2.10.2)
- [encryption](encryption.md) — Application-Layer Encryption (ALE): full-body JWE (`jose`) or field-level AES-GCM, opted in via the `extensions` hatch
- [presets](presets.md) — bulk, softDelete, ownedByUser, multiTenant, etc.
- [mcp](mcp.md) — Model Context Protocol tool generation

## Quality
- [schema-pipeline](schema-pipeline.md) — how validation + OpenAPI/MCP schemas assemble; the 2.21 part-level precedence rule; which knob for which situation
- [testing](testing.md) — test mapping, harness, never-run-full-suite rule
- [gotchas](gotchas.md) — numbered trap list (fail-closed, at-least-once, etc.)
- [security](security.md) — checklist when touching auth/perms/data

## API lifecycle
- [removed](removed.md) — APIs removed per version, with replacements (so agents don't reach for ghosts)

## Records
Execution/decision records — point-in-time, not living docs.
- [record-dependson-completion](record-dependson-completion.md) — dependsOn module-ordering primitive, completion report (2.20, 2026-07-06)
- [record-ecosystem-extraction](record-ecosystem-extraction.md) — approval + involvement extraction to `arc-ecosystem` before the 2.20 publish (rationale + execution)

> **Release notes live elsewhere.** Wiki pages document how arc works *now*; for historical changes see [`/changelog/v2.md`](../changelog/v2.md) at the repo root, or the curated [`/CHANGELOG.md`](../CHANGELOG.md) entry pointer.
