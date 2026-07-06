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
  plugins?(fastify): void | Promise<void>;         // infra registration (before bootstrap)
  bootstrap?(fastify): TExports | Promise<TExports>; // engine/singleton init; return = public export
  resources?: ResourceLike[] | ((fastify) => ResourceLike[] | Promise<...>);
  afterResources?(fastify): void | Promise<void>; // event subscriptions, cross-wiring
  onClose?(fastify): void | Promise<void>;        // teardown (engine.destroy, timers)
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

Module resources flow through arc's normal registration (prefix, dedup,
OpenAPI, audit) — never special-cased.

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
    afterResources: (f) => wireAccountingEvents(engine, deps.eventTransport),
    onClose: () => engine.destroy(),
  });
}
```

`createXModule(deps)` ≡ Nest's `X.forRoot(opts)` — but it's a plain function:
no decorators, no reflect-metadata, no provider tokens, no injector. Deps are
a typed object; "exports" are the package's public API (JS modules already
encapsulate — no runtime exports map).

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

```

```
