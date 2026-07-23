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
