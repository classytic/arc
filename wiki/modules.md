# Arc Modules — domain composition without a container

**Summary**: A module is ONE value that carries a domain's engine init, resources, and wiring, so a host composes packages instead of hand-threading pieces across `bootstrap` / `resources` / `afterResources`.
**Sources**: src/factory/module/, src/factory/registerResources.ts.
**Last updated**: 2026-08-14 (plugins-is-not-a-plugin, page compacted to contracts).

---

## The contract

```ts
interface ArcModule {
  name: string;                                    // graph key; duplicates throw at boot
  dependsOn?: readonly string[];                   // compose-after edges → topological order
  plugins?(fastify, ctx): void | Disposer | Promise<...>;  // infra registration (before bootstrap)
  bootstrap?(fastify, ctx): TExports | Promise<TExports>;  // engine init; return = public export
  resources?: ResourceLike[] | ((fastify) => ResourceLike[] | Promise<...>);
  owns?: readonly string[] | "provided";           // app resources this module supersedes
  afterResources?(fastify, ctx): void | Disposer | Promise<...>; // cross-wiring with no arm
  onClose?(fastify): void | Promise<void>;         // teardown; also runs on boot rollback
  errorMappers?: readonly ErrorMapper[];
  healthChecks?: readonly HealthCheck[];
  eventHandlers?: Contribution<EventHandlerDefinition>;
  workflows?: Contribution<unknown>;               // opaque; streamline gives it meaning
  scheduledJobs?: Contribution<ScheduleDefinition>;
}
// ctx = { defer(fn) }
type ArcModuleInput = ArcModule | Promise<ArcModule> | (() => ArcModule | Promise<ArcModule>);
```

**Naming.** `name` is the graph key (`dependsOn` targets, `arc.modules[name]`) and duplicates throw. Published modules namespace it (`vendor.domain`, or the package scope) so two vendors' `order` modules collide loudly rather than clobbering.

## Lifecycle

Modules are sugar over the existing phases — each expands in place, modules first (in `dependsOn` order):

```
app plugins()         → module.plugins        (dependsOn order)
module.bootstrap      → app bootstrap[]
module.resources      → app resources         (module resources prepended)
module.afterResources → app afterResources
onReady
close: module.onClose (REVERSE order) → app onClose   (ONE hook)
```

**⚠ `plugins` is NOT itself a Fastify plugin** — arc CALLS it, never passes it to `fastify.register()`. So (a) you must `await fastify.register(x)` yourself; returning `x` is read as the disposer shorthand, which registers nothing and then invokes your plugin at shutdown, and (b) there is no encapsulation and no prefix — decorators land on the shared instance. Both failure modes are caught at boot: an `fp()`-marked return throws, a multi-argument return warns (disposers take zero arguments). v3 renames the slot to `setup` and removes `plugins` — no alias.

## Teardown is transactional

A failed boot unwinds what already initialised, in reverse dependency order, before the error propagates — a half-initialised process never serves.

- **`defer(fn)`** registers teardown at the point of acquisition, so a resource acquired mid-`bootstrap` is released even if the next line throws. Disposers unwind LIFO.
- **Ordering:** a module's `onClose` runs FIRST, then its disposers unwind.
- Every closer runs **at most once** across rollback and shutdown. One throwing closer never blocks the others; the first close error is rethrown from `fastify.close()` after the rest have run.
- **Write closers defensively** — rollback fires after a PARTIAL init: `client?.close()`, never `client.close()`.

```ts
let client: Client | undefined;
defineModule({
  name: "billing",
  bootstrap: async () => {
    client = await openClient();   // allocated…
    await migrate(client);         // …and this may throw
  },
  onClose: async () => { await client?.close(); },  // still runs
});
```

## `owns` — superseding an app resource

`owns: ["order"]` declares this module authoritatively provides the app-level `order` resource; arc DROPS the app's same-named fork. Replaces a host-side "which resources did modules take over" filter list with a colocated declaration.

**The claim is VERIFIED (2.31), unconditionally.** Boot fails if a claimed name is not among the resources the *claiming* module supplies — an unmet claim would delete the app's route and leave nothing serving it (a silent 404 in production). A sibling module supplying the name does not satisfy the claim; ownership is local to its declarant. Claiming a name with no matching app resource is a no-op, so a module may pre-declare before any fork exists.

**`owns: "provided"` (2.32)** derives the list from what the module actually mounted — the default whenever the supersession list IS the module's own resource set. Resource resolution, name validation, ownership derivation, and supersession are ONE atomic phase, so drift stops being representable. Read the result from `arc.moduleDescriptors` ([[factory]]), never re-derived from `ArcModule` (whose `resources` may still be an unresolved factory and whose `owns` may be the literal `"provided"`).

## Authoring

One exported factory per package, deps explicit and typed. **Engine state lives in the factory CLOSURE**, never module-level singletons — two apps (or two tests) in one process must not collide.

```ts
export function createAccountingModule(deps: AccountingModuleDeps): ArcModule {
  let engine: AccountingEngine;
  return defineModule({
    name: "accounting",
    bootstrap: async () => { engine = await createAccountingEngine(deps); },
    resources: () => buildAccountingResources({ engine, permissions: deps.permissions }),
    eventHandlers: () => accountingEventHandlers(engine),   // NOT afterResources
    onClose: () => engine.destroy(),
  });
}
```

Deps are a typed object, so the compiler is the container; "exports" are the package's public API, because JS modules already encapsulate.

**Typed seams (2.21)** — type host-facing override bundles as `ResourceSeams` (or a `Pick<>` allow-list) and compose with `mergeResourceConfig`, both from `@classytic/arc`. Kills the `as never` tax module authors paid assembling configs from injected parts. Top-level arrays concat, plain objects merge recursively (nested arrays replace), instances last-win. The `adapter` slot is widened via `AdapterLike` so doc-type-erased boundaries take any kit adapter cast-free.

**`errorMappers`** merge into the app's error handler at boot, AFTER host-declared ones (host keeps priority) — composing a module is sufficient for its domain errors to cross the wire mapped.

## Self-describing arms (2.24)

`healthChecks` · `eventHandlers` · `workflows` · `scheduledJobs`. Arc collects them across the graph in `dependsOn` order, fails boot on a duplicate name (attributing both owners), and merges into the single health / schedule tables. Each is an array OR a factory `(fastify) => …` resolved AFTER bootstraps, so it can close over a booted engine.

**Prefer `eventHandlers` over subscribing in `afterResources`:** arc retains every unsubscribe and runs them at shutdown BEFORE any module `onClose`, while the engines those handlers dispatch into are still alive. A module's own `onClose` cannot promise that — it races the modules it depends on.

**`boundary` (2.29)** wraps a handler so a throw is logged (`{ err, event, eventId, handler }`) and swallowed. **Off by default** — a throw reaching the transport is what leaves a Redis Streams message unacked so it redelivers and DLQs, and swallowing by default would downgrade every module handler to best-effort. Opt in for fire-and-forget work (projections, cache invalidation, fan-out). `{ onError }` swaps the log for a metrics sink, inside the boundary.

## Dynamic modules

The thunk-of-import is the contract — lazy AND analyzable:

```ts
const taxPack = region === "BD"
  ? () => import("@classytic/bd-tax/module").then((m) => m.createBdTaxModule(deps))
  : () => import("@classytic/us-tax/module").then((m) => m.createUsTaxModule(deps));

createApp({ modules: [coreModule(deps), taxPack] });
```

Thunks resolve once, at boot, before the bootstrap phase — routes cannot be registered after boot, so boot-time resolution is the only honest contract for HTTP. The unselected pack is never imported: no module-eval cost, no memory, and its transitive deps stay out of the process. A thunk must return the module, never the namespace (`resolveModule` throws a named error).

## `dependsOn`

When a module reads another's export it must compose AFTER it; encoding that by list position breaks on any re-order. Arc runs a **stable topological sort** before any phase, so a dependency's `bootstrap` (and its `arc.modules[dep]` export) is live first, and teardown reverses it.

- **Stable** — unrelated modules keep their listed order; an array with no `dependsOn` composes exactly as written.
- **Fail-fast**: an unknown name, a self-reference, and cycles each throw; the cycle error names the concrete `a → b → … → a` path.
- Use it only for HARD "reads the other's export" edges. Soft coupling (A reacts to B's events) stays an event subscription, which keeps the modules independently deployable.
- **Composition order, not lazy loading.** Every input (thunks included) is imported up front before the sort. Gate whether a module is imported at all with a thunk; order already-selected modules with `dependsOn`.

**Cross-module contracts are PORTS, never lookups.** The consumer declares a port in its deps (`LedgerBridge`, `CatalogBridge`); the host adapts the producer's export to it. A container lookup would weld modules together and kill the service-boundary property — a port can be re-implemented over HTTP/events without the consumer knowing.

## Events + outbox

Contract lives in `@classytic/primitives` `/events` + `/outbox`; runtime lives in arc (`EventOutbox` relay, backoff, stores, transports). Modules receive `eventTransport` (and optionally an `OutboxStore`) via deps, publish in domain verbs, and subscribe via `eventHandlers`. The outbox relay belongs to the app — `createOutboxModule` owns the slot and its schedule arm. See [[events]] and [[delivery-guarantees]].

## Naming grid

| Layer | Pattern | Peer-deps | Examples |
|---|---|---|---|
| Kernel (domain engine) | `@classytic/<noun>` | primitives/kit — never arc | `invoice`, `ledger`, `revenue` |
| Arc module (composition) | `@classytic/arc-<noun>` | arc + its kernel | `arc-invoice`, `arc-accounting` |
| Bundle (meta-module) | `@classytic/arc-<area>` | the modules it wires | `arc-finance` |
| Third-party | `@scope/arc-<domain>` | arc + whatever | — |

Same noun, `arc-` prefix disambiguates. Bundles are plain functions returning `ArcModule[]` with ports pre-wired — composition convenience, never a boundary: bundles can't split into services, modules can.
