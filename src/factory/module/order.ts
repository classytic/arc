/**
 * `dependsOn` composition ordering — stable topological sort with fail-fast
 * validation and concrete cycle reporting.
 */

import type { ArcModule } from "./types.js";

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
