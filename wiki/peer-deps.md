# Peer Dependencies

**Summary**: Every integration is an optional peer dep and never bundled. Only `fastify` is required.
**Sources**: package.json, tsdown.config.ts, AGENTS.md §9.
**Last updated**: 2026-04-21.

---

## Matrix

| Peer | Min | Required? | Used by |
|---|---|---|---|
| fastify | >=5.0.0 | **Yes** | Everything |
| @classytic/mongokit | >=3.10.2 | No | Recommended MongoDB adapter |
| @classytic/repo-core | >=0.1.0 | No | `RepositoryLike` base (v2.9.1) |
| @classytic/sqlitekit | >=0.1.0 | No | SQLite adapter |
| @classytic/streamline | >=2.0.0 | No | Streamline integration |
| mongoose | >=9.0.0 | No | Mongoose adapter |
| @prisma/client | >=5.0.0 | No | Prisma adapter |
| better-auth | >=1.6.2 | No | Better Auth integration |
| ioredis | >=5.0.0 | No | Redis events, cache, sessions |
| bullmq | >=5.0.0 | No | Job queue |
| @opentelemetry/* | various | No | Tracing plugin |

## Rules

- Never bundle peer deps. `tsdown.config.ts` → `deps.neverBundle` enforces at build.
- Add new peer? Also add to `knip.config.ts` `ignoreDependencies` and `optional-peers.d.ts` if ambient types needed.
- Arc imports peers with `import type` where runtime is optional, else lazy dynamic `import()`.

## Related
- [[adapters]] — pattern for adding a new DB peer
- [[identity]] — "optional peer deps, never bundled" rule
