# Peer Dependencies

**Summary**: Every integration is an optional peer dep and never bundled. `fastify`, `@classytic/primitives`, and `@classytic/repo-core` are required (arc imports the adapter / pagination / tenant / errors contracts from repo-core at runtime). Arc is fully DB-agnostic — every kit-specific adapter (Mongoose, Drizzle, Prisma) lives in its own kit, not arc. Arc consumes the adapter contract from `@classytic/repo-core/adapter`. Custom kits implementing `DataAdapter<TDoc>` plug in identically.
**Sources**: package.json, tsdown.config.ts, AGENTS.md §7.
**Last updated**: 2026-07-29 (zod floor >=4.4.0; input/output schema direction).

---

## Matrix

| Peer | Min | Required? | Used by |
|---|---|---|---|
| fastify | >=5.8.5 | **Yes** | Everything |
| @classytic/primitives | >=0.18.0 | **Yes** | Canonical event types (`EventMeta`, `DomainEvent`, `EventTransport` — `subscribe` optional as of 0.14) + outbox contract; **0.15 floor**: `/canonical` + `/retention` subpaths the cleanup framework imports (absent in 0.14 → `ERR_PACKAGE_PATH_NOT_EXPORTED`); **0.18 floor**: `OutboxStore.transactionalSave` — arc's repository outbox adapter declares the capability flag, and it is absent from published 0.16.0 (arc's source needed a version above its own declared floor; caught when a clean install downgraded the cp-dist copy) |
| @classytic/repo-core | >=0.17.0 | **Yes** | `RepositoryLike`, adapter contract (`/adapter`), canonical pagination / tenant / errors / schema-generator contracts; **0.17 floor**: `/cleanup` step contract (`CleanupStep`) |
| @classytic/streamline | >=2.8.0 | No | Streamline integration |
| better-auth | >=1.6.2 | No | Better Auth integration |
| ioredis | >=5.0.0 | No | Redis events, cache, sessions |
| bullmq | >=5.0.0 | No | Job queue |
| @opentelemetry/* | various | No | Tracing plugin |
| @fastify/static | >=8.0.0 | No | `assets` roots — arc supplies header policy (per-prefix CORP, cache preset, disposition) and delegates ranges / ETag / immutable / pre-compressed variants to the plugin |
| zod | >=4.4.0 | No | Zod→JSON Schema conversion (`z.toJSONSchema()`) for route validation, OpenAPI + MCP. **4.4 floor**: arc's own code runs on 4.0, but 4.4 carries three fixes arc's output depends on — a stack overflow on recursive `.lazy()` + `.describe()` (#5797), min/max intersections on the `openapi-3.0` target arc emits (#5700), and object/tuple optionality alignment (#5661) that the input/output split relies on |

**Kit-specific adapters live on the kit side.** Hosts depend on whichever kit they use (`@classytic/mongokit@>=3.21.0` for Mongoose — 3.21 defaults the adapter's `schemaGenerator`, `@classytic/sqlitekit@>=0.7.0` for Drizzle, `@classytic/prismakit` for Prisma) and import from the kit's `/adapter` subpath. The kit owns the driver peer dep, not arc. Arc has zero kit- or driver-bound peers.

## Rules

- Never bundle peer deps. `tsdown.config.ts` → `deps.neverBundle` enforces at build.
- Add new peer? Also add to `knip.config.ts` `ignoreDependencies` and `optional-peers.d.ts` if ambient types needed.
- Arc imports peers with `import type` where runtime is optional, else lazy dynamic `import()`.

## Related
- [[adapters]] — pattern for adding a new DB peer
- [[identity]] — "optional peer deps, never bundled" rule
