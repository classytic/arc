# Hooks

**Summary**: `HookSystem` runs before/after callbacks on resource operations — the lifecycle engine.
**Sources**: src/hooks/HookSystem.ts.
**Last updated**: 2026-08-25 (read after-hooks fire; the four documented read KEYS never existed).

---

## Lifecycle

Per-resource hooks wired via `defineResource({ hooks })`:

```ts
hooks: {
  beforeCreate, afterCreate,
  beforeUpdate, afterUpdate,
  beforeDelete, afterDelete,
}
```

WRITES ONLY — that is the whole set (`ResourceHooks`). This page previously listed `beforeFind`/`afterFind`/`beforeRead`/`afterRead` here; none of them exist, so a resource declaring one got no error and no hook.

- `before*` can mutate input or throw to abort.
- `after*` runs post-op; typical place to emit [[events]] or invalidate [[cache]].
- Hooks receive `{ input, ctx, scope, resource }`. `scope` is the [[request-scope]].

## Read hooks

Reads are hooked through the SYSTEM, not the resource config — `HookOperation` covers `'list'` and `'read'`:

```ts
fastify.arc.hooks.after('product', 'list', ctx => audit(ctx.result));   // side effects
fastify.arc.hooks.around('product', 'read', (ctx, next) => enrich(next())); // transform
```

- `after` fires with the list result / the document, at the RESULT — so a cache hit and a live read look the same to a handler. A 404 does not fire `after('read')`: there is nothing to hand it.
- `around` is the way to TRANSFORM a read; `after` is for side effects.
- No `afterList`/`afterGet` sugar on `defineResource({ hooks })`, deliberately — `around` already covers transformation there, and a second spelling of one capability is a future divergence.

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
