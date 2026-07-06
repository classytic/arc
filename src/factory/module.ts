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
 */

import type { FastifyInstance } from "fastify";
import type { ResourceLike } from "./loadResources.js";

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
   */
  plugins?: (fastify: FastifyInstance) => void | Promise<void>;

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
   */
  bootstrap?: (fastify: FastifyInstance) => TExports | Promise<TExports>;

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
   */
  afterResources?: (fastify: FastifyInstance) => void | Promise<void>;

  /**
   * Teardown — registered as a Fastify `onClose` hook. Destroy engines, stop
   * timers, flush the module's outbox. Modules close in REVERSE list order
   * (last composed, first closed), mirroring init.
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
 * Resolve any module-input form to a concrete `ArcModule`. A thunk is invoked
 * (this is where a dynamic `import()` fires); a promise (or plain module) is
 * awaited. Called once per module at the start of the bootstrap phase.
 */
export async function resolveModule(input: ArcModuleInput): Promise<ArcModule> {
  const resolved = typeof input === "function" ? await input() : await input;
  if (!resolved || typeof resolved !== "object" || typeof resolved.name !== "string") {
    throw new Error(
      "[arc] a `modules` entry resolved to something that is not an ArcModule " +
        "(expected an object with a string `name`). Check dynamic-import thunks " +
        "return `createXModule(deps)` (or the module object), not the namespace.",
    );
  }
  return resolved;
}

/**
 * Order modules for composition by their `dependsOn` edges — a STABLE
 * topological sort. Called once at the start of the bootstrap phase; every
 * subsequent phase (bootstrap, resources, afterResources, and reverse-order
 * onClose) iterates the returned list, so a module's declared dependencies are
 * always composed before it.
 *
 * "Stable" = modules with no edge between them keep their original list order,
 * so declaring `dependsOn` on one module never silently reorders an unrelated
 * one. Backward compatible: a `modules` array with NO `dependsOn` anywhere is
 * returned unchanged.
 *
 * Fail-fast — throws (never reorders past a broken contract) on:
 *   - duplicate module names (the name is the graph key)
 *   - a `dependsOn` name not present in the composed set
 *   - a self-reference (`dependsOn` includes the module's own name)
 *   - a dependency cycle (reports the concrete `a → b → … → a` path)
 */
export function orderModules(modules: readonly ArcModule[]): ArcModule[] {
  // The name is the graph key — a duplicate would corrupt ordering, so this is
  // also the single place duplicate module names are rejected.
  const byName = new Map<string, ArcModule>();
  for (const m of modules) {
    if (byName.has(m.name)) {
      throw new Error(
        `[arc] Duplicate module name "${m.name}" — composed twice; check your modules array.`,
      );
    }
    byName.set(m.name, m);
  }

  // Validate every declared edge up front (clearer than surfacing it mid-sort).
  for (const m of modules) {
    for (const dep of m.dependsOn ?? []) {
      if (dep === m.name) {
        throw new Error(`[arc] module "${m.name}" dependsOn itself — remove the self-reference.`);
      }
      if (!byName.has(dep)) {
        throw new Error(
          `[arc] module "${m.name}" dependsOn "${dep}", which is not composed. ` +
            `Add the "${dep}" module to createApp({ modules }) (before this one is fine — ` +
            `arc orders them), or drop the dependency. ` +
            `Composed modules: ${[...byName.keys()].join(", ") || "(none)"}.`,
        );
      }
    }
  }

  // Fast path — no edges anywhere means the original order already satisfies
  // every (empty) constraint. Return a copy, unchanged.
  if (modules.every((m) => !m.dependsOn || m.dependsOn.length === 0)) {
    return [...modules];
  }

  // Stable Kahn: repeatedly emit the LOWEST-original-index module whose deps
  // are all already emitted. N is small (tens of modules at most), so the
  // O(N²) ready-scan is the simplest correct form.
  const originalIndex = new Map<string, number>();
  let nextIndex = 0;
  for (const m of modules) originalIndex.set(m.name, nextIndex++);
  const pendingDeps = new Map<string, number>(
    modules.map((m) => [m.name, (m.dependsOn ?? []).length]),
  );
  // dep name → modules that declared it (so emitting `dep` unblocks them).
  const dependents = new Map<string, string[]>();
  for (const m of modules) {
    for (const dep of m.dependsOn ?? []) {
      const list = dependents.get(dep);
      if (list) list.push(m.name);
      else dependents.set(dep, [m.name]);
    }
  }

  const ordered: ArcModule[] = [];
  const remaining = new Set(modules.map((m) => m.name));
  while (remaining.size > 0) {
    // Emit the ready module (all deps already emitted) with the lowest
    // original index — that's what makes the sort STABLE.
    let pick: string | undefined;
    let pickIndex = Number.POSITIVE_INFINITY;
    for (const name of remaining) {
      if (pendingDeps.get(name) !== 0) continue;
      const index = originalIndex.get(name) ?? Number.POSITIVE_INFINITY;
      if (index < pickIndex) {
        pick = name;
        pickIndex = index;
      }
    }
    if (pick === undefined) {
      // Everything remaining has an unmet dependency → a cycle. Report one.
      throw new Error(describeModuleCycle(remaining, byName));
    }
    const picked = byName.get(pick);
    if (!picked) {
      // Unreachable: `pick` came from `remaining`, seeded from the same modules
      // as `byName`. Throw rather than silently emit N-1 modules if a future
      // refactor ever lets the two diverge — fail-fast over a silent drop.
      throw new Error(`[arc] internal: ordered module "${pick}" is missing from the index`);
    }
    ordered.push(picked);
    remaining.delete(pick);
    for (const dependent of dependents.get(pick) ?? []) {
      pendingDeps.set(dependent, (pendingDeps.get(dependent) ?? 1) - 1);
    }
  }
  return ordered;
}

/** Walk the still-unordered subgraph for one concrete cycle path. */
function describeModuleCycle(remaining: Set<string>, byName: Map<string, ArcModule>): string {
  const stack: string[] = [];
  const onStack = new Set<string>();
  const done = new Set<string>();
  let cycle: string[] | null = null;

  const walk = (name: string): void => {
    if (cycle) return;
    stack.push(name);
    onStack.add(name);
    for (const dep of byName.get(name)?.dependsOn ?? []) {
      if (!remaining.has(dep)) continue; // already ordered — not in the cycle
      if (onStack.has(dep)) {
        cycle = [...stack.slice(stack.indexOf(dep)), dep];
        return;
      }
      if (!done.has(dep)) walk(dep);
      if (cycle) return;
    }
    onStack.delete(name);
    stack.pop();
    done.add(name);
  };

  for (const name of remaining) {
    if (!done.has(name)) walk(name);
    if (cycle) break;
  }
  const path = cycle ? (cycle as string[]).join(" → ") : [...remaining].join(", ");
  return (
    `[arc] module dependency cycle: ${path}. ` +
    "Modules cannot dependsOn each other circularly — break it with a shared " +
    "module both point at, or wire the softer direction through an event/port " +
    "instead of a hard dependsOn."
  );
}

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

/**
 * Identity helper for authoring a typed module — mirrors `defineResource`.
 * Gives inference + a single obvious construction site; does no work.
 *
 * `TExports` is inferred from the `bootstrap` return value, so a module
 * author gets a typed public export for free:
 *
 * ```ts
 * export const accountingModule = (deps: Deps) =>
 *   defineModule({
 *     name: "accounting",
 *     bootstrap: async () => createAccountingEngine(deps), // TExports inferred
 *   });
 * ```
 */
export function defineModule<TExports = unknown>(module: ArcModule<TExports>): ArcModule<TExports> {
  return module;
}

/**
 * Typed accessor for a module's public export (its `bootstrap` return value),
 * recorded at `fastify.arc.modules[name]`.
 *
 * Throwing, in line with the fail-fast contract (and `requireOrgId`-style
 * accessors): a missing entry means the module either isn't composed, is
 * composed AFTER the caller (list order = init order), or returned nothing —
 * all wiring bugs that must surface at boot, not as `undefined` downstream.
 *
 * The type parameter is an assertion, not a proof. Two ways to type it:
 *   - augment `ArcModuleRegistry` once — then the name alone infers the type:
 *     `getModuleExports(f, "accounting")` → `AccountingEngine`.
 *   - or pass it inline: `getModuleExports<AccountingEngine>(f, "accounting")`.
 */
export function getModuleExports<K extends keyof ArcModuleRegistry>(
  fastify: FastifyInstance,
  name: K,
): ArcModuleRegistry[K];
export function getModuleExports<TExports = unknown>(
  fastify: FastifyInstance,
  name: string,
): TExports;
export function getModuleExports(fastify: FastifyInstance, name: string): unknown {
  const modules = fastify.arc?.modules;
  // `Object.hasOwn`, not `name in modules` — the latter walks the prototype
  // chain, so a module named "constructor"/"toString"/etc. that never exported
  // would spuriously pass and return an `Object.prototype` member. (The map is
  // also created null-proto in registerResources, but this is the honest read.)
  if (!modules || !Object.hasOwn(modules, name)) {
    const available = modules ? Object.keys(modules) : [];
    throw new Error(
      `[arc] no public export recorded for module "${name}".\n` +
        `A module's export is its bootstrap() return value; it is readable only AFTER that module's bootstrap ran (dependsOn / list order = init order).\n` +
        `Modules with recorded exports: ${available.length ? available.join(", ") : "(none)"}.`,
    );
  }
  return modules[name];
}
