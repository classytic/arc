# Adapters

**Summary**: `RepositoryLike` is the minimum contract bridging arc to any database. Core imports no DB directly; mongoose/prisma only live in adapter files. `RouteSchemaOptions extends SchemaBuilderOptions` (repo-core `>=0.2.0`) so kit schemagens plug in without casts.
**Sources**: src/adapters/.
**Last updated**: 2026-04-25.

---

## `RepositoryLike`

Minimum interface any adapter implements. **Returns `Promise<unknown>`** — intentional. `BaseController` casts internally. Adapters should NOT narrow return types. See [[gotchas]] #2.

`RepositoryLike<TDoc> = MinimalRepo<TDoc> & Partial<StandardRepo<TDoc>>`. Arc feature-detects optional methods at call sites; kits declare only what they implement.

Built-in adapters:
- `createMongooseAdapter({ model, repository, schemaGenerator? })` — canonical arc export for Mongoose-backed resources.
- `createPrismaAdapter(delegate)` — wraps a Prisma delegate.
- `createDrizzleAdapter(...)` — sqlitekit/pgkit-backed.
- MongoKit/SqliteKit/RepoCore — already implement `RepositoryLike` natively.

`createAdapter` (from CLI-scaffolded `src/lib/adapter.ts`) is a host-side wrapper over `createMongooseAdapter`, emitted by `arc init` so generated apps can swap backends by editing one file. Hand-built apps should import `createMongooseAdapter` directly.

## DB-agnostic contract

- Core never imports mongoose/prisma. Only adapter files do.
- `select` is never normalized to string — preserved as string/array/projection object so each adapter handles its native shape. See [[gotchas]] #5.
- Generics: factories are UNCONSTRAINED (`createMongooseAdapter<TDoc = unknown>`). The `TDoc extends AnyRecord` constraint lives only on `BaseController` where it's load-bearing for mixin composition; `defineResource` widens once internally.

## `schemaGenerator` — zero-cast wiring (v2.11)

`RouteSchemaOptions extends SchemaBuilderOptions` (imported from `@classytic/repo-core/schema`), and `ArcFieldRule extends FieldRule`. Mongokit's `buildCrudSchemasFromModel(model, options: SchemaBuilderOptions)` plugs in without a cast:

```ts
import { buildCrudSchemasFromModel } from '@classytic/mongokit';

createMongooseAdapter({
  model: ProductModel,
  repository: productRepo,
  schemaGenerator: buildCrudSchemasFromModel,   // ← no cast, no wrapper lambda
});
```

Arc's extensions (`preserveForElevated`, `nullable`, `minLength`, etc.) are applied post-kit by `mergeFieldRuleConstraints`. Kits only see the repo-core `FieldRule` floor. Compile-time relationship locked in `tests/adapters/schema-builder-options-compat.test.ts`.

### `fieldRules.nullable: true` (v2.11)

Widens the kit-generated JSON-Schema `type` to include `null` (and appends `null` to `enum` if present — AJV's `enum` rejects null unless in the list). Portable across adapters: any kit whose output flows through `mergeFieldRuleConstraints` picks it up. Built-in mongoose fallback detects `{ default: null }` on the Mongoose path and widens automatically, mirroring mongokit's convention.

See [[gotchas]] #26.

## Plug into infra plugins

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
