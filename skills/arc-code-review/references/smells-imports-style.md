# Smells: canonical import homes and style

Each shared contract has one home. An import from another package drifts from the type the kit really returns.

## I1. Pagination types [high]

Grep: `OffsetPaginationResult|KeysetPaginationResult|AggregatePaginationResult|PaginationResult|toCanonicalList` imported from `@classytic/primitives` or `@classytic/mongokit`.
Fix:

```ts
import type { OffsetPaginationResult, KeysetPaginationResult } from "@classytic/repo-core/pagination";
import { toCanonicalList } from "@classytic/repo-core/pagination";
```

The wire envelope carries `method` (`offset`, `keyset`, `aggregate`) as the discriminant.

## I2. Event types [high]

Grep: `DomainEvent|EventMeta|EventHandler|EventTransport|createEvent|matchEventPattern` imported from `@classytic/arc/events`.
Fix: types and helpers from `@classytic/primitives/events`; only runtime pieces (`MemoryEventTransport`, `eventPlugin`, `EventOutbox`) come from arc.

## I3. Tenant config [medium]

Grep: `@classytic/primitives/tenant`.
Fix: `import type { TenantConfig } from "@classytic/repo-core/tenant"` and `resolveTenantConfig` from the same path.

## I4. Error contract [high]

Grep: `HttpError|ErrorContract|toErrorContract|statusToErrorCode` imported from `@classytic/primitives` or `@classytic/mongokit`.
Fix: `@classytic/repo-core/errors` owns `HttpError`, `ErrorContract`, `ErrorDetail`, `ERROR_CODES`, `toErrorContract`, `statusToErrorCode`. Arc's `ArcError` implements `HttpError`.

## I5. Adapters imported from arc [critical]

Grep: `createMongooseAdapter|createDrizzleAdapter|createPrismaAdapter|MongooseAdapter|DataAdapter|AdapterRepositoryInput|OpenApiSchemas|SchemaMetadata` imported from any `@classytic/arc` path, or any import from an arc `adapters` subpath.
Why: arc ships no kit adapters; the import does not resolve and the build breaks.
Fix: adapters come from the kit, contracts from repo-core.

```ts
import { createMongooseAdapter } from "@classytic/mongokit/adapter";
import { createDrizzleAdapter } from "@classytic/sqlitekit/adapter";
import { createPrismaAdapter } from "@classytic/prismakit/adapter";
import type { DataAdapter, RepositoryLike } from "@classytic/repo-core/adapter";
import { mergeFieldRuleConstraints } from "@classytic/repo-core/schema";
```

## I6. Dodged `schemaGenerator` [high]

Grep: `schemaGenerator:\s*false` on a mongokit adapter.
Why: the mongokit adapter derives CRUD schemas from the model by default; `false` silently removes OpenAPI bodies and MCP tool input schemas for the whole resource. It is usually a dodge for a wire-versus-model shape mismatch (minor-unit integers versus Money objects).
Fix: keep the generator on and declare the wire contract with zod: `...crudInput({ create, update })`. A custom part replaces the generated part wholesale. The Drizzle adapter takes `schemaGenerator: buildCrudSchemasFromTable` from `@classytic/sqlitekit/schema/crud`.

## I7. Style and edges [low]

- `console\.(log|warn|error|info|debug)\(` in `src/` outside CLI and scripts: use `request.log` or `app.log`.
- `:\s*any\b|as\s+any\b|@ts-ignore|@ts-expect-error`: use `unknown` and narrowing; fix the type.
- `^export\s+default\b` in `src/`: named exports (`export const productResource`). `loadResources()` finds the `default` export, `export const resource`, or any export with `.toPlugin()`; prefer named for grep.
- Resource files importing each other through tsconfig path aliases (`@/foo`): `loadResources()` uses Node's resolver, so aliases are not resolvable; use relative imports or `#` subpath imports.
- Code post-processing the `select` query value: pass it through; the repository owns its native shape.
- No `arc docs` script while a hand-kept spec exists, no `displayName` or `module` on resources: cosmetic.
