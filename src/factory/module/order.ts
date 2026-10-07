/**
 * `dependsOn` composition ordering — stable topological sort with fail-fast
 * validation and concrete cycle reporting.
 */

import type { ArcModule } from "./types.js";

/**
 * Order modules for composition — a STABLE topological sort. Every later phase
 * (bootstrap, resources, afterResources, reverse-order onClose) iterates the
 * returned list, so a module's dependencies are always composed before it.
 *
 * Edges: each module's `dependsOn`, plus an implicit edge from every
 * `kind: 'aggregator'` module to every non-aggregator one. Among READY modules a
 * `kind: 'platform'` one is emitted first; otherwise list order breaks ties, so
 * declaring an edge never reorders an unrelated module.
 *
 * Throws on a duplicate name, a `dependsOn` name not composed, a self-reference,
 * or a cycle (reporting the concrete `a → b → … → a` path).
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

  const edges = effectiveEdges(modules);
  const originalIndex = new Map<string, number>();
  let nextIndex = 0;
  for (const m of modules) originalIndex.set(m.name, nextIndex++);
  const pendingDeps = new Map<string, number>(
    modules.map((m) => [m.name, (edges.get(m.name) ?? []).length]),
  );
  const dependents = new Map<string, string[]>();
  for (const m of modules) {
    for (const dep of edges.get(m.name) ?? []) {
      const list = dependents.get(dep);
      if (list) list.push(m.name);
      else dependents.set(dep, [m.name]);
    }
  }

  // Stable Kahn, O(N²) ready-scan (N is tens). Rank = (platform first, then list order).
  const rank = (m: ArcModule): number =>
    (m.kind === "platform" ? 0 : modules.length) + (originalIndex.get(m.name) ?? 0);
  const ordered: ArcModule[] = [];
  const remaining = new Set(modules.map((m) => m.name));
  while (remaining.size > 0) {
    let pick: ArcModule | undefined;
    let pickRank = Number.POSITIVE_INFINITY;
    for (const name of remaining) {
      if (pendingDeps.get(name) !== 0) continue;
      const candidate = byName.get(name);
      if (!candidate) continue;
      const r = rank(candidate);
      if (r < pickRank) {
        pick = candidate;
        pickRank = r;
      }
    }
    if (pick === undefined) {
      throw new Error(describeModuleCycle(remaining, edges));
    }
    ordered.push(pick);
    remaining.delete(pick.name);
    for (const dependent of dependents.get(pick.name) ?? []) {
      pendingDeps.set(dependent, (pendingDeps.get(dependent) ?? 1) - 1);
    }
  }
  return ordered;
}

/** Declared `dependsOn` plus each aggregator's implicit edge to every non-aggregator module. */
function effectiveEdges(modules: readonly ArcModule[]): Map<string, readonly string[]> {
  const fleet = modules.filter((m) => m.kind !== "aggregator").map((m) => m.name);
  return new Map(
    modules.map((m) => [
      m.name,
      m.kind === "aggregator"
        ? [...new Set([...(m.dependsOn ?? []), ...fleet])]
        : [...(m.dependsOn ?? [])],
    ]),
  );
}

/** Walk the still-unordered subgraph for one concrete cycle path. */
function describeModuleCycle(
  remaining: Set<string>,
  edges: ReadonlyMap<string, readonly string[]>,
): string {
  const stack: string[] = [];
  const onStack = new Set<string>();
  const done = new Set<string>();
  let cycle: string[] | null = null;

  const walk = (name: string): void => {
    if (cycle) return;
    stack.push(name);
    onStack.add(name);
    for (const dep of edges.get(name) ?? []) {
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
    "module both point at, declare the softer direction as `requires.modules` " +
    "(presence only, no ordering edge), or wire it through an event/port. A module " +
    "that dependsOn a `kind: 'aggregator'` module is always a cycle."
  );
}
