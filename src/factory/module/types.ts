/**
 * Arc modules — compose a whole domain into an app with one entry.
 *
 * A resource is a single route group. A **module** is a self-contained domain
 * package's contribution to an app: its engine init, its resources, and its
 * post-registration wiring, bundled as one value. Instead of the host hand-
 * threading a package's pieces across `bootstrap`, `resources`, and
 * `afterResources`, the package exports one `ArcModule` and the host lists it:
 *
 * ```ts
 * const app = await createApp({
 *   modules: [accountingModule({ permissions }), orderModule({ permissions })],
 *   resources: [healthResource],   // app-local resources still compose alongside
 * });
 * ```
 *
 * `modules` is pure sugar over the existing lifecycle — arc expands each module
 * into the SAME phases a hand-wired app uses. Modules compose in `dependsOn`
 * order (their original list order when no edges are declared), and run BEFORE
 * the app-level entry in every phase:
 *
 * ```
 * plugins        = app plugins()  →  modules' plugins  (infra registration)
 * bootstrap[]    = modules' bootstrap  →  options.bootstrap  (engine init + export)
 * resources[]    = modules' resources  →  options.resources / resourceDir
 * afterResources = modules' afterResources  →  options.afterResources
 * onClose        = modules' onClose (REVERSE order)  →  options.onClose
 * ```
 *
 * So a module's engine is live before app-level bootstrap runs, app-level
 * `afterResources` can wire across modules, and — within the module set — a
 * dependency's `plugins`/`bootstrap` runs before any module that `dependsOn`
 * it.
 *
 * Resources are the ONE phase with two distinct orderings, both intentional:
 * app `resources`/`resourceDir` RESOLVE first (their semantics untouched), but
 * module resources REGISTER first (they're prepended, so routes mount ahead of
 * app resources — matching "modules before app-level"). Either way a module
 * resource flows arc's normal registration (prefix, dedup, OpenAPI, audit) — it
 * is not special-cased.
 *
 * This is the seam a domain package composes through: `createXModule(deps)`
 * returns an `ArcModule`, the host owns the composition. No proxy, no per-call
 * lazy bridges — engines are initialized in `bootstrap` and passed live into
 * `defineResource(...)` inside the `resources` factory.
 *
 * Directory map (mechanical split of the former single file):
 *   types.ts         — the module contract (this file)
 *   resolve.ts       — input-form resolution (thunks / promises / contributions)
 *   order.ts         — `dependsOn` stable topological ordering
 *   contributions.ts — health / workflow / schedule collection
 *   lifecycle.ts     — event-handler subscription + teardown
 *   index.ts         — `defineModule`, `getModuleExports`, public barrel
 */

import type { FastifyInstance } from "fastify";
import type { DomainEvent, EventHandler } from "../../events/EventTransport.js";
import type { ErrorMapper } from "../../plugins/errorHandler.js";
import type { HealthCheck } from "../../plugins/health.js";
import type { ScheduleDefinition } from "../../plugins/schedules.js";
import type { ResourceLike } from "../loadResources.js";
import type { ModuleDisposer, ModuleSetupContext } from "./disposers.js";

/**
 * A module's contribution of some arm (event handlers, scheduled jobs, …).
 * Either a static array or a factory resolved AFTER all module bootstraps, so a
 * contribution can close over booted engines / the Fastify instance instead of
 * reaching for a global getter (the coupling the module contract removes).
 */
export type ModuleContribution<T> =
  | readonly T[]
  | ((fastify: FastifyInstance) => readonly T[] | Promise<readonly T[]>);

/**
 * A domain-event subscription a module owns. Subscribed in dependency order
 * during the `afterResources` phase (routes mounted, engines booted) and
 * auto-unsubscribed at shutdown BEFORE module `onClose` (deps still alive).
 */
export interface EventHandlerDefinition {
  /** Event pattern(s) to subscribe — same matcher as `fastify.events.subscribe`. */
  event: string | readonly string[];
  /** The subscriber. */
  handler: EventHandler;
  /**
   * Optional stable name — enables duplicate detection + teardown diagnostics.
   * Third-party modules should prefix it with their module name, for example
   * `inventory.order-created`; Arc does not silently rewrite public names.
   */
  name?: string;
  /**
   * Contain handler failures inside an error boundary — arc wraps `handler`
   * with `wrapWithBoundary`, so a throw is logged (through `fastify.log`, with
   * `{ err, event, eventId, handler }`) and swallowed instead of reaching the
   * transport.
   *
   * **Off by default, deliberately.** Reaching the transport is what makes the
   * durable path work: `RedisStreamTransport` leaves the message unacked, so it
   * is redelivered and eventually DLQ'd. Silently swallowing by default would
   * turn every module handler into best-effort delivery.
   *
   * Turn it ON for fire-and-forget work — projections, cache invalidation,
   * notification fan-out — where a failure must not block the ack and a retry
   * would only delay the next event's resync. That is precisely the case where
   * a module author would otherwise abandon this arm for an imperative
   * `subscribeWithBoundary` call in `afterResources` and lose arc's
   * teardown-before-`onClose` guarantee.
   *
   * ```ts
   * defineModule({ name: "search", eventHandlers: [
   *   { name: "search.reindex", event: "product:*", handler: reindex, boundary: true },
   * ] })
   * ```
   *
   * The object form adds an `onError` sink (metrics / alerting) in place of the
   * default log; it runs INSIDE the boundary, so a throwing `onError` is itself
   * caught and logged rather than escaping.
   */
  boundary?: boolean | { onError?: (error: Error, event: DomainEvent) => void | Promise<void> };
}

export interface ArcModule<TExports = unknown> {
  /** Stable identifier — appears in boot logs and duplicate-module detection. */
  readonly name: string;

  /**
   * Names of modules this one must be composed AFTER. arc topologically orders
   * the `modules` array from these edges before ANY phase runs, so a
   * dependency's `bootstrap` (and thus its `fastify.arc.modules[dep]` export)
   * is always live before this module's bootstrap, resources, or
   * afterResources. Teardown (`onClose`) runs in the reverse of that order.
   *
   * Use this instead of relying on list position when a module reads another's
   * public export — e.g. `@classytic/arc-reservation` wiring off
   * `arc.modules.order`:
   *
   * ```ts
   * defineModule({ name: "reservation", dependsOn: ["order"], bootstrap: (f) => {
   *   const order = getModuleExports<OrderEngine>(f, "order"); // guaranteed live
   *   …
   * }});
   * ```
   *
   * The order is a STABLE topological sort: modules with no `dependsOn` (and
   * any two modules with no edge between them) keep their original list order,
   * so adding `dependsOn` never silently reorders an unrelated module. All
   * failure modes are fail-fast at boot: a name not in the composed set, a
   * self-reference, and dependency CYCLES each throw with the offending path.
   *
   * **`dependsOn` is COMPOSITION order, not lazy loading.** Every module input
   * (including dynamic-import thunks) is resolved — imported — up front via
   * `Promise.all` BEFORE the sort; `dependsOn` then orders the *composition*
   * (which module's `plugins`/`bootstrap` runs first), it does NOT delay
   * *importing* a dependent until its dependency is ready. Use a thunk to gate
   * whether a module is imported at all (region/tier packs); use `dependsOn`
   * to order modules that are already selected.
   *
   * **Convention: every HARD sibling dependency belongs here** — including
   * ones read lazily. `lazyRequiredModuleExports` defers the export READ to
   * first use (and eagerly validates the module is composed), but only
   * `dependsOn` orders composition so the sibling's engine exists before
   * yours initializes. Omit the edge only for genuinely optional
   * integrations (`lazyModuleExports` / `getOptionalModuleExports`).
   */
  readonly dependsOn?: readonly string[];

  /**
   * Fastify plugins / decorators this module needs — the module-level analog
   * of the app's `plugins()` slot. Runs in the plugins phase: AFTER the app's
   * own `plugins()` (so module infra can build on app foundations like a DB
   * connection) and in `dependsOn` order, but BEFORE any module `bootstrap` —
   * so engines initialised in `bootstrap` can rely on what's registered here.
   *
   * Separating this from `bootstrap` keeps lifecycle intent explicit for
   * published ecosystem packages: `plugins` = "register infra"; `bootstrap` =
   * "initialise engines (and return the public export)". Registering a plugin
   * inside `bootstrap` still works — this slot just makes the two distinct.
   *
   * Receives `{ defer }` to register teardown for anything it acquires, and
   * may RETURN a single disposer as shorthand for the one-resource case:
   *
   * ```ts
   * plugins: async (fastify) => {
   *   const conn = await connect();
   *   return () => conn.close();          // equivalent to defer(...)
   * },
   * ```
   */
  plugins?: (
    fastify: FastifyInstance,
    context: ModuleSetupContext,
  ) => ModuleDisposer | undefined | Promise<ModuleDisposer | undefined>;

  /**
   * Domain error mappers this module ships (see `defineErrorMapper`). Merged
   * into the app's error handler at boot, AFTER any host-declared mappers —
   * host config keeps priority; module mappers follow in composition order.
   *
   * Closes the "composition root must know every domain's error classes"
   * coupling: before this slot, adding `@classytic/arc-shipping` meant
   * remembering to also register its `ShippingError` mapper in the host's
   * `errorHandler.errorMappers` — forget it and the domain error crossed the
   * wire as an opaque 500. Now the module carries its own mapper:
   *
   * ```ts
   * defineModule({
   *   name: 'shipping',
   *   errorMappers: [shippingErrorMapper],
   *   ...
   * })
   * ```
   */
  readonly errorMappers?: readonly ErrorMapper[];

  /**
   * Domain init — runs in the `bootstrap` phase (after all `plugins`, before
   * resources). Initialize engines / singletons / event subscriptions here so
   * they are live when this module's `resources` factory runs.
   *
   * A returned value becomes the module's PUBLIC EXPORT, recorded at
   * `fastify.arc.modules[name]` (wiki/modules.md — "no container", layer 2).
   * Later modules' bootstraps can read it (list order = init order), which is
   * how cross-module ports are wired without a DI container. Declare the
   * export shape via `defineModule<TExports>` and read it back with the typed
   * accessor — no cast at the consuming end:
   *
   * ```ts
   * // arc-invoice bootstrap, composed AFTER arc-accounting:
   * const acct = getModuleExports<AccountingEngine>(fastify, "accounting");
   * ```
   *
   * The return value is the module's export, so teardown here goes through
   * `defer` (the second argument) rather than a returned disposer — register
   * each resource the moment it exists and partial-init cleanup becomes exact
   * instead of a chain of `?.` guards:
   *
   * ```ts
   * bootstrap: async (fastify, { defer }) => {
   *   const client = await openClient();
   *   defer(() => client.close());
   *   const engine = await createEngine(client);   // if this throws, only
   *   defer(() => engine.stop());                  // the client is released
   *   return engine;
   * },
   * ```
   */
  bootstrap?: (
    fastify: FastifyInstance,
    context: ModuleSetupContext,
  ) => TExports | Promise<TExports>;

  /**
   * App-level resource NAMES this module authoritatively SUPERSEDES. When the
   * host also lists (or `resourceDir`-discovers) a resource of the same name,
   * arc DROPS the app copy and registers THIS module's version instead — so the
   * host keeps NO hand-maintained "which resources did modules take over" filter
   * set. Ownership lives on the atom that provides it (colocated, drift-proof):
   *
   * ```ts
   * defineModule({ name: "order", owns: ["order", "quotation", "rfq"], resources: () => [...] })
   * ```
   *
   * Semantics:
   *   - Purely a supersede-the-app-fork switch — it filters the *app* resource
   *     list, never the module's own `resources` (those always register).
   *   - Idempotent + tolerant on the APP side: an `owns` entry with no matching
   *     app resource is a silent no-op — a module may pre-declare a name before
   *     any fork exists.
   *   - Collected across ALL modules; the app-side supersession is their union.
   *
   * **Prefer `owns: "provided"`** (2.32) — arc derives the list from the
   * resources this module actually returned, so the claim and the reality
   * cannot disagree:
   *
   * ```ts
   * defineModule({ name: "order", owns: "provided", resources: () => [...] })
   * ```
   *
   * That is the whole arm for most modules. Resources are resolved exactly
   * once, names are validated (duplicates within a module are rejected), the
   * effective `owns` is derived, and supersession runs afterward — one atomic
   * phase arc owns, rather than a rule each module re-states.
   *
   * **The explicit-array form is ENFORCED at boot: if you `owns` a name,
   * PROVIDE it** — in THIS module's own `resources`. Arc fails boot when a
   * claimed name is not among them, naming the module, the unmet names, and
   * what it did supply. Without that check, a typo or a resource deleted
   * without updating the list booted "successfully" with the app's route
   * silently removed and nothing serving it. Two real cases, both silent 404s:
   * a POS module claiming a checkout resource it mounted only when the host
   * supplied a pipeline, and a device gateway claiming a name it never
   * provided at all.
   *
   * Keep the explicit array only when the list is genuinely NOT the module's
   * own resource set — e.g. pre-declaring a name before the fork exists.
   *
   * A sibling module supplying the name does NOT satisfy the claim — ownership
   * is local to the module that declares it, which is the colocation this arm
   * exists for.
   */
  readonly owns?: readonly string[] | "provided";

  /**
   * The module's resources. Array or factory — the factory form runs AFTER all
   * bootstraps, so `defineResource(...)` receives fully-booted engines. Flows
   * through arc's normal registration (prefix, dedup, docs), identical to a
   * top-level `resources` entry.
   */
  resources?:
    | ReadonlyArray<ResourceLike>
    | ((
        fastify: FastifyInstance,
      ) => ReadonlyArray<ResourceLike> | Promise<ReadonlyArray<ResourceLike>>);

  /**
   * Post-registration wiring — runs in the `afterResources` phase, once this
   * module's routes are mounted. Use for cross-resource event subscriptions the
   * module owns.
   *
   * Receives `{ defer }`, and may return a disposer, on the same terms as
   * `plugins` — handy for wiring that must be unwound (a subscription, a
   * listener) without hoisting a handle into module scope.
   */
  afterResources?: (
    fastify: FastifyInstance,
    context: ModuleSetupContext,
  ) => ModuleDisposer | undefined | Promise<ModuleDisposer | undefined>;

  /**
   * Readiness checks this module contributes to the app's
   * `healthPlugin` (`/_health/ready`). Collected across ALL modules in
   * dependency order and merged BEFORE the host's app-level `arcPlugins.health`
   * checks (modules-first, host-last) — the same additive convention arc uses
   * for resources and error mappers. Check `name`s must be unique across the
   * module graph (arc fails at boot on a collision, attributing both owners).
   *
   * STATIC by design (not a factory): declare the check up front and let its
   * `check()` closure resolve dependencies LAZILY at probe time, so collection
   * can happen before the health plugin registers and the worker probe
   * (`createWorker`) receives the identical union without a second registration.
   *
   * ```ts
   * defineModule({ name: "inventory", healthChecks: [
   *   { name: "flow-engine", check: () => flow.isReady() },
   * ] })
   * ```
   */
  readonly healthChecks?: readonly HealthCheck[];

  /**
   * Domain-event subscriptions this module owns — the declarative replacement
   * for imperative `fastify.events.subscribe(...)` calls inside
   * `afterResources`. Subscribed in dependency order during the
   * `afterResources` phase (routes mounted, engines booted), and arc RETAINS
   * every unsubscribe and invokes it at shutdown BEFORE module `onClose` (while
   * module deps are still alive). Named handlers must be unique across the
   * module graph; a module that declares handlers while the event subsystem is
   * disabled (`arcPlugins.events: false`) fails at boot. Array or factory (the
   * factory runs after bootstraps, so it can close over booted engines).
   *
   * ```ts
   * defineModule({ name: "party", eventHandlers: [
   *   { name: "party.link-customer", event: ["customer:created"], handler: onCustomer },
   * ] })
   * ```
   */
  readonly eventHandlers?: ModuleContribution<EventHandlerDefinition>;

  /**
   * Durable workflows this module owns. OPAQUE to arc core — arc never imports
   * `@classytic/streamline`; the value flows through untouched and the
   * streamline integration (`@classytic/arc/integrations/streamline`, a peer)
   * gives it meaning (name/shape validation, registration). Collected via
   * `collectModuleWorkflows` at integration-init time (after module bootstraps),
   * so a factory can close over the shared workflow container the integration
   * decorates on the instance.
   *
   * ```ts
   * defineModule({ name: "invoice",
   *   workflows: (f) => createInvoiceWorkflows(f.streamlineContainer) })
   * ```
   */
  readonly workflows?: ModuleContribution<unknown>;

  /**
   * Recurring interval schedules this module owns. Arc composes them into its
   * existing `schedulesPlugin` after bootstraps, in dependency order. Names
   * must be unique across the module graph. Configure multi-replica locking via
   * `arcPlugins.schedules`; explicitly disabling that runner while a module
   * declares schedules fails boot instead of silently dropping work. Array or
   * factory (the factory runs once after bootstraps and may close over engines).
   *
   * ```ts
   * defineModule({ name: "loyalty", scheduledJobs: [
   *   { name: "loyalty.point.expiration", every: 3_600_000, handler: () => sweep() },
   * ] })
   * ```
   */
  readonly scheduledJobs?: ModuleContribution<ScheduleDefinition>;

  /**
   * Teardown — destroy engines, stop timers, flush the module's outbox.
   * Modules close in REVERSE composition order (last composed, first closed),
   * mirroring init, BEFORE the app-level `onClose` and before infra plugins'
   * own close hooks (so teardown still sees a live DB/Redis).
   *
   * Boot is transactional: if any phase fails mid-boot — including THIS
   * module's own `plugins`/`bootstrap` — arc immediately closes every module
   * that entered an init phase, this closer included, in reverse order, then
   * rethrows the original boot error. A closer runs AT MOST ONCE across the
   * rollback and shutdown paths, and one throwing closer never blocks the
   * rest (best-effort; failures are logged).
   *
   * Because rollback fires after a PARTIAL init — your `bootstrap` opened a
   * client and threw on the next line, or your `plugins` ran but `bootstrap`
   * never did — write closers defensively. Guard everything init may not have
   * reached: `client?.close()`, not `client.close()`.
   *
   * ```ts
   * let client: Client | undefined;
   * defineModule({
   *   name: "billing",
   *   bootstrap: async () => {
   *     client = await openClient();   // allocated…
   *     await migrate(client);         // …and this may throw
   *   },
   *   onClose: async () => { await client?.close(); },  // still runs
   * });
   * ```
   *
   * Prefer `defer` (the setup phases' second argument) for anything acquired
   * step-by-step: it registers each teardown at the point of acquisition, so
   * the runtime knows exactly what was reached and the `?.` guards above
   * disappear. `onClose` remains the right slot for tearing down what
   * `bootstrap` RETURNED — the module's engine — and runs FIRST, ahead of the
   * module's deferred disposers (see `disposers.ts` for the ordering rule).
   * The two compose; either alone is complete.
   */
  onClose?: (fastify: FastifyInstance) => void | Promise<void>;
}

/**
 * A module in any of the forms `createApp({ modules })` accepts:
 *
 *   - `ArcModule`                      — eager (already imported)
 *   - `Promise<ArcModule>`             — an in-flight import
 *   - `() => ArcModule | Promise<…>`   — a thunk, resolved at boot
 *
 * The **thunk of a dynamic import** is the point of this union — it lets a host
 * compose modules *logically* and load them *lazily / conditionally*, the
 * `next/dynamic` idea applied to backend domains. The module's code (and its
 * heavy deps) is only pulled in when the thunk runs, so region- or tier-gated
 * packs never enter the bundle path they aren't selected for:
 *
 * ```ts
 * const taxPack =
 *   region === "BD"
 *     ? () => import("@classytic/bd-tax").then((m) => m.createBdTaxModule(deps))
 *     : () => import("@classytic/us-tax").then((m) => m.createUsTaxModule(deps));
 *
 * await createApp({ modules: [coreModule(deps), taxPack] });
 * // only the selected tax package is imported + composed
 * ```
 */
export type ArcModuleInput<TExports = unknown> =
  | ArcModule<TExports>
  | Promise<ArcModule<TExports>>
  | (() => ArcModule<TExports> | Promise<ArcModule<TExports>>);

/**
 * Typed module registry — hosts augment this via declaration merging so
 * `getModuleExports(f, "order")` infers the export type without a manual type
 * argument (the fastify / awilix pattern):
 *
 * ```ts
 * declare module "@classytic/arc/factory" {
 *   interface ArcModuleRegistry {
 *     order: OrderEngine;
 *     accounting: AccountingEngine;
 *   }
 * }
 * ```
 *
 * Left empty here so the fallback `getModuleExports<T>(f, name: string)` stays
 * available for apps that don't augment it.
 */
// biome-ignore lint/suspicious/noEmptyInterface: augmentation target (declaration merging)
export interface ArcModuleRegistry {}
