/**
 * Module public surface — `defineModule` / `getModuleExports` plus the
 * barrel over the mechanical split (see types.ts header for the map).
 */

import type { FastifyInstance } from "fastify";
import type { ArcModule, ArcModuleRegistry } from "./types.js";

export {
  collectModuleHealthChecks,
  collectModuleScheduledJobs,
  collectModuleWorkflows,
} from "./contributions.js";
export { subscribeModuleEventHandlers, unsubscribeModuleEventHandlers } from "./lifecycle.js";
export { orderModules } from "./order.js";
export { resolveContribution, resolveModule } from "./resolve.js";
export {
  getModuleState,
  hasModule,
  initModuleStates,
  type ModuleState,
  setModuleState,
} from "./state.js";
export { createModuleTeardown, type ModuleTeardown } from "./teardown.js";
export type {
  ArcModule,
  ArcModuleInput,
  ArcModuleRegistry,
  EventHandlerDefinition,
  ModuleContribution,
} from "./types.js";

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
 *
 * Siblings, for the two shapes this one is wrong for:
 *   - `getOptionalModuleExports` — the module is genuinely OPTIONAL.
 *   - `lazyModuleExports` / `lazyRequiredModuleExports` — the read happens at
 *     composition time, where boot order decides the answer.
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
  const recorded = readModuleExports(fastify, name);
  if (recorded === ABSENT) {
    const available = fastify.arc?.modules ? Object.keys(fastify.arc.modules) : [];
    throw new Error(
      `[arc] no public export recorded for module "${name}".\n` +
        `A module's export is its bootstrap() return value; it is readable only AFTER that module's bootstrap ran (dependsOn / list order = init order).\n` +
        `Modules with recorded exports: ${available.length ? available.join(", ") : "(none)"}.`,
    );
  }
  return recorded;
}

/**
 * Sentinel for "no entry recorded", distinct from a recorded `undefined`.
 *
 * registerResources never records an `undefined` export, so today the two
 * cannot both happen — but encoding absence as `undefined` would make the
 * optional/required accessors disagree the day that changes, and a required
 * accessor that stops throwing is exactly the silent-null class of bug these
 * helpers exist to remove.
 */
const ABSENT = Symbol("arc.module.absent");

/** The one honest read of the module-export map, shared by every accessor. */
function readModuleExports(fastify: FastifyInstance, name: string): unknown {
  const modules = fastify.arc?.modules;
  // `Object.hasOwn`, not `name in modules` — the latter walks the prototype
  // chain, so a module named "constructor"/"toString"/etc. that never exported
  // would spuriously pass and return an `Object.prototype` member. (The map is
  // also created null-proto in registerResources, but this is the honest read.)
  if (!modules || !Object.hasOwn(modules, name)) return ABSENT;
  return modules[name];
}

/**
 * Non-throwing sibling of `getModuleExports`: `undefined` when the module is
 * not composed (or has not bootstrapped yet).
 *
 * Exists because OPTIONAL sibling modules are a first-class composition shape —
 * a deployment that turns `inventory` off still sells services, so its POS
 * module must ask "is inventory here?" rather than fail-fast. Hosts were
 * spelling that question as
 *
 * ```ts
 * (fastify as unknown as { arc?: { modules?: Record<string, unknown> } })
 *   .arc?.modules?.inventory;
 * ```
 *
 * — a double cast that (a) defeats `ArcModuleRegistry` inference, (b) silently
 * survives a typo in the module name, and (c) is impossible to grep for. Use
 * `getModuleExports` when the dependency is REQUIRED (boot must fail), this
 * when it is genuinely optional.
 *
 * Prefer `lazyModuleExports` whenever the read happens at COMPOSITION time —
 * see its doc for why a value read once can latch `undefined` forever.
 */
export function getOptionalModuleExports<K extends keyof ArcModuleRegistry>(
  fastify: FastifyInstance,
  name: K,
): ArcModuleRegistry[K] | undefined;
export function getOptionalModuleExports<TExports = unknown>(
  fastify: FastifyInstance,
  name: string,
): TExports | undefined;
export function getOptionalModuleExports(fastify: FastifyInstance, name: string): unknown {
  const recorded = readModuleExports(fastify, name);
  return recorded === ABSENT ? undefined : recorded;
}

/**
 * Is a module's public export recorded yet? The predicate form of
 * `getOptionalModuleExports`, for readiness gates (`ready: () => ...`) that
 * should not have to reason about falsy-but-present exports.
 */
export function hasModuleExports(fastify: FastifyInstance, name: string): boolean {
  return readModuleExports(fastify, name) !== ABSENT;
}

/**
 * A DEFERRED reader of a sibling module's export: returns a getter that reads
 * the registry at CALL time, not now.
 *
 * ── Why this exists (the bug it removes) ─────────────────────────────────────
 *
 * Module composition runs bootstraps in dependency/list order, but a lot of
 * wiring is *registered* earlier than it *runs*: an `eventHandlers` factory, a
 * bridge accessor handed to another module, a hook added during bootstrap and
 * fired per request. Such a factory can execute BEFORE the sibling it needs has
 * bootstrapped — so a sibling engine captured into a local at that moment is
 * `undefined`, and stays `undefined` for the life of the process even though the
 * sibling came up milliseconds later.
 *
 * That failure is SILENT by construction: the consumer sees a null bridge and
 * treats it as "this deployment has no inventory / no revenue engine", which is
 * a legitimate configuration. Real cost in this codebase: orders were created
 * and never payment-confirmed (no entitlement, no card, no door) and nothing
 * errored anywhere.
 *
 * The getter therefore:
 *   - re-reads while the module is ABSENT, so boot order cannot matter;
 *   - memoizes the FIRST resolved value, so the steady-state read is a closure
 *     variable rather than a registry lookup per request;
 *   - never memoizes absence — that is precisely the latch this replaces.
 *
 * ```ts
 * const inventory = lazyModuleExports<FlowEngine>(fastify, "inventory");
 * return {
 *   flowBridge: () => (inventory() ? createFlowEngineBridge({ getFlowEngine: () => inventory()! }) : null),
 *   ready: () => inventory() !== undefined,
 * };
 * ```
 */
export function lazyModuleExports<K extends keyof ArcModuleRegistry>(
  fastify: FastifyInstance,
  name: K,
): () => ArcModuleRegistry[K] | undefined;
export function lazyModuleExports<TExports = unknown>(
  fastify: FastifyInstance,
  name: string,
): () => TExports | undefined;
export function lazyModuleExports(fastify: FastifyInstance, name: string): () => unknown {
  let resolved: unknown = ABSENT;
  return () => {
    if (resolved === ABSENT) resolved = readModuleExports(fastify, name);
    return resolved === ABSENT ? undefined : resolved;
  };
}

/**
 * Required counterpart of `lazyModuleExports`: defers the read, then throws
 * `getModuleExports`' error if the module is still absent at first use.
 *
 * The pair matters because "required" and "readable now" are different
 * questions. A hook registered at bootstrap that needs the `order` engine at
 * REQUEST time is a hard dependency, but reading it eagerly turns a correct
 * composition into a boot crash purely because of list order. Deferring keeps
 * the fail-fast guarantee and moves it to the first moment the answer is
 * actually needed.
 *
 * Deferred does NOT mean unvalidated: a lazily-required module is still a
 * HARD dependency, so PRESENCE is checked eagerly. When the composed module
 * graph is known (any `createApp`/`registerResources` boot — the normal
 * case), a name that is not in the graph throws HERE, at composition time,
 * instead of surviving startup and failing on the first request or event.
 * Only the EXPORT read (does bootstrap's return value exist yet?) is
 * deferred to first call.
 *
 * Convention for hard sibling access: also declare the target in the
 * consumer's `dependsOn`. That orders composition (the sibling's bootstrap
 * runs first), while this accessor merely defers the read — the two are
 * complementary, not alternatives:
 *   - hard dependency, read during bootstrap → `dependsOn` + `getModuleExports`
 *   - hard dependency, read at request/event time → `dependsOn` + this
 *   - optional integration → `lazyModuleExports` (no `dependsOn` needed)
 */
export function lazyRequiredModuleExports<K extends keyof ArcModuleRegistry>(
  fastify: FastifyInstance,
  name: K,
): () => ArcModuleRegistry[K];
export function lazyRequiredModuleExports<TExports = unknown>(
  fastify: FastifyInstance,
  name: string,
): () => TExports;
export function lazyRequiredModuleExports(fastify: FastifyInstance, name: string): () => unknown {
  // Eager presence check against the composed graph (see JSDoc). The state
  // map is populated at the top of registerResources — before any lifecycle
  // callback where this accessor is legitimately created — so an absent map
  // means a bare embedding (unit test / manual wiring) and the check is
  // skipped rather than false-positived.
  const states = fastify.arc?.moduleStates;
  if (states !== undefined && !Object.hasOwn(states, name)) {
    const composed = Object.keys(states);
    throw new Error(
      `[arc] lazyRequiredModuleExports("${name}"): module "${name}" is not in the composed module graph. ` +
        "A lazily-required module is still a HARD dependency — compose it (and declare it in the consumer's `dependsOn`), " +
        "or use lazyModuleExports() if the integration is genuinely optional.\n" +
        `Composed modules: ${composed.length ? composed.join(", ") : "(none)"}.`,
    );
  }
  let resolved: unknown = ABSENT;
  return () => {
    // Only the ABSENT branch re-reads; once resolved this is a closure read.
    if (resolved === ABSENT) resolved = getModuleExports(fastify, name);
    return resolved;
  };
}
