# Adapters

**Summary**: The cross-framework adapter contract lives in `@classytic/repo-core/adapter`. Every kit ships its own adapter factory (`@classytic/<kit>/adapter`); arc 2.12 ships zero kit-bound adapters and re-exports `RepositoryLike` only. Core never imports a DB driver. `RouteSchemaOptions extends SchemaBuilderOptions` (repo-core `>=0.3.1`) so kit schemagens plug in without casts.
**Sources**: `@classytic/repo-core/adapter`, `@classytic/mongokit/adapter`, `@classytic/sqlitekit/adapter`, `@classytic/prismakit/adapter`.
**Last updated**: 2026-05-02.

---

## The contract — `@classytic/repo-core/adapter`

`@classytic/repo-core@>=0.4.0` publishes the canonical adapter contract. Hosts and kits both import from this subpath:

```ts
import type {
  DataAdapter,
  RepositoryLike,
  AdapterRepositoryInput,
  AdapterFactory,
  AdapterValidationResult,
  AdapterSchemaContext,
  OpenApiSchemas,
  SchemaMetadata,
  FieldMetadata,
  RelationMetadata,
} from '@classytic/repo-core/adapter';
import { asRepositoryLike, isRepository } from '@classytic/repo-core/adapter';
```

`RepositoryLike<TDoc> = MinimalRepo<TDoc> & Partial<StandardRepo<TDoc>>`. Arc feature-detects optional methods at call sites; kits declare only what they implement. **Returns `Promise<unknown>`** — intentional; `BaseController` casts internally. Adapters should NOT narrow return types. See [[gotchas]] #2.

Arc re-exports `RepositoryLike` for convenience; everything else (constructor input types, factory signatures, schema metadata, helpers) is imported from `@classytic/repo-core/adapter` directly.

## Kit-shipped adapter factories

Each storage kit ships its adapter under its own `/adapter` subpath:

- `@classytic/mongokit/adapter` — `createMongooseAdapter`, `MongooseAdapter`, `MongooseAdapterOptions` + mongoose helpers (`InferMongooseDoc`, `MongooseDocument`, `MatchingModel`, `isMongooseModel`, `CleanDoc`, `InferRepoDoc`, `InferAdapterDoc`).
- `@classytic/sqlitekit/adapter` — `createDrizzleAdapter`, `DrizzleAdapter`, `DrizzleAdapterOptions`, `DrizzleColumnLike`, `DrizzleTableLike`.
- `@classytic/prismakit/adapter` — `createPrismaAdapter`, `PrismaAdapter`, `PrismaQueryParser`.

```ts
import { createMongooseAdapter } from '@classytic/mongokit/adapter';
import { buildCrudSchemasFromModel } from '@classytic/mongokit';

createMongooseAdapter({
  model: ProductModel,
  repository: productRepo,
  schemaGenerator: buildCrudSchemasFromModel,
});
```

```ts
import { createDrizzleAdapter } from '@classytic/sqlitekit/adapter';
import { buildCrudSchemasFromTable } from '@classytic/sqlitekit';

createDrizzleAdapter({
  table: productsTable,
  repository: productRepo,
  schemaGenerator: buildCrudSchemasFromTable,
});
```

The mongoose / drizzle adapters' built-in schema-gen fallback was removed in arc 2.12 (~290 LOC). Kits own schema generation now; if you forget `schemaGenerator`, OpenAPI bodies will be emitted as `null` rather than silently inferred.

`createAdapter` (from CLI-scaffolded `src/lib/adapter.ts`) is a host-side wrapper over `createMongooseAdapter`, emitted by `arc init` so generated apps can swap backends by editing one file. Hand-built apps should import `createMongooseAdapter` from `@classytic/mongokit/adapter` directly.

## DB-agnostic contract

- Arc 2.12 has no `/adapters` subpath and no kit-bound adapters in `src/`. Every adapter — Mongoose, Drizzle, Prisma — lives in its kit. Custom kits (future pgkit, redis-kit, anything implementing `DataAdapter<TDoc>`) plug in identically.
- `select` is never normalized to string — preserved as string/array/projection object so each adapter handles its native shape. See [[gotchas]] #5.
- Generics: factories are UNCONSTRAINED (`createMongooseAdapter<TDoc = unknown>`). The `TDoc extends AnyRecord` constraint lives only on `BaseController` where it's load-bearing for mixin composition; `defineResource` widens once internally.

## `schemaGenerator` — zero-cast wiring

Kit adapters are typed against `SchemaGenerator<TModel>` from `@classytic/repo-core/schema`. `RouteSchemaOptions extends SchemaBuilderOptions`, and `ArcFieldRule extends FieldRule`. Mongokit's `buildCrudSchemasFromModel(model, options: SchemaBuilderOptions)` plugs in without a cast:

```ts
import { createMongooseAdapter } from '@classytic/mongokit/adapter';
import { buildCrudSchemasFromModel } from '@classytic/mongokit';

createMongooseAdapter({
  model: ProductModel,
  repository: productRepo,
  schemaGenerator: buildCrudSchemasFromModel,   // ← no cast, no wrapper lambda
});
```

Arc's extensions (`preserveForElevated`, `nullable`, `minLength`, etc.) are applied post-kit by `mergeFieldRuleConstraints` from `@classytic/repo-core/schema`. Kits only see the repo-core `FieldRule` floor (which now carries constraint metadata: `minLength`, `maxLength`, `min`, `max`, `pattern`, `enum`, `nullable`, `description`). Compile-time relationship locked in `tests/adapters/schema-builder-options-compat.test.ts`.

```ts
import { mergeFieldRuleConstraints, applyNullable } from '@classytic/repo-core/schema';
```

### `fieldRules.nullable: true`

Widens the kit-generated JSON-Schema `type` to include `null` (and appends `null` to `enum` if present — AJV's `enum` rejects null unless in the list). Portable across adapters: any kit whose output flows through `mergeFieldRuleConstraints` picks it up. Mongokit's `buildCrudSchemasFromModel` detects `{ default: null }` on the Mongoose path and widens automatically.

See [[gotchas]] #26.

## Plug into infra plugins

Pass any `RepositoryLike` straight into infra plugins — arc adapts internally:

```ts
new EventOutbox({ repository, transport });   // durable outbox
auditPlugin({ repository });                   // audit store
idempotencyPlugin({ repository });             // idempotency store
```

Works for mongokit, sqlitekit, prismakit, and custom repos implementing `RepositoryLike`.

## Adding a new adapter

Adapters now live in their owning kit, not in arc. To add one:

1. In the kit package, create `src/adapter/<name>.ts` implementing `DataAdapter` from `@classytic/repo-core/adapter`.
2. Return `Promise<unknown>` from all `RepositoryLike` methods.
3. Expose the factory via the kit's `/adapter` subpath export.
4. Add the kit's storage driver as an optional peer of the kit (NOT arc).
5. Tests in the kit's `tests/adapter/<name>.test.ts`. Run arc's `tests/adapters/` against the kit-built adapter for cross-kit conformance.

## Related
- [[core]] — `BaseController` consumes `RepositoryLike`
- [[peer-deps]] — how optional DB deps are declared (kit-specific, not arc peers)
- [[events]] — outbox uses `RepositoryLike`
