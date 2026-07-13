# arc `dependsOn` — module composition ordering (completion report)

**Status:** ✅ Complete and verified · **arc version:** 2.20.0 · **Date:** 2026-07-06

The module system gained a first-class, fail-fast **composition-ordering
primitive** so a module can declare that it must compose *after* another. This
closes the last gap that forced hosts to hand-order their `modules` array and
hope — the ordering is now declared on the module and validated at the root
before any side-effectful plugin runs.

---

## What shipped

All in [`src/factory/module.ts`](src/factory/module.ts), consumed by
[`src/factory/registerResources.ts`](src/factory/registerResources.ts).

### 1. `ArcModule.dependsOn?: readonly string[]`
Declarative composition edges by module name:
```ts
defineModule({ name: "reservation", dependsOn: ["order"], bootstrap: (f) => … })
```
Semantics are deliberately narrow and documented on the field:
- **Composition order, not lazy loading.** Every module input is still resolved
  (`Promise.all`) up front; `dependsOn` orders the *composition/init*, it does
  not decide *whether* a module loads (region/tier packs use the thunk-import
  seam for that).
- A dependency's `plugins`/`bootstrap` is guaranteed to run before any module
  that `dependsOn` it.

### 2. `orderModules()` — stable topological sort
[`module.ts:212`](src/factory/module.ts#L212). Kahn's algorithm with a
**stable** tiebreak: modules with no unresolved deps keep their declared array
order, so adding `dependsOn` to one module never silently reorders an unrelated
one.

- **Backward-compatible fast path** ([`:244`](src/factory/module.ts#L244)): a
  `modules` array with no `dependsOn` anywhere returns unchanged — zero behavior
  change for every existing host.

### 3. Fail-fast graph validation (at the root, before infra)
`orderModules` runs in composition step 1, *before* `config.plugins` connects a
DB / registers a webhook / starts a cron, so a malformed graph aborts boot
clean. Four diagnostics, each with a named, actionable message:
- **duplicate** module name
- **missing** dep (`dependsOn` a name not in the composed set)
- **self-reference** (`dependsOn` includes own name)
- **cycle** — `describeModuleCycle` ([`:303`](src/factory/module.ts#L303))
  walks the remaining graph and prints the actual cycle path, with the fix
  hint: break it with a shared kernel/event instead of a hard edge.

### 4. Module `plugins` phase
[`module.ts:101`](src/factory/module.ts#L101). Optional
`plugins?: (fastify) => void | Promise<void>` — module-owned infra (indexes,
subscriptions) that runs in `dependsOn` order, after app plugins, before any
module `bootstrap`. Slots cleanly into the pipeline:

```
1. resolve + orderModules   — validate graph (dup / missing / self / cycle)
2. app plugins              — infra: DB, data, webhooks
3. module.plugins           — module infra, dependsOn order, before bootstraps
4. module.bootstrap         — engines; return value recorded as module export
5. resources                — mounted
```

### 5. Typed, augmentable `ArcModuleRegistry`
[`module.ts:358`](src/factory/module.ts#L358) + `getModuleExports` overloads
([`:393`](src/factory/module.ts#L393)). Augment the registry once and the
module name alone infers its export type — no manual generic at every call
site. `getModuleExports` also throws a precise error if an export is read before
that module's bootstrap ran (init order = `dependsOn`/list order).

---

## Verification

### The primitive itself (arc suite)
| Suite | Result |
|---|---|
| `tests/factory/order-modules.test.ts` + `modules.test.ts` (ordering, stable tiebreak, dup/missing/self/cycle, diamond, plugins phase) | **35 tests / 2 files — green** |
| Full arc suite | **5615 green** (this session, source unchanged since) |

### Real-host regression proof — be-prod on arc 2.20.0 (cp-dist'd)
be-prod is the adversarial case: a large single-tenant/multi-branch ERP that
composes real engine modules. It declares **zero `dependsOn` edges by design**
(BYO-engine + inject-at-root — engines are constructed and injected, not looked
up via `arc.modules`), so it exercises the **backward-compatible fast path** and
proves the primitive is invisible to existing hosts.

| Stamp | Result |
|---|---|
| `test:scenarios` | **1128 tests / 117 files — green** |
| `test:integration` (app + domain + shared) | **1036 tests / 72 files — green** |
| `test:unit` | **665 tests / 62 files — green** |
| **Total** | **2829 tests / 251 files — all green, exit 0** |

**Conclusion:** the fast-path returns be-prod's module array unchanged →
identical composition → 2829 green confirms no regression. The ordering,
validation, and diagnostics are proven by the arc factory suite; the real edge
the primitive exists for (`reservation dependsOn order`) is exercised in the
spine composition tests.

---

## Design notes for adopters

- **Prefer no edge.** If a module can take what it needs via a constructor port
  (BYO-engine, inject-at-root) or react to a kernel event, do that — be-prod
  models this and carries zero edges. Reach for `dependsOn` only when module B
  genuinely must compose after A (e.g. B's `plugins` subscribes to a model A's
  bootstrap registers). The canonical real edge is `order ← reservation`.
- **Not a DI container.** `dependsOn` orders composition; it does not resolve or
  inject values. Cross-module wiring still reads the dependency's recorded
  export via `getModuleExports(f, "name")` inside the dependent's bootstrap.
- **Cycles are a smell.** The error refuses to guess an order and tells you to
  break the cycle with a shared kernel or an event — a hard mutual `dependsOn`
  means the boundary is wrong.
