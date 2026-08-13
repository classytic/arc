# Arc Modules — domain composition without a container

## Why

Domain packages (`@classytic/accounting`, `order`, `hr`, …) need to compose
into an arc app as ONE value — engine init + resources + event wiring — instead
of the host hand-threading pieces across `bootstrap` / `resources` /
`afterResources`. That single value is the **contribution unit** (anyone can
publish one), the **composition unit** (verticals pick a list), and the
**service boundary** (any module can run alone in its own app).

## The contract

```ts
interface ArcModule {
  name: string;
  dependsOn?: readonly string[];                   // compose-after edges → topological order
  plugins?(fastify, ctx): void | Disposer | Promise<...>;  // infra registration (before bootstrap)
  bootstrap?(fastify, ctx): TExports | Promise<TExports>;  // engine/singleton init; return = public export
  resources?: ResourceLike[] | ((fastify) => ResourceLike[] | Promise<...>);
  owns?: readonly string[] | "provided";           // app resources this module supersedes
  afterResources?(fastify, ctx): void | Disposer | Promise<...>; // cross-wiring arc has no arm for
  onClose?(fastify): void | Promise<void>;        // teardown; also runs on boot rollback
  //  ctx = { defer(fn) } — 2.32 teardown at point of acquisition; see below
  errorMappers?: readonly ErrorMapper[];           // 2.21 — see below
  healthChecks?: readonly HealthCheck[];           // 2.24 self-describing arms
  eventHandlers?: Contribution<EventHandlerDefinition>;  //  ↑ prefer over afterResources
  workflows?: Contribution<unknown>;               //  ↑ opaque; streamline gives it meaning
  scheduledJobs?: Contribution<ScheduleDefinition>;//  ↑
}

type ArcModuleInput = ArcModule | Promise<ArcModule> | (() => ArcModule | Promise<ArcModule>);

createApp({ modules: [accountingModule(deps), () => import('@classytic/bd-tax/module').then(m => m.createBdTaxModule(deps))] })
```

### Naming convention (before third-party packages exist)

`name` is the graph key (`dependsOn` targets, `arc.modules[name]`), and duplicate
names throw at boot. Within one repo that's enough, but public packages can
collide on generic domains (`order`, `billing`, `audit`). **Convention for
published modules: namespace the name** — use the package scope, e.g.
`@classytic/order` → `name: "order"` for the org's own, and third parties use
`vendor.domain` (`acme.billing`) or their scope (`@acme/billing`). A host that
composes two `order` modules from different vendors then renames one explicitly
rather than getting a silent clobber (arc throws, so the collision is loud).

Modules are **pure sugar over the existing lifecycle** — each expands into the
same phases a hand-wired app uses, modules first (in dependency order), then app-level:

```
app plugins()  → module.plugins  (dependsOn order)
module.bootstrap  → app bootstrap[]
module.resources  → app resources          (module resources prepended)
module.afterResources  → app afterResources
onReady
close: module.onClose (REVERSE order)  → app onClose     (ONE hook — see below)
```

`module.plugins` (infra registration) is the module-level analog of the app
`plugins()` slot — it runs AFTER the app's own plugins (so module infra can
build on app foundations) and BEFORE any module `bootstrap` (so engines can
rely on it). `plugins` = "register infra"; `bootstrap` = "init engines + return
the export". Both are optional; registering a plugin inside `bootstrap` still
works — the split just makes intent explicit for published ecosystem packages.

**Teardown order (2.20 fix).** Fastify runs `onClose` hooks LIFO, so arc
registers module teardown + app `onClose` in ONE hook that runs module
`onClose` (reverse composition order) THEN app `onClose`. This guarantees a
module can flush its outbox / drain its queue / close its own DB-or-Redis
connection **before** app-level `onClose` tears down shared infra — and because
that single hook registers last, it fires before the DB/Redis plugins from
`app plugins()` (whose own `onClose` runs last under LIFO), so the underlying
connections are still live during both module and app teardown.

**Boot is transactional (2.31).** That single teardown hook registers at the
END of the lifecycle, so a failure *before* it — a later module's `bootstrap`,
app `bootstrap[]`, a resources factory, `afterResources` — used to leave an
already-initialized module's clients, timers, and engines running with no
teardown path at all. Arc now tracks every module that **entered** an init
phase (`plugins` OR `bootstrap`) — entered, not completed, so a callback that
allocates and *then* throws is covered too — and, on any boot failure:

1. unsubscribes live module event handlers (engines still alive), then
2. closes initialized modules in **reverse composition order**, then
3. rethrows the **original** boot error — cleanup failures are logged, never
   substituted for the real cause.

Every closer runs **at most once** across the rollback and shutdown paths, and
one throwing closer never blocks the others (best-effort). Shutdown is
best-effort too: a throwing module closer is logged, the remaining closers and
app `onClose` still run, and the first close error is rethrown from
`fastify.close()` afterwards.

> **Write closers defensively.** Rollback fires after a PARTIAL init — your
> `bootstrap` opened a client and threw on the next line, or your `plugins`
> ran but `bootstrap` never did. Guard everything init may not have reached:
> `client?.close()`, not `client.close()`.

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

**`defer` — teardown at the point of acquisition (2.32).** Every `?.` above
encodes "init may not have reached this line", which is bookkeeping the runtime
already has. Setup phases (`plugins`, `bootstrap`, `afterResources`) take a
second argument with `defer`: register each teardown the moment the resource
exists, and partial-init cleanup becomes exact instead of defensive.

```ts
defineModule({
  name: "billing",
  bootstrap: async (fastify, { defer }) => {
    const client = await openClient();
    defer(() => client.close());        // registered the moment it exists
    const sub = await client.subscribe();
    defer(() => sub.close());           // never registered if subscribe threw
    return createEngine(client);
  },
});
```

`plugins` and `afterResources` may also just RETURN a disposer — shorthand for
one `defer` when there is a single resource. `bootstrap` cannot: its return
value is the module's public export.

Disposers unwind **LIFO** (reverse registration), run on **both** teardown
paths (rollback and shutdown), and **exactly once** — whichever path fires
first drains the stack. A throwing disposer never blocks the ones behind it;
the first error is rethrown after the sweep, same contract as `onClose`.

**Ordering:** a module's `onClose` runs FIRST, then its disposers unwind. That
is still LIFO — `onClose` tears down what `bootstrap` RETURNED, the last thing
the module produced. Concretely: `plugins` defers a connection, `bootstrap`
builds an engine over it, and the engine must stop before the connection closes
underneath it. Want one strict chain with no special case? `defer` everything
and omit `onClose`; either alone is complete.

Module resources flow through arc's normal registration (prefix, dedup,
OpenAPI, audit) — never special-cased.

### `owns: "provided"` — derived ownership (2.32)

The default for any module whose supersession list IS its own resource set:

```ts
defineModule({ name: "order", owns: "provided", resources: () => [...] })
```

Arc makes resource resolution, name validation, ownership derivation and
supersession **one atomic phase**: resources resolve exactly once, duplicate
names within a module are rejected unconditionally, the effective `owns` is
derived from what actually mounted, and only then are host forks dropped. The
drift class below stops being *representable* rather than merely detected.

Read the result from `arc.moduleDescriptors` — see [[factory]]. Do NOT re-derive
it from `ArcModule`: an authoring definition's `resources` may still be an
unresolved factory and its `owns` may be the literal `"provided"`.

Keep the explicit array only when the list genuinely is not the module's own
resource set (pre-declaring a name before any fork exists).

### `owns` — superseding an app resource, verified

`owns: ["order"]` declares that this module authoritatively provides the
app-level `order` resource; arc DROPS the app's same-named fork so the module's
version registers. That replaces a host-side hand-maintained "which resources
did modules take over" filter list with a colocated per-module declaration.

**The claim is enforced (2.31).** Arc resolves module resources first and fails
boot if a claimed name is not among the ones the *claiming* module supplies:

```ts
defineModule({ name: "orders", owns: ["order"], resources: [] })
// ✗ boot fails: declares owns: ["order"] but its own `resources` do not supply that name
```

Unconditional, not gated behind `strictResources` — `owns` is an explicit
authoritative claim, unlike the far softer duplicate-discovery case. An unmet
claim deletes the app's route and leaves nothing serving it: a silent 404 in
production. A *sibling* module supplying the name does not satisfy the claim;
ownership is local to its declarant, which is the colocation the arm exists for.

Still tolerant on the app side: `owns` a name with no matching app resource is a
no-op, so a module may pre-declare before any fork exists — it just has to
supply the resource itself.

## Authoring convention (the forRoot analog, without the container)

One exported factory per package, deps explicit and typed:

```ts
// @classytic/accounting
export function createAccountingModule(deps: AccountingModuleDeps): ArcModule {
  let engine: AccountingEngine;
  return defineModule({
    name: "accounting",
    bootstrap: async () => {
      engine = await createAccountingEngine(deps);
    },
    resources: () =>
      buildAccountingResources({ engine, permissions: deps.permissions }),
    eventHandlers: () => accountingEventHandlers(engine), // NOT afterResources
    onClose: () => engine.destroy(),
  });
}
```

`createXModule(deps)` ≡ Nest's `X.forRoot(opts)` — but it's a plain function:
no decorators, no reflect-metadata, no provider tokens, no injector. Deps are
a typed object; "exports" are the package's public API (JS modules already
encapsulate — no runtime exports map).

### Typed seams + merge (2.21) — the cast-free assembly recipe

Type host-facing per-resource override bundles as `ResourceSeams` (or a
`Pick<ResourceSeams, ...>` allow-list) and compose with `mergeResourceConfig`
— both from `@classytic/arc`. This kills the `as never` tax module authors
paid when assembling `defineResource` configs from injected parts (a real
module carried 15+ casts), and makes every module's
"defaults + host seams" merge identical: top-level arrays concat, plain
objects merge recursively (nested arrays replace), instances last-win. The
`adapter` seam slot is widened via `AdapterLike` (the `ControllerLike`
pattern) so doc-type-erased boundaries accept any kit adapter without casts:

```ts
export interface CatalogSeams { product?: ResourceSeams; category?: ResourceSeams }

function buildResource(key: Key, seams?: ResourceSeams) {
  return defineResource(
    mergeResourceConfig(
      {
        name: key,
        prefix: DEFAULTS[key].prefix,
        audit: true,
        permissions: permissionMatrix({ read: deps.view, write: deps.manage }),
      },
      seams,
    ),
  );
}
// Presence-driven mounting stays a plain loop — the tables (MODEL_FOR,
// DEFAULTS) are domain content, not boilerplate; arc deliberately ships no
// resourcesFromEngine() wrapper for them.
```

### Module-shipped error mappers (2.21)

`defineModule({ errorMappers: [shippingErrorMapper] })` — merged into the
app's error handler at boot, AFTER host-declared mappers (host keeps
priority). Composing a module is now sufficient for its domain errors to
cross the wire as mapped contracts; the composition root no longer lists
every domain package's error classes.

### Self-describing arms (2.24) — `healthChecks` · `eventHandlers` · `workflows` · `scheduledJobs`

Four additive declarations that keep the composition root thin. Arc collects
them across the graph in `dependsOn` order, fails boot on a duplicate name
(attributing both owners), and merges into the single health / schedule tables.
Each is an array OR a factory `(fastify) => …` resolved AFTER bootstraps, so it
can close over a booted engine instead of a global getter.

```ts
defineModule({ name: "search",
  healthChecks:  [{ name: "search.index", check: () => index.isReady() }],
  eventHandlers: [{ name: "search.reindex", event: "product:*", handler: reindex, boundary: true }],
  scheduledJobs: [{ name: "search.compact", every: 3_600_000, handler: compact }],
})
```

**Why `eventHandlers` beats subscribing in `afterResources`:** arc retains every
unsubscribe and runs them at shutdown BEFORE any module `onClose`, while the
engines those handlers dispatch into are still alive. A module's own `onClose`
cannot promise that — it races the modules it depends on.

**`boundary` (2.29)** wraps the handler in `wrapWithBoundary`: the throw is
logged through `fastify.log` (`{ err, event, eventId, handler }`) and swallowed,
and an unnamed handler is labelled `<module>.<pattern>`, never `anonymous`.
**Off by default** — a throw reaching the transport is what leaves a Redis
Streams message unacked so it redelivers and DLQs; swallowing by default would
downgrade every module handler to best-effort. Opt in for fire-and-forget work
(projections, cache invalidation, notification fan-out) where a failure must not
block the ack. `{ onError }` swaps the log for a metrics/alert sink, inside the
boundary — a throwing `onError` is itself caught.

## Dynamic modules (the next/dynamic idea, backend-shaped)

The thunk-of-import is the contract — lazy AND analyzable:

```ts
const taxPack =
  region === "BD"
    ? () =>
        import("@classytic/bd-tax/module").then((m) =>
          m.createBdTaxModule(deps),
        )
    : () =>
        import("@classytic/us-tax/module").then((m) =>
          m.createUsTaxModule(deps),
        );

createApp({ modules: [coreModule(deps), taxPack] });
```

- Thunks resolve **once, at boot, before the bootstrap phase** — fail-fast, no
  request-time loading states. (Nest's LazyModuleLoader can't register routes
  post-boot either; boot-time resolution is the honest contract for HTTP.)
- The unselected pack is never imported: no module-eval cost, no memory, and
  its transitive deps stay out of the process. This is how region packs
  (`ledger-bd`'s `bangladeshPack` precedent), tier gating, and licensed
  features compose.
- Thunks must return the module (or `createXModule(deps)` result), never the
  namespace — `resolveModule` validates and throws a named error.

## No container — the three layers that replace it

Nest's container answers "how does module B get a typed handle to what module A
built?" We answer it without runtime machinery, in three layers:

1. **App infra → one context object.** `connection`, `eventTransport`,
   `outbox`, `logger` are built ONCE at the composition root and spread into
   every module factory: `accounting({ ...ctx, permissions: gates })`. A plain
   typed object — the compiler is the container. `createApp` never grows.

2. **Module exports → fastify's existing surface.** (Implemented: `registerResources.ts` records bootstrap returns at `fastify.arc.modules[name]`; missing decoration or duplicate names throw. Originally specced at the
   first real consumer.) `bootstrap` may RETURN the module's public handle; arc
   records it at `app.arc.modules[name]` — a boot-time `Map<name, export>` on
   the decoration surface arc already owns. Typed, inspectable, list-ordered.
   No tokens, no resolution, no scopes.

   **The seam is typed end-to-end (2.20).** `ArcModule<TExports>` captures the
   bootstrap return type (`defineModule` infers it), and the read path is the
   throwing accessor `getModuleExports(fastify, name)` from
   `@classytic/arc/factory` — a missing/late/empty export throws at boot with
   the list of recorded modules, and neither end casts. Augment
   `ArcModuleRegistry` once and the name alone infers the export type (the
   fastify / awilix declaration-merging pattern); or pass the type inline:

   ```ts
   // one-time, anywhere in the app:
   declare module "@classytic/arc/factory" {
     interface ArcModuleRegistry { accounting: AccountingEngine; order: OrderEngine }
   }
   const acct = getModuleExports(fastify, "accounting"); // → AccountingEngine, no cast
   const order = getModuleExports<OrderEngine>(fastify, "order"); // or inline
   ```

   ### OPTIONAL and DEFERRED sibling reads (2.32)

   `getModuleExports` is the right read only when the dependency is required AND
   already bootstrapped. Two other shapes are just as common, and hosts were
   hand-rolling both as `(f as unknown as { arc?: { modules?: Record<string, unknown> } }).arc?.modules?.x`
   — a double cast that loses registry typing, survives a typo in the module
   name, and cannot be grepped for:

   | Read | Use when |
   |---|---|
   | `getModuleExports(f, name)` | required, and the sibling has bootstrapped (throws with the recorded-module list) |
   | `getOptionalModuleExports(f, name)` | the module is genuinely OPTIONAL — `undefined`, no throw, no cast |
   | `hasModuleExports(f, name)` | a readiness predicate (`ready: () => …`) — "did a bootstrap record an export?" |
   | `hasModule(f, name)` | "is this module COMPOSED?" — true for resource-only / exportless modules |
   | `getModuleState(f, name)` | its lifecycle state (see below) — for doctor/registry introspection |
   | `lazyModuleExports(f, name)` | the read is WIRED at composition time and USED later; optional |
   | `lazyRequiredModuleExports(f, name)` | same, but a hard dependency — presence validated eagerly, export read deferred |

   **Presence ≠ exports.** `hasModuleExports` answers whether a *public export*
   was recorded — a resource-only module (no `bootstrap`, or one returning
   `undefined`) is composed yet looks absent to it. `hasModule` /
   `getModuleState` read `arc.moduleStates`, populated for every composed module
   the moment the graph validates:

   ```
   resolved ──► bootstrapping ──► ready ──► closing ──► closed
                     │                                     │
                     └────────────► failed ◄───────────────┘
   ```

   Two semantics worth knowing. `closed` tracks the **application** lifecycle,
   not just module-owned cleanup — a module with no `onClose` still reaches
   `closed` after `app.close()` rather than sitting at `ready` forever. And
   **`failed` is sticky**: a module whose init threw is closed by the rollback,
   but that successful cleanup does not rewrite it to `closed`, because "this
   module failed to initialize" is the fact an operator needs.

   One flat union can't express both dimensions — "failed to init, cleaned up
   fine" and "inited fine, failed to clean up" both read as `failed`. Splitting
   them needs a separate failure record (`{ phase, error }`), not more union
   members; deferred until the introspection surface has a real consumer.

   **`lazyRequiredModuleExports` defers the READ, not the REQUIREMENT (2.31).**
   A lazily-required module is still a hard dependency, so a name that is not in
   the composed graph throws where the accessor is *created* — at boot — instead
   of surviving startup and failing on the first request or event. Only the
   export read (has `bootstrap` returned yet?) is deferred.

   **Convention for hard sibling dependencies — also declare `dependsOn`:**

   | Shape | Declare |
   |---|---|
   | Hard, read during `bootstrap` | `dependsOn: ["order"]` + `getModuleExports` |
   | Hard, read at request/event time | `dependsOn: ["order"]` + `lazyRequiredModuleExports` |
   | Optional integration | `lazyModuleExports` / `getOptionalModuleExports`, no edge |

   `dependsOn` orders composition (the sibling's engine exists before yours
   initializes); the lazy accessor only defers the read. They are complementary,
   not alternatives.

   **Why the lazy pair exists.** Plenty of wiring is *registered* earlier than it
   *runs*: an `eventHandlers` factory, a bridge accessor handed to another
   module, a hook added during bootstrap and fired per request. Such a factory
   can execute before the sibling it needs has bootstrapped, so a sibling engine
   captured into a local at that moment is `undefined` — and stays `undefined`
   for the process lifetime even though the sibling came up milliseconds later.
   That failure is **silent by construction**: the consumer sees a null bridge
   and reads it as "this deployment has no inventory / no revenue engine", a
   legitimate configuration. The lazy getter re-reads while the module is absent,
   memoizes the first resolved value, and **never memoizes absence**.

   ```ts
   const inventory = lazyModuleExports<FlowEngine>(fastify, "inventory");
   return {
     flowBridge: () =>
       inventory() ? createFlowEngineBridge({ getFlowEngine: () => inventory()! }) : null,
     ready: () => inventory() !== undefined, // drawer-only deployment: legitimately false
   };
   ```

   Use `dependsOn` when the edge is hard and the module set is fixed; use
   `lazyModuleExports` when the sibling may not be composed at all.

## dependsOn — composition order without list-position coupling (2.20)

When a module reads another's export it must be composed AFTER it. Encoding
that by list position is fragile — a re-order or a conditionally-inserted
module silently breaks it. `dependsOn` makes the edge explicit; arc runs a
**stable topological sort** over the module set before any phase, so a
dependency's `bootstrap` (and its `arc.modules[dep]` export) is always live
first, and teardown runs in the reverse of that order.

```ts
defineModule({
  name: "reservation",
  dependsOn: ["order"],                       // compose after `order`, wherever it's listed
  bootstrap: (f) => wireBooking(getModuleExports(f, "order")), // guaranteed live
});
```

- **Stable** — modules with no edge between them keep their original list
  order, so adding `dependsOn` to one never silently reorders an unrelated one.
  A `modules` array with no `dependsOn` anywhere is composed exactly as listed
  (backward compatible).
- **Fail-fast at boot** (never composes past a broken contract): a `dependsOn`
  name not in the set, a self-reference, and dependency **cycles** each throw —
  the cycle error names the concrete `a → b → … → a` path.
- Prefer `dependsOn` only for HARD "reads the other's export" edges. Soft,
  reversible coupling (A reacts to B's events) stays an event subscription, not
  a dependency — that keeps the modules independently deployable (see layer 3).
- **Composition order, not lazy loading.** Every module input (including
  dynamic-import thunks) is resolved — *imported* — up front (`Promise.all`)
  before the sort. `dependsOn` orders which module's `plugins`/`bootstrap` runs
  first; it does NOT delay *importing* a dependent until its dependency is
  ready. Gate whether a module is imported at all with a **thunk** (region/tier
  packs); order already-selected modules with `dependsOn`.

3. **Cross-module contracts → ports, never lookups.** The consumer declares a
   port in its deps (`LedgerBridge` / `BookingBridge` / `CatalogBridge` — the
   pattern this platform has already proven); the host adapts the producer's
   export to it. `container.get(Service)` would weld modules together and kill
   the service-boundary property — ports keep a module split-safe because the
   port can be re-implemented over HTTP/events without the consumer knowing.

**Module state rule:** packages hold engine state in the factory CLOSURE
(`createXModule` scope), never module-level singletons — so two apps (or two
tests) in one process never collide. App-level singletons remain fine inside
apps; they are not publishable-module style.

## What we deliberately do NOT do (the Nest tax we skip)

| Nest mechanism                               | Cost (from source)                              | Our answer                                        |
| -------------------------------------------- | ----------------------------------------------- | ------------------------------------------------- |
| reflect-metadata scanning                    | O(classes × methods) at boot, ~50–200ms typical | plain functions, no decorators                    |
| DI container + InstanceWrapper               | ~500B/provider + resolution per request         | explicit `deps` argument                          |
| REQUEST/TRANSIENT scopes (WeakMap ContextId) | per-request allocation + lookups                | request state on `req`, engines are singletons    |
| global enhancer chains                       | array iteration per request                     | Fastify hooks/arc middleware, opt-in per resource |
| runtime module graph + distance calc         | O(modules²) container                           | a flat ordered list; order = the graph            |

What we DO keep from Nest: the _module-as-unit_ mental model, `forRoot`-style
factory naming (`createXModule`), lifecycle hook clarity, and the
testing-first DX (their `Test.createTestingModule` ≈ our testkit's
`bootModuleApp` + deps override — swap a dep by passing a different value; no
override API needed when deps are explicit).

## Events + outbox (source of truth: primitives)

- **Contract** lives in `@classytic/primitives` `/events` + `/outbox`
  (`DomainEvent`, `EventTransport`, `OutboxStore`). Kernels peer-dep
  primitives, never arc (PACKAGE_RULES §11).
- **Runtime** lives in arc: `EventOutbox` relay, backoff, memory/Mongo stores,
  Redis + Redis-Streams transports.
- **Modules** receive `eventTransport` (and optionally an `OutboxStore`) via
  deps; publish in domain verbs, subscribe in `afterResources`. The APP owns
  the single relay (`new EventOutbox({ store })` + `outbox.relay` tick).

### Microservices for free

A well-formed module touches the world only through (a) its deps and (b)
events on the transport. Therefore:

- monolith: `createApp({ modules: [a, b, c] })` — in-process bus
- split: `createApp({ modules: [a] })` per deployment — Redis-stream
  transport + outbox relay across the wire

Module boundary = service boundary, promoted by deployment config, not a
rewrite. Outbox lease semantics (`claimPending`, ownership, DLQ) make the
promotion safe under load.

## Testing story

- Arc ships `createTestApp` / `expectArc` / `TestAuthProvider` (wiki/testing.md).
- A module ecosystem needs one more layer (lives in spine as `spine-testkit`,
  candidate to upstream): `bootModuleApp(moduleInput, opts)` — boots a REAL
  arc app around the module under test (Next.js `nextTestSetup` fixture-app
  pattern), on mongo-memory (replset when the domain is transactional),
  returns `{ app, inject, auth, close }`.
- Contributor contract: **if your module boots green in the testkit, it
  composes.** Same suite should pass in monolith mode and solo-service mode.

## Naming grid (kills kernel/module ambiguity)

| Layer | Pattern | Peer-deps | Examples |
|---|---|---|---|
| Kernel (domain engine) | `@classytic/<noun>` | primitives/mongokit — never arc | `invoice`, `ledger`, `revenue`, `flow` |
| Arc module (composition) | `@classytic/arc-<noun>` | arc + its kernel | `arc-invoice`, `arc-accounting` |
| Bundle (meta-module) | `@classytic/arc-<area>` | the modules it wires | `arc-finance` |
| Third-party | `@scope/arc-<domain>` | arc + whatever | — |

Same noun, `arc-` prefix disambiguates — the module for the `invoice` kernel
is `arc-invoice` (never "invoicing"). Bundles are plain functions returning
`ArcModule[]` with ports pre-wired (e.g. `createFinanceBundle` = accounting +
invoicing + revenue); composition convenience, never a boundary — bundles
can't split into services, modules can.

## Contribution DX

- `createXModule(deps)` is the entire authoring surface — publishable by
  anyone as `@scope/arc-<domain>`.
- arc CLI `generate module` (planned): package skeleton + module factory +
  testkit test.
- Deps typed and explicit → a consumer reads ONE type to integrate.
