# Engine-Backed Resources

**Summary**: Resources whose adapter / repository depends on a domain engine that boots asynchronously (Mongoose connection, catalog/flow/order kit init, etc.). Use the factory-export pattern + the `resources` factory at `createApp` — never the manual force-register-from-a-plugin dance.
**Sources**: `src/factory/loadResources.ts`, `src/factory/types.ts`.
**Last updated**: 2026-05-07 — promoted from `factory.md`'s "engine-bound" subsection to a dedicated recipe in 2.15.0.

---

## The problem

A typical engine-backed resource needs to call `engine.models.X` or `engine.repositories.x` at `defineResource()` time:

```ts
// ❌ This module-eval-time call assumes the engine is already booted —
// fails when the file is loaded before bootstrap runs.
const txnRepo = engine.repositories.transaction;
export default defineResource({ adapter: createMongooseAdapter({ ... txnRepo ... }) });
```

Pre-2.11 hosts worked around this by writing parallel `createXResource(engine)` factory files imported manually, OR by force-registering each resource as a Fastify plugin AFTER bootstrap. Both leak boot order into business code.

## Canonical answer — factory exports + `resources` factory

Two coordinated patterns. Use both together.

### 1. Resource file: export a factory, not a `defineResource()` call

```ts
// resources/revenue/transaction.resource.ts
import type { RevenueEngine } from '@classytic/revenue';
import { defineResource } from '@classytic/arc';
import { createMongooseAdapter } from '@classytic/mongokit/adapter';

export interface AppContext {
  revenue: RevenueEngine;
  // catalog, flow, order, ...
}

// Default export is a function — arc detects this in loadResources path 4
// and calls it with the `context` from LoadResourcesOptions.
export default (ctx: AppContext) =>
  defineResource({
    name: 'transaction',
    adapter: createMongooseAdapter({
      model: ctx.revenue.models.Transaction,
      repository: ctx.revenue.repositories.transaction,
    }),
    permissions: { /* ... */ },
  });
```

`loadResources` resolution order (`src/factory/loadResources.ts:282-316`):

1. default export that is a `ResourceLike` (plain object with `toPlugin()`)
2. named export `resource`
3. any named export with `toPlugin()`
4. **default export factory** — `(ctx) => ResourceLike | Promise<ResourceLike>` — called with `options.context`

Detection is `typeof default === 'function'` — `defineResource()` returns a class instance (`typeof === 'object'`), so the two shapes are unambiguous. Async factories are awaited.

### 2. App entry: thread the engine through `resources` as a factory

```ts
// app.ts
import { createApp, loadResources } from '@classytic/arc/factory';
import { ensureRevenueEngine } from './resources/revenue/revenue.engine.js';

await createApp({
  bootstrap: [
    async () => { await ensureRevenueEngine(); },
    // ... other engines
  ],
  resources: async () => {
    // Runs AFTER bootstrap[] — engines are live here.
    const revenue = await ensureRevenueEngine();
    return loadResources(import.meta.url, { context: { revenue } });
  },
});
```

`resources` accepts an array OR a function (sync or async). The function form runs AFTER `bootstrap[]`, so engines initialised in bootstrap are guaranteed live. The factory contract is the canonical answer to "my repository lives in an async-booted engine"; pre-2.11 hosts wrote per-resource lazy-bridge adapters (boilerplate). Explicit `resources` always wins over `resourceDir` auto-discovery, including when the factory returns `[]`.

## Why this beats manual force-register

- **Single ordering rule.** `bootstrap[]` → `resources` factory → register. No "this resource is special, register it from plugin X."
- **Auto-discovery still works.** `loadResources` walks the directory and calls each file's factory with the same context — no per-resource `exclude: [...]` lists.
- **No skip-log noise.** Pre-2.11 the auto-discovery walker would `skip` files whose default export wasn't a `ResourceLike` and emit a confusing diagnostic. The factory branch (path 4) handles those cleanly.
- **Failures are typed.** A factory that throws or returns a non-resource is reported separately from "no default export with `toPlugin`" so you can distinguish "I forgot the export" from "the engine wasn't ready."

## When NOT to use a factory export

- Resources with no engine dependency — plain `export default defineResource({ ... })` is shorter and equally fine.
- Resources where the engine is module-imported (not async-booted) — module imports happen before any factory runs, so plain exports work.

## Related

- [[factory]] — `createApp` entry + the broader resource-loading API
- [[core]] — what `defineResource` produces
- [[gotchas]] — boot-order traps and the lifecycle slot fixed in 2.11.x
