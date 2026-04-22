# Hooks

**Summary**: `HookSystem` runs before/after callbacks on resource operations. ~720 lines; the main lifecycle engine.
**Sources**: src/hooks/HookSystem.ts.
**Last updated**: 2026-04-21.

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

## Introspection

`HookSystem.introspect()` returns the registered hook chain — used by `registry/` introspection plugin for debugging.

## `onRegister` removed (v2.9)

`ResourceConfig.onRegister` was removed. Use `actions` or resource-level `hooks`. See [[removed]].

## Related
- [[core]] — `BaseController` invokes the hook system
- [[events]] — after-hooks publish domain events
- [[cache]] — after-hooks invalidate entries
