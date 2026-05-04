# Peer Dependencies

**Summary**: Every integration is an optional peer dep and never bundled. Only `fastify` and `@classytic/primitives` are required. **Arc 2.12 is fully DB-agnostic** — every kit-specific adapter (Mongoose, Drizzle, Prisma) lives in its own kit, not arc. Arc consumes the adapter contract from `@classytic/repo-core/adapter`. Custom kits implementing `DataAdapter<TDoc>` plug in identically.
**Sources**: package.json, tsdown.config.ts, AGENTS.md §7.
**Last updated**: 2026-05-02.

---

## Matrix

| Peer | Min | Required? | Used by |
|---|---|---|---|
| fastify | >=5.0.0 | **Yes** | Everything |
| @classytic/primitives | >=0.3.0 | **Yes** | Canonical event types (`EventMeta`, `DomainEvent`, `EventTransport`, ...) |
| @classytic/repo-core | >=0.3.1 | No | `RepositoryLike`, adapter contract (`/adapter`), canonical pagination / tenant / errors / schema-generator contracts |
| @classytic/streamline | >=2.0.0 | No | Streamline integration |
| better-auth | >=1.6.2 | No | Better Auth integration |
| ioredis | >=5.0.0 | No | Redis events, cache, sessions |
| bullmq | >=5.0.0 | No | Job queue |
| @opentelemetry/* | various | No | Tracing plugin |

**Removed in arc 2.12:** `@classytic/mongokit`, `@classytic/sqlitekit`, `mongoose`, `@prisma/client`. Every kit-specific adapter lives on the kit side. Hosts depend on whichever kit they use (`@classytic/mongokit@>=3.13.0` for the Mongoose adapter, `@classytic/sqlitekit@>=0.3.0` for the Drizzle adapter, `@classytic/prismakit@>=0.1.0` for the Prisma adapter) and import from the kit's `/adapter` subpath. The kit owns the driver peer dep, not arc. Arc 2.12 has zero kit- or driver-bound peers.

## Rules

- Never bundle peer deps. `tsdown.config.ts` → `deps.neverBundle` enforces at build.
- Add new peer? Also add to `knip.config.ts` `ignoreDependencies` and `optional-peers.d.ts` if ambient types needed.
- Arc imports peers with `import type` where runtime is optional, else lazy dynamic `import()`.

## Related
- [[adapters]] — pattern for adding a new DB peer
- [[identity]] — "optional peer deps, never bundled" rule
