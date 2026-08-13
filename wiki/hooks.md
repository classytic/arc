# Hooks

**Summary**: `HookSystem` runs before/after callbacks on resource operations — the lifecycle engine.
**Sources**: src/hooks/HookSystem.ts.
**Last updated**: 2026-07-28 (`HookContext.scope` — 2.29).

---

## Lifecycle

Per-resource hooks wired via `defineResource({ hooks })`:

```ts
hooks: {
  beforeCreate, afterCreate,
  beforeUpdate, afterUpdate,
  beforeDelete, afterDelete,
  beforeFind,   afterFind,
  beforeRead,   afterRead,
}
```

- `before*` can mutate input or throw to abort.
- `after*` runs post-op; typical place to emit [[events]] or invalidate [[cache]].
- Hooks receive `{ input, ctx, scope, resource }`. `scope` is the [[request-scope]].

## Global hooks

`fastify.arc.hooks.before('*', 'update', fn)` registers a cross-cutting hook over every resource. Its `HookContext` carries the SAME `scope` projection as the per-resource form (2.29) — one helper feeds `HookContext.scope`, `ResourceHookContext.scope`, and `IRequestContext.scope`, so the three cannot drift.

```ts
fastify.arc.hooks.before("*", "update", async (ctx) => {
  if (ctx.scope?.userId && ctx.data) ctx.data.updatedBy = ctx.scope.userId;
});
```

**Read identity from `ctx.scope`, never `ctx.user`.** `ctx.user` is whatever the auth adapter attached and is not scope-validated. `ctx.scope` is `undefined` on public/unscoped routes; branch on `scope.kind` via `ctx.context._scope` for the full discriminated union.

## Introspection

`HookSystem.introspect()` returns the registered hook chain — used by `registry/` introspection plugin for debugging.

## `onRegister` removed (v2.9)

`ResourceConfig.onRegister` was removed. Use `actions` or resource-level `hooks`. See [[removed]].

## Related
- [[core]] — `BaseController` invokes the hook system
- [[events]] — after-hooks publish domain events
- [[cache]] — after-hooks invalidate entries
