/**
 * Arc modules — a whole domain composed into an app as one entry.
 *
 * An `ArcModule` is a domain package's entire contribution (engine init +
 * resources + post-wiring) as one value:
 *
 * ```ts
 * createApp({ modules: [accountingModule({ permissions })], resources: [health] })
 * ```
 *
 * Sugar over the existing lifecycle: each module expands into the SAME phases,
 * in `dependsOn` order, running BEFORE the app-level entry for that phase.
 * `onClose` runs in REVERSE.
 *
 * RESOURCES have two intentional orderings: app resources RESOLVE first,
 * module resources REGISTER first (prepended, so their routes mount ahead).
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
 * contribution can close over booted engines instead of a global getter.
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
   * Contain handler failures: a throw is logged via `fastify.log` and swallowed
   * instead of reaching the transport.
   *
   * **Off by default, deliberately** — reaching the transport is what makes the
   * durable path work (unacked → redelivered → DLQ). Turn it ON for
   * fire-and-forget work (projections, cache invalidation, fan-out) where a
   * failure must not block the ack.
   *
   * ```ts
   * defineModule({ name: "search", eventHandlers: [
   *   { name: "search.reindex", event: "product:*", handler: reindex, boundary: true },
   * ] })
   * ```
   *
   * The object form's `onError` replaces the default log; it runs INSIDE the
   * boundary, so a throwing `onError` is caught and logged too.
   */
  boundary?: boolean | { onError?: (error: Error, event: DomainEvent) => void | Promise<void> };
}

export interface ArcModule<
  TExports = unknown,
  TPorts extends PortName = PortName,
  TOptionalPorts extends PortName = PortName,
> {
  /** Stable identifier — appears in boot logs and duplicate-module detection. */
  readonly name: string;

  /**
   * Names of modules this one must be composed AFTER. A dependency's
   * `bootstrap` (and its `fastify.arc.modules[dep]` export) is always live
   * before this module's phases run; teardown runs in reverse.
   *
   * ```ts
   * defineModule({ name: "reservation", dependsOn: ["order"], bootstrap: (f) => {
   *   const order = getModuleExports<OrderEngine>(f, "order"); // guaranteed live
   * }});
   * ```
   *
   * STABLE topological sort: modules with no edge between them keep list
   * order. Unknown names, self-references and cycles fail at boot.
   *
   * Orders COMPOSITION, not importing — every input (thunks included) is
   * imported up front. Every HARD sibling dependency belongs here, even one
   * read via `lazyRequiredModuleExports`; omit it only for optional
   * integrations (`lazyModuleExports` / `getOptionalModuleExports`).
   */
  readonly dependsOn?: readonly ModuleName[];
  /**
   * - `'domain'` (default).
   * - `'bridge'` joins two or more domains (order ↔ accounting): ACTIVE only when every
   *   `dependsOn` module is composed, dropped otherwise — no gate code.
   * - `'platform'` — infrastructure (auth, outbox, notifications): orders ahead of every other
   *   ready module, and `resolveModuleClosure` includes it in every closure.
   * - `'aggregator'` reads across the whole composed fleet (data cleanup, period close): it
   *   orders AFTER every non-aggregator module, as if it `dependsOn` all of them. A module that
   *   `dependsOn` an aggregator is therefore a cycle.
   */
  readonly kind?: "domain" | "bridge" | "platform" | "aggregator";
  /**
   * The events this module OWNS — the facts it publishes, one owner per event, each named inside
   * `eventNamespace`. What it consumes is derived from `eventHandlers`. Checked at boot by
   * `createApp({ moduleGraph: { events } })`; rendered by `renderModuleGraph`.
   */
  readonly publishes?: readonly (string | { readonly name: string })[];
  /**
   * Owner prefix(es) of every event in `publishes` — `order` owns `order:placed` and
   * `order.placed`. A list when one module owns several aggregates (`['order', 'rma']`).
   * Default: the module name.
   */
  readonly eventNamespace?: string | readonly string[];

  /**
   * What must be SUPPLIED or COMPOSED for this module to boot — checked before any module boots,
   * every gap in one error. Ordering stays `dependsOn`'s job; nothing here adds an edge.
   *
   * ```ts
   * defineModule({ name: "order", requires: { ports: ["outbox"], optionalPorts: ["calendar"], modules: ["invoice"] },
   *   bootstrap: (f, { ports }) => createOrderEngine(ports.outbox, ports.calendar) })
   * ```
   */
  readonly requires?: ModuleRequirements<TPorts, TOptionalPorts>;

  /**
   * Infra SETUP — the module analog of the app's `plugins()`. Runs after the
   * app's own `plugins()`, in `dependsOn` order, before any module `bootstrap`.
   *
   * ⚠ NOT a Fastify plugin: arc CALLS it, never `register()`s it. So you
   * register your own (`await fastify.register(x)`, not `return x` — a
   * returned function is read as a DISPOSER), and there is no encapsulation
   * or prefix: decorators land on the shared instance. Returning an `fp()`
   * plugin throws; a bare multi-arg function warns.
   *
   * Receives `{ defer }` for teardown, or return one disposer as shorthand.
   *
   * ```ts
   * plugins: async (fastify) => {
   *   await fastify.register(somePlugin, { prefix: '/x' });
   *   const conn = await connect();
   *   return () => conn.close();
   * },
   * ```
   */
  plugins?: (
    fastify: FastifyInstance,
    context: ModuleSetupContext<TPorts, TOptionalPorts>,
  ) => ModuleDisposer | undefined | Promise<ModuleDisposer | undefined>;

  /**
   * Domain error mappers this module ships (see `defineErrorMapper`). Merged
   * into the app's error handler at boot, AFTER any host-declared mappers —
   * host config keeps priority; module mappers follow in composition order.
   * The host no longer has to know every domain's error classes.
   */
  readonly errorMappers?: readonly ErrorMapper[];

  /**
   * Domain init — runs after all `plugins`, before resources, so engines are
   * live when this module's `resources` factory runs.
   *
   * The returned value is the module's PUBLIC EXPORT at
   * `fastify.arc.modules[name]`; later modules read it with
   * `getModuleExports<T>(fastify, name)`. Because the return slot is taken,
   * teardown goes through `defer`, registered the moment each resource exists:
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
    context: ModuleSetupContext<TPorts, TOptionalPorts>,
  ) => TExports | Promise<TExports>;

  /**
   * App-level resource NAMES this module SUPERSEDES: an app resource of the
   * same name is dropped and this module's registered instead.
   *
   * PREFER `owns: "provided"` — derived from the resources the module actually
   * returned, so the claim cannot disagree with reality. An explicit array is
   * ENFORCED at boot: each name must appear in THIS module's own `resources`
   * (a sibling's does not count), else a typo would silently remove the app's
   * route with nothing serving it.
   *
   * Filters only the APP list; a name matching no app resource is a no-op.
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
   * Post-registration wiring — runs once this module's routes are mounted.
   * Receives `{ defer }` and may return a disposer, same as `plugins`.
   */
  afterResources?: (
    fastify: FastifyInstance,
    context: ModuleSetupContext<TPorts, TOptionalPorts>,
  ) => ModuleDisposer | undefined | Promise<ModuleDisposer | undefined>;

  /**
   * Readiness checks for `/_health/ready`, merged BEFORE the host's
   * `arcPlugins.health` checks. Names must be unique across the module graph
   * (boot fails on a collision).
   *
   * STATIC by design (not a factory): collection happens before the health
   * plugin registers, so `check()` should resolve dependencies LAZILY.
   *
   * ```ts
   * defineModule({ name: "inventory", healthChecks: [
   *   { name: "flow-engine", check: () => flow.isReady() },
   * ] })
   * ```
   */
  readonly healthChecks?: readonly HealthCheck[];

  /**
   * Domain-event subscriptions this module owns. Subscribed in dependency order
   * during `afterResources`; unsubscribed at shutdown BEFORE module `onClose`
   * (deps still alive). Named handlers must be unique across the graph;
   * declaring handlers with `arcPlugins.events: false` fails at boot.
   *
   * ```ts
   * defineModule({ name: "party", eventHandlers: [
   *   { name: "party.link-customer", event: ["customer:created"], handler: onCustomer },
   * ] })
   * ```
   */
  readonly eventHandlers?: ModuleContribution<EventHandlerDefinition>;

  /**
   * Durable workflows this module owns. OPAQUE to arc core — the streamline
   * integration (`@classytic/arc/integrations/streamline`) validates and
   * registers them after module bootstraps.
   *
   * ```ts
   * defineModule({ name: "invoice",
   *   workflows: (f) => createInvoiceWorkflows(f.streamlineContainer) })
   * ```
   */
  readonly workflows?: ModuleContribution<unknown>;

  /**
   * Recurring interval schedules, composed into `schedulesPlugin` after
   * bootstraps. Names must be unique across the graph; locking is configured
   * via `arcPlugins.schedules`, and disabling that runner fails boot rather
   * than silently dropping work.
   *
   * ```ts
   * defineModule({ name: "loyalty", scheduledJobs: [
   *   { name: "loyalty.point.expiration", every: 3_600_000, handler: () => sweep() },
   * ] })
   * ```
   */
  readonly scheduledJobs?: ModuleContribution<ScheduleDefinition>;

  /**
   * Teardown — destroy engines, stop timers, flush the outbox. Modules close in
   * REVERSE composition order, BEFORE the app-level `onClose` and infra
   * plugins' close hooks (so teardown still sees a live DB/Redis).
   *
   * Boot is transactional: if any phase fails, every module that entered an
   * init phase (this one included) is closed in reverse, then the original
   * error is rethrown. A closer runs AT MOST ONCE; a throwing one never blocks
   * the rest.
   *
   * Rollback can follow a PARTIAL init, so guard what init may not have
   * reached (`client?.close()`), or prefer `defer` for step-by-step
   * acquisition. `onClose` runs FIRST, ahead of deferred disposers.
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
 * A thunk of a dynamic import loads a module only when selected (region- or
 * tier-gated packs):
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
  | (() => ArcModule<TExports> | Promise<ArcModule<TExports>>)
  | LazyBridge<TExports>;

/**
 * A bridge whose graph identity is declared up front, so arc decides activation
 * BEFORE importing it — a bridge to a domain that is not composed is never
 * loaded, not merely never activated. (A plain thunk must run before its
 * `dependsOn` is known.) The loaded module must match the declaration.
 *
 * ```ts
 * modules: [order, {
 *   kind: "bridge", name: "order-accounting", dependsOn: ["order", "accounting"],
 *   load: () => import("./bridges/order-accounting.js").then((m) => m.create(deps)),
 * }]
 * ```
 */
export interface LazyBridge<TExports = unknown> {
  readonly kind: "bridge";
  readonly name: string;
  readonly dependsOn: readonly ModuleName[];
  /** Must equal the loaded module's `requires` — `planModules` checks ports without loading it. */
  readonly requires?: ModuleRequirements;
  readonly load: () => ArcModule<TExports> | Promise<ArcModule<TExports>>;
}

/**
 * Host collaborators by name — augment it so ports are typed and a misspelt name is a compile error:
 *
 * ```ts
 * declare module "@classytic/arc/factory" {
 *   interface ArcPortRegistry { outbox: OutboxStore; calendar: BusinessCalendar }
 * }
 * ```
 */
// biome-ignore lint/suspicious/noEmptyInterface: augmentation target (declaration merging)
export interface ArcPortRegistry {}

/** A registered port name. */
export type PortName = keyof ArcPortRegistry & string;

/** What `createApp({ ports })` accepts — any registered port, typed by the registry. */
export type ArcPorts = { readonly [K in PortName]?: ArcPortRegistry[K] };

/** The ports one module's setup phases see: required ones typed present, optional ones `| undefined`. */
export type ModulePorts<TPorts extends PortName, TOptionalPorts extends PortName> = {
  readonly [K in TPorts]: ArcPortRegistry[K];
} & { readonly [K in TOptionalPorts]?: ArcPortRegistry[K] };

/** What a module needs from its host. See `ArcModule.requires`. */
export interface ModuleRequirements<
  TPorts extends PortName = PortName,
  TOptionalPorts extends PortName = PortName,
> {
  /** Ports that must be supplied to `createApp({ ports })`. */
  readonly ports?: readonly TPorts[];
  /** Ports handed over when supplied, `undefined` otherwise. */
  readonly optionalPorts?: readonly TOptionalPorts[];
  /**
   * Modules that must be COMPOSED, with no ordering edge — a mutual request-time need
   * (accounting ⇄ invoice) a two-way `dependsOn` would make a cycle. Read the peer lazily.
   */
  readonly modules?: readonly ModuleName[];
}

/**
 * Typed module registry — augment via declaration merging so
 * `getModuleExports(f, "order")` infers the export type:
 *
 * ```ts
 * declare module "@classytic/arc/factory" {
 *   interface ArcModuleRegistry {
 *     order: OrderEngine;
 *     accounting: AccountingEngine;
 *   }
 * }
 * ```
 */
// biome-ignore lint/suspicious/noEmptyInterface: augmentation target (declaration merging)
export interface ArcModuleRegistry {}

/**
 * Host-level composition switches. A HOST (never a package) sets `strictModuleNames: true` once
 * every module it composes is in `ArcModuleRegistry`; then a misspelt `dependsOn` /
 * `requires.modules` name is a compile error.
 *
 * ```ts
 * declare module "@classytic/arc/factory" { interface ArcCompositionConfig { strictModuleNames: true } }
 * ```
 */
// biome-ignore lint/suspicious/noEmptyInterface: augmentation target (declaration merging)
export interface ArcCompositionConfig {}

/** A module name as a reference: a registry key under `strictModuleNames`, else any string. */
export type ModuleName = ArcCompositionConfig extends { readonly strictModuleNames: true }
  ? keyof ArcModuleRegistry & string
  : string;
