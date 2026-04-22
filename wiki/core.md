# Core

**Summary**: `defineResource` is the fundamental unit. `BaseController` composes `AccessControl + BodySanitizer + QueryResolver` into CRUD handlers; `createCrudRouter` mounts them on Fastify.
**Sources**: src/core/.
**Last updated**: 2026-04-21.

---

## `defineResource`

One config → everything. Carries: name, model/adapter, field rules, permissions, hooks, events, cache, routes, actions, presets.

```ts
defineResource({
  name: 'order',
  model,                                  // Mongoose model or RepositoryLike
  schemaOptions: { fieldRules: { ... } }, // v2 stringly-typed (v3: type-safe builder)
  permissions: { ... },                   // → [[permissions]]
  hooks: { ... },                         // → [[hooks]]
  events: { ... },                        // → [[events]]
  cache: { ... },                         // → [[cache]]
  actions: { ... },                       // custom non-CRUD routes
  onFieldWriteDenied: 'reject' | 'strip', // default reject (v2.9)
});
```

## `BaseController<TDoc = AnyRecord>`

- ~1,440 lines. Composes three concerns:
  - **AccessControl** — runs permission checks, builds row-level filters
  - **BodySanitizer** — strips immutable fields, applies field-write perms (reject/strip)
  - **QueryResolver** — parses query string into adapter-agnostic query
- `TDoc` auto-inferred from `Model<T>`. Defaults to `AnyRecord`. Never replace `unknown` defaults with `any` — see [[types]].

## `QueryResolver`

- Parses Arc's query string DSL → shape the adapter consumes.
- **`select` is preserved as-is** (string, array, or projection object). Do NOT normalize — it breaks DB-agnostic compatibility. See [[gotchas]] #5.
- Operator suffixes: `field_gt`, `field_in`, etc. — documented in `src/utils/queryParser*`.

## `createCrudRouter`

Mounts CRUD handlers on Fastify using the resource definition. Also handles `actions` (v2.9 replaced `createActionRouter` public API — use `defineResource({ actions })` instead). See [[removed]].

## Write-side field permissions (v2.9)

`BodySanitizer` rejects writes to denied fields with `ForbiddenError` listing them. Opt into silent strip via `onFieldWriteDenied: 'strip'`. Rationale: surface misconfigurations instead of hiding them. See [[gotchas]] #11.

## Related
- [[factory]] — how resources are registered into an app
- [[adapters]] — what `model` must satisfy
- [[testing]] — `tests/core/` + `tests/e2e/` cover this module
