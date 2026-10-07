/**
 * Module input-form resolution — thunks / promises / plain modules, and the
 * array-or-factory `ModuleContribution` shape shared by every module arm.
 */

import type { FastifyInstance } from "fastify";
import { activateBridges, type SkippedBridge } from "./graph.js";
import type { ArcModule, ArcModuleInput, LazyBridge, ModuleContribution } from "./types.js";

export function isLazyBridge(input: ArcModuleInput): input is LazyBridge {
  return (
    typeof input === "object" &&
    input !== null &&
    !(input instanceof Promise) &&
    typeof (input as { load?: unknown }).load === "function"
  );
}

/**
 * Resolve every input, then drop inactive bridges — a `LazyBridge` is decided
 * from its DECLARED `name` + `dependsOn`, so an inactive one is never imported.
 * Input order is preserved (it is `orderModules`' tie-break).
 */
export async function resolveModules(
  inputs: readonly ArcModuleInput[],
): Promise<{ active: ArcModule[]; skipped: SkippedBridge[] }> {
  const { active, skipped, lazyByName } = await declareModules(inputs);
  return { active: await loadActiveBridges(active, lazyByName), skipped };
}

/** Replace each active lazy bridge's declaration with the module it loads. */
export function loadActiveBridges(
  active: readonly ArcModule[],
  lazyByName: ReadonlyMap<string, LazyBridge>,
): Promise<ArcModule[]> {
  return Promise.all(
    active.map((m) => {
      const lazy = lazyByName.get(m.name);
      return lazy ? loadLazyBridge(lazy) : m;
    }),
  );
}

/**
 * Resolve every input and activate bridges WITHOUT loading a lazy bridge — its declaration
 * stands in for it. The shared first half of `resolveModules` and `planModules`.
 */
export async function declareModules(inputs: readonly ArcModuleInput[]): Promise<{
  active: ArcModule[];
  skipped: SkippedBridge[];
  lazyByName: ReadonlyMap<string, LazyBridge>;
}> {
  const declared = await Promise.all(
    inputs.map((input): Promise<ArcModule> | ArcModule =>
      isLazyBridge(input)
        ? {
            name: input.name,
            kind: "bridge",
            dependsOn: input.dependsOn,
            ...(input.requires ? { requires: input.requires } : {}),
          }
        : resolveModule(input),
    ),
  );
  const { active, skipped } = activateBridges(declared);
  const lazyByName = new Map(inputs.filter(isLazyBridge).map((b) => [b.name, b] as const));
  return { active, skipped, lazyByName };
}

/** The loaded module must be the bridge that was declared — activation was decided on the declaration. */
async function loadLazyBridge(lazy: LazyBridge): Promise<ArcModule> {
  const m = await resolveModule(lazy.load);
  const deps = [...(m.dependsOn ?? [])].sort().join(",");
  if (
    m.name !== lazy.name ||
    m.kind !== "bridge" ||
    deps !== [...lazy.dependsOn].sort().join(",") ||
    portsKey(m.requires) !== portsKey(lazy.requires)
  ) {
    throw new Error(
      `[arc] lazy bridge "${lazy.name}" loaded a module that does not match its declaration ` +
        `(got name "${m.name}", kind "${m.kind ?? "domain"}", dependsOn [${deps}], requires ` +
        `${portsKey(m.requires)}). Activation and the requirement check were decided on the declared ` +
        "name + dependsOn + requires, so they must be identical.",
    );
  }
  return m;
}

/** A stable fingerprint of a `requires` declaration, for the declared-vs-loaded comparison. */
function portsKey(requires: ArcModule["requires"]): string {
  const list = (names: readonly string[] | undefined) => [...(names ?? [])].sort().join(",");
  return `ports[${list(requires?.ports)}] optional[${list(requires?.optionalPorts)}] modules[${list(requires?.modules)}]`;
}

/**
 * Resolve any module-input form to a concrete `ArcModule`. A thunk is invoked
 * (this is where a dynamic `import()` fires); a promise (or plain module) is
 * awaited. Called once per module at the start of the bootstrap phase.
 */
export async function resolveModule(input: ArcModuleInput): Promise<ArcModule> {
  if (isLazyBridge(input)) return loadLazyBridge(input);
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
