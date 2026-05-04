# Type Conventions

**Summary**: `unknown` over `any`. Required-property unions over optional props. Accessors over direct property access. `as const` over enums.
**Sources**: src/types/, AGENTS.md §4.
**Last updated**: 2026-04-21.

---

## `request.user`

```ts
// CORRECT — required property, union with undefined
user: Record<string, unknown> | undefined;

// WRONG — optional; conflicts with @fastify/jwt declaration merge
user?: Record<string, unknown>;
```

On public routes, `request.user` is `undefined`. Always guard: `if (request.user)`. See [[gotchas]] #1.

## `RequestScope`

Discriminated union on `kind`: `public | authenticated | member | service | elevated`. Always use accessors — never direct property access. See [[request-scope]].

## Generics & `unknown` defaults

- `BaseController<TDoc = AnyRecord>` — `TDoc` inferred from Mongoose `Model<T>`.
- `MongooseAdapter<TDoc = unknown>` — forces narrowing (lives in `@classytic/mongokit/adapter` since arc 2.12).
- `RepositoryLike` returns `Promise<unknown>` — minimum contract; re-exported by arc, sourced from `@classytic/repo-core/adapter`.
- **Never replace `unknown` with `any`.** Defaults exist to enforce type safety at boundaries.

## Type-only subpaths produce `export {}` at runtime

Subpaths like `./org/types` and `./integrations` only export interfaces. After compile, the `.mjs` contains `export {}`. This is correct — interfaces are erased. Don't add runtime exports to "fill" them. See [[gotchas]] #6.

## Declaration merges

Arc merges into Fastify types (see `src/types/index.ts`):
- `FastifyRequest.user`, `FastifyRequest.scope`, `FastifyRequest.rawBody`
- `FastifyInstance.events`, `.arcEventOutbox`, `.arcAudit`, etc.

Changing these affects every consumer — treat as public API.

## Field rules

v2 (current): `schemaOptions.fieldRules: Record<string, { type: string }>` (stringly-typed).
v3 (planned): `fields: { name: field.string().required() }` (type-safe builder).

## Related
- [[core]] — where `TDoc` flows
- [[request-scope]] — scope accessor API
- [[gotchas]] — `unknown` default traps
