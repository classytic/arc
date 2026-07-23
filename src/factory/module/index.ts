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
