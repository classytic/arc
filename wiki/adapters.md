# Adapters

**Summary**: `RepositoryLike` is the minimum contract bridging arc to any database. Core imports no DB directly; mongoose/prisma only live in adapter files.
**Sources**: src/adapters/.
**Last updated**: 2026-04-21.

---

## `RepositoryLike`

Minimum interface any adapter implements. **Returns `Promise<unknown>`** — intentional. `BaseController` casts internally. Adapters should NOT narrow return types. See [[gotchas]] #2.

Built-in adapters:
- `createMongooseAdapter(model)` — wraps a Mongoose `Model<T>`.
- `createPrismaAdapter(delegate)` — wraps a Prisma delegate.
- MongoKit/SqliteKit/RepoCore — already implement `RepositoryLike` natively (v2.9.1+).

## DB-agnostic contract

- Core never imports mongoose/prisma. Only adapter files do.
- `select` is never normalized to string — preserved as string/array/projection object so each adapter handles its native shape. See [[gotchas]] #5.
- Generics: `MongooseAdapter<TDoc = unknown>`. `unknown` default forces narrowing; don't replace with `any`.

## Plug into infra plugins (v2.9.1)

Pass any `RepositoryLike` straight into infra plugins — arc adapts internally:

```ts
new EventOutbox({ repository, transport });   // durable outbox
auditPlugin({ repository });                   // audit store
idempotencyPlugin({ repository });             // idempotency store
```

Works for mongokit, prismakit, custom repos.

## Adding a new adapter

1. Create `src/adapters/myAdapter.ts`, implement `RepositoryLike`.
2. Return `Promise<unknown>` from all methods.
3. Add optional peer dep in `package.json`.
4. Add to `tsdown.config.ts` `deps.neverBundle`.
5. Add to `knip.config.ts` `ignoreDependencies`.
6. Tests in `tests/adapters/<name>.test.ts`.

## Related
- [[core]] — `BaseController` consumes `RepositoryLike`
- [[peer-deps]] — how optional DB deps are declared
- [[events]] — outbox uses `RepositoryLike`
