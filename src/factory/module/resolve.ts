/**
 * Module input-form resolution — thunks / promises / plain modules, and the
 * array-or-factory `ModuleContribution` shape shared by every module arm.
 */

import type { FastifyInstance } from "fastify";
import type { ArcModule, ArcModuleInput, ModuleContribution } from "./types.js";

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
  // The name is the graph key, the `arc.modules` export key, the `dependsOn`
  // target, and the label in every boot/teardown diagnostic. An empty or
  // whitespace-only name satisfies `typeof === "string"` yet makes all four
  // unusable — `dependsOn: [""]` is unreadable, and the error messages built
  // around it render as `module ""`. Reject it here, at the one place every
  // module input converges.
  //
  // No naming REGEX beyond this: namespaced package-style names legitimately
  // contain `@`, `/`, `.` and `-`, so anything stricter would reject valid
  // ecosystem identities for no safety gain.
  if (resolved.name.trim().length === 0) {
    throw new Error(
      "[arc] a `modules` entry has an empty (or whitespace-only) `name`. A module's name is its " +
        "graph key, its `arc.modules` export key, its `dependsOn` target, and its label in every " +
        "boot diagnostic — give it a stable, non-empty identifier.",
    );
  }
  return resolved;
}

/** Resolve a `ModuleContribution` to a concrete array (array passthrough or factory call). */
export async function resolveContribution<T>(
  contribution: ModuleContribution<T> | undefined,
  fastify: FastifyInstance,
): Promise<readonly T[]> {
  if (!contribution) return [];
  return typeof contribution === "function" ? await contribution(fastify) : contribution;
}

/**
 * `resolveContribution` with module attribution — the form every arm collector
 * should use.
 *
 * A contribution factory closes over booted engines, so it throws for exactly
 * the reasons a bootstrap does ("connection unavailable", "engine not ready").
 * Bare, that message names neither the module nor the arm, which in a graph of
 * twenty modules turns a one-line fix into a bisect. Every other module
 * boundary (`plugins`, `bootstrap`, `resources`, `afterResources`) already
 * wraps with the owning module's name; this keeps the arms consistent with
 * them. The original error is preserved via `{ cause }`.
 */
export async function resolveModuleArm<T>(
  module: { readonly name: string },
  arm: "eventHandlers" | "scheduledJobs" | "workflows" | "healthChecks",
  contribution: ModuleContribution<T> | undefined,
  fastify: FastifyInstance,
): Promise<readonly T[]> {
  let resolved: readonly T[];
  try {
    resolved = await resolveContribution(contribution, fastify);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`[arc] module "${module.name}" ${arm} factory threw: ${msg}`, { cause: err });
  }
  // Same reasoning as the resources factory: a non-array here becomes an
  // unattributed spread/iteration error in the collector, naming neither the
  // module nor the arm. Kept OUT of the try above so the message says "returned"
  // rather than "threw" — the distinction tells the author where to look.
  if (!Array.isArray(resolved)) {
    throw new TypeError(
      `[arc] module "${module.name}" ${arm} factory must return an array — received ` +
        `${resolved === null ? "null" : typeof resolved}.`,
    );
  }
  return resolved;
}
