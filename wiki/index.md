# Wiki Index

One-line hooks per page. Load only what you need.

## Meta
- [identity](identity.md) — what arc is, philosophy, non-negotiable rules
- [architecture](architecture.md) — 29-module map, file sizes, what lives where
- [commands](commands.md) — typecheck, lint, test, build, release
- [peer-deps](peer-deps.md) — peer dep matrix, what's bundleable

## Core
- [core](core.md) — `defineResource`, `BaseController`, `QueryResolver`, `createCrudRouter`
- [factory](factory.md) — `createApp` entry point + resource loading
- [adapters](adapters.md) — adapter contract in repo-core; every kit (mongokit, sqlitekit, prismakit, custom) ships its adapter factory at `@classytic/<kit>/adapter`; arc 2.12 has zero kit-bound adapters
- [types](types.md) — `request.user`, generics, `unknown` defaults, `AnyRecord`

## Auth & permissions
- [auth](auth.md) — JWT, Better Auth, sessions, `isRevoked` fail-closed
- [permissions](permissions.md) — core/scope/dynamic split, combinators, field perms (incl. agent-auth: `requireDPoP`, `requireMandate`, `requireAgentScope`)
- [request-scope](request-scope.md) — `RequestScope` discriminated union + accessors (incl. `service.mandate` + `service.dpopJkt`)
- **Enterprise** — see [`skills/arc/references/{scim,agent-auth,enterprise-auth}.md`](../skills/arc/references/) for SCIM 2.0 + AP2 / x402 mandates + the in-vs-out matrix

## Runtime features
- [events](events.md) — `EventPlugin`, `EventMeta`, transports, outbox, DLQ
- [hooks](hooks.md) — `HookSystem` before/after lifecycle
- [cache](cache.md) — `QueryCache`, SWR, scope-aware keys
- [plugins](plugins.md) — built-in plugins + the onSend race rule (v2.10.2)
- [presets](presets.md) — bulk, softDelete, ownedByUser, multiTenant, etc.
- [mcp](mcp.md) — Model Context Protocol tool generation

## Quality
- [testing](testing.md) — test mapping, harness, never-run-full-suite rule
- [gotchas](gotchas.md) — numbered trap list (fail-closed, at-least-once, etc.)
- [security](security.md) — checklist when touching auth/perms/data

## API lifecycle
- [removed](removed.md) — APIs removed per version, with replacements (so agents don't reach for ghosts)

> **Release notes live elsewhere.** Wiki pages document how arc works *now*; for historical changes see [`/changelog/v2.md`](../changelog/v2.md) at the repo root, or the curated [`/CHANGELOG.md`](../CHANGELOG.md) entry pointer.
