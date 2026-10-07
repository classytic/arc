/**
 * Composition planning — the composability check, the dry-run plan, and module closures.
 *
 * `createApp` and `planModules` run the SAME steps (`declareModules` → `assertComposable` →
 * `orderModules`), so a plan cannot disagree with a boot.
 */

import type { SkippedBridge } from "./graph.js";
import { orderModules } from "./order.js";
import { declareModules, loadActiveBridges } from "./resolve.js";
import type { ArcModule, ArcModuleInput, ArcPorts, ModuleName } from "./types.js";

/** One reason a module list cannot boot. `message` names the module, what is missing, and the fix. */
export interface CompositionProblem {
  readonly code:
    | "duplicate-module"
    | "self-dependency"
    | "missing-dependency"
    | "missing-module"
    | "missing-port";
  readonly module: string;
  /** The missing module or port, or the duplicated name. */
  readonly target: string;
  readonly message: string;
}

/** A port counts as supplied when it is an own key whose value is neither `undefined` nor `null`. */
function isSupplied(ports: Readonly<Record<string, unknown>>, name: string): boolean {
  return Object.hasOwn(ports, name) && ports[name] !== undefined && ports[name] !== null;
}

/**
 * Every problem in an ACTIVE module list (bridges already activated): duplicate names,
 * self/missing `dependsOn`, unmet `requires.modules`, unsupplied `requires.ports`. Cycles are
 * `orderModules`' to report, with their path.
 */
export function compositionProblems(
  modules: readonly Pick<ArcModule, "name" | "dependsOn" | "requires">[],
  ports: ArcPorts = {},
): CompositionProblem[] {
  const supplied: Readonly<Record<string, unknown>> = ports;
  const composed = new Set<string>();
  const problems: CompositionProblem[] = [];
  const add = (code: CompositionProblem["code"], module: string, target: string, message: string) =>
    problems.push({ code, module, target, message });
  for (const m of modules) {
    if (composed.has(m.name)) {
      add(
        "duplicate-module",
        m.name,
        m.name,
        `Duplicate module name "${m.name}" — it is composed twice; remove the duplicate from createApp({ modules })`,
      );
    }
    composed.add(m.name);
  }
  for (const m of modules) {
    for (const dep of m.dependsOn ?? []) {
      if (dep === m.name) {
        add(
          "self-dependency",
          m.name,
          dep,
          `module "${m.name}" dependsOn itself — remove the self-reference`,
        );
      } else if (!composed.has(dep)) {
        add(
          "missing-dependency",
          m.name,
          dep,
          `module "${m.name}" dependsOn "${dep}", which is not composed — add the "${dep}" module to createApp({ modules }), or drop the dependency`,
        );
      }
    }
    for (const dep of m.requires?.modules ?? []) {
      if (!composed.has(dep)) {
        add(
          "missing-module",
          m.name,
          dep,
          `module "${m.name}" requires "${dep}" to be composed — add the "${dep}" module to createApp({ modules })`,
        );
      }
    }
    for (const port of m.requires?.ports ?? []) {
      if (!isSupplied(supplied, port)) {
        add(
          "missing-port",
          m.name,
          port,
          `module "${m.name}" requires port "${port}" — supply createApp({ ports: { ${port} } })`,
        );
      }
    }
  }
  return problems;
}

/** Throw ONE error listing every composition problem, or return. */
export function assertComposable(
  modules: readonly Pick<ArcModule, "name" | "dependsOn" | "requires">[],
  ports?: ArcPorts,
): void {
  const problems = compositionProblems(modules, ports);
  if (problems.length === 0) return;
  throw new Error(
    `[arc] cannot compose the module graph — nothing was booted (${problems.length} problem${problems.length === 1 ? "" : "s"}):\n` +
      problems.map((p) => `  - ${p.message}`).join("\n"),
  );
}

/** The ports handed to one module's setup phases — only those it declared, frozen. */
export function portsForModule(
  module: Pick<ArcModule, "requires">,
  ports: ArcPorts = {},
): ArcPorts {
  const supplied: Readonly<Record<string, unknown>> = ports;
  const own: Record<string, unknown> = {};
  for (const name of [
    ...(module.requires?.ports ?? []),
    ...(module.requires?.optionalPorts ?? []),
  ]) {
    if (isSupplied(supplied, name)) own[name] = supplied[name];
  }
  return Object.freeze(own);
}

/** What `createApp` would compose — without booting anything or loading a lazy bridge. */
export interface ModulePlan {
  /** Module names in boot order (bootstrap order; teardown is the reverse). */
  readonly order: readonly string[];
  /** Active `kind: 'bridge'` modules, in boot order. */
  readonly activeBridges: readonly string[];
  /** Bridges dropped because a module they join is not composed. */
  readonly skippedBridges: readonly SkippedBridge[];
}

export interface PlanModulesOptions {
  /** The ports the app will receive — checked exactly as `createApp({ ports })` checks them. */
  readonly ports?: ArcPorts;
}

/**
 * Dry-run a composition: resolve inputs, activate bridges, order, check requirements — the same
 * functions `createApp` calls, so the plan fails where boot would and orders as boot would.
 *
 * Thunks ARE invoked (their result is the module); a `LazyBridge` is decided on its declaration
 * and never loaded.
 */
export async function planModules(
  inputs: readonly ArcModuleInput[],
  options: PlanModulesOptions = {},
): Promise<ModulePlan> {
  const { active, skipped } = await declareModules(inputs);
  assertComposable(active, options.ports);
  const ordered = orderModules(active);
  return Object.freeze({
    order: Object.freeze(ordered.map((m) => m.name)),
    activeBridges: Object.freeze(ordered.filter((m) => m.kind === "bridge").map((m) => m.name)),
    skippedBridges: Object.freeze([...skipped]),
  });
}

/** Boot-time composition: `planModules`' steps, with active lazy bridges loaded. */
export async function composeModules(
  inputs: readonly ArcModuleInput[],
  ports: ArcPorts | undefined,
): Promise<{ modules: ArcModule[]; skipped: SkippedBridge[] }> {
  const { active, skipped, lazyByName } = await declareModules(inputs);
  assertComposable(active, ports);
  const loaded = await loadActiveBridges(active, lazyByName);
  const modules = orderModules(loaded);
  return { modules, skipped };
}

/** The graph identity `resolveModuleClosure` reads — an `ArcModule` or a `LazyBridge` both fit. */
export interface ClosureNode {
  readonly name: string;
  readonly kind?: ArcModule["kind"];
  readonly dependsOn?: readonly string[];
  readonly requires?: ArcModule["requires"];
}

/**
 * The modules `roots` need to boot: their `dependsOn` and `requires.modules` closure, plus every
 * `kind: 'platform'` module (and its own closure). Returned in INPUT order, so ordering the result
 * matches ordering the full list.
 *
 * Bridges are not pulled in — a bridge joins domains, it is not needed by them. An aggregator
 * root brings only its declared edges: it reads whatever is composed.
 *
 * Throws on an unknown root, or an edge to a module that is not in `modules`.
 */
export function resolveModuleClosure<T extends ClosureNode>(
  modules: readonly T[],
  roots: readonly ModuleName[],
): T[] {
  const byName = new Map(modules.map((m) => [m.name, m] as const));
  const unknown = roots.filter((r) => !byName.has(r));
  if (unknown.length > 0) {
    throw new Error(
      `[arc] resolveModuleClosure: unknown root module(s) ${unknown.map((r) => `"${r}"`).join(", ")}. ` +
        `Modules: ${[...byName.keys()].join(", ") || "(none)"}.`,
    );
  }
  const included = new Set<string>();
  const visit = (name: string, from: string | undefined): void => {
    if (included.has(name)) return;
    const m = byName.get(name);
    if (!m) {
      throw new Error(
        `[arc] resolveModuleClosure: module "${from}" needs "${name}", which is not in the module list.`,
      );
    }
    included.add(name);
    for (const dep of m.dependsOn ?? []) visit(dep, name);
    for (const dep of m.requires?.modules ?? []) visit(dep, name);
  };
  for (const root of roots) visit(root, undefined);
  for (const m of modules) if (m.kind === "platform") visit(m.name, undefined);
  return modules.filter((m) => included.has(m.name));
}
