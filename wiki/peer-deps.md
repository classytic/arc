# Peer Dependencies

**Summary**: Every integration is an optional peer dep and never bundled. `fastify`, `@classytic/primitives`, and `@classytic/repo-core` are required (arc imports the adapter / pagination / tenant / errors contracts from repo-core at runtime). Arc is fully DB-agnostic — every kit-specific adapter (Mongoose, Drizzle, Prisma) lives in its own kit, not arc. Arc consumes the adapter contract from `@classytic/repo-core/adapter`. Custom kits implementing `DataAdapter<TDoc>` plug in identically.
**Sources**: package.json, tsdown.config.ts, AGENTS.md §7.
**Last updated**: 2026-07-13 (floors synced to package.json — 2.20/2.21 bumps).

---

## Matrix

| Peer | Min | Required? | Used by |
|---|---|---|---|
| fastify | ^5.8.5 | **Yes** | Everything |
| @classytic/primitives | >=0.9.0 | **Yes** | Canonical event types (`EventMeta`, `DomainEvent`, `EventTransport`, ...) |
| @classytic/repo-core | >=0.14.0 | **Yes** | `RepositoryLike`, adapter contract (`/adapter`), canonical pagination / tenant / errors / schema-generator contracts |
| @classytic/streamline | >=2.7.0 | No | Streamline integration |
| better-auth | >=1.6.2 | No | Better Auth integration |
| ioredis | >=5.0.0 | No | Redis events, cache, sessions |
| bullmq | >=5.0.0 | No | Job queue |
| @opentelemetry/* | various | No | Tracing plugin |

**Kit-specific adapters live on the kit side.** Hosts depend on whichever kit they use (`@classytic/mongokit@>=3.21.0` for Mongoose — 3.21 defaults the adapter's `schemaGenerator`, `@classytic/sqlitekit@>=0.7.0` for Drizzle, `@classytic/prismakit` for Prisma) and import from the kit's `/adapter` subpath. The kit owns the driver peer dep, not arc. Arc has zero kit- or driver-bound peers.

## Rules

- Never bundle peer deps. `tsdown.config.ts` → `deps.neverBundle` enforces at build.
- Add new peer? Also add to `knip.config.ts` `ignoreDependencies` and `optional-peers.d.ts` if ambient types needed.
- Arc imports peers with `import type` where runtime is optional, else lazy dynamic `import()`.

## Related
- [[adapters]] — pattern for adding a new DB peer
- [[identity]] — "optional peer deps, never bundled" rule
