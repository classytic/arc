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
- [adapters](adapters.md) — `RepositoryLike` contract, DB-agnosticism rule
- [types](types.md) — `request.user`, generics, `unknown` defaults, `AnyRecord`

## Auth & permissions
- [auth](auth.md) — JWT, Better Auth, sessions, `isRevoked` fail-closed
- [permissions](permissions.md) — core/scope/dynamic split, combinators, field perms
- [request-scope](request-scope.md) — `RequestScope` discriminated union + accessors

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

## History
- [changelog-v2.10](changelog-v2.10.md) — permissions split, plugin onSend fix, repo adapters
- [changelog-v2.9](changelog-v2.9.md) — event contract v2, outbox, multiTenant UPDATE fix
- [removed](removed.md) — APIs removed per version, with replacements
