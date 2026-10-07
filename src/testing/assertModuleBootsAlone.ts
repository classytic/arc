/**
 * Boot a module inside its closure — `resolveModuleClosure` (its `dependsOn` and
 * `requires.modules`, transitively, plus every platform module) and every bridge in the list,
 * which arc activates only when both ends are present — and fail naming the module when the boot
 * or the `probe` throws. A hidden edge fails here, by name.
 *
 * ```ts
 * it("order boots alone", () => assertModuleBootsAlone(allModules, "order", { probe: (t) => drivePorts(t) }));
 * ```
 */

import { resolveModuleClosure } from "../factory/module/plan.js";
import { isLazyBridge, resolveModule } from "../factory/module/resolve.js";
import type { ArcModule, ArcModuleInput, LazyBridge, ModuleName } from "../factory/module/types.js";
import {
  type BootModuleAppOptions,
  type BootModulesInput,
  bootModuleApp,
  type ModuleTestApp,
} from "./bootModuleApp.js";

export interface ModuleBootsAloneOptions<TConn = unknown> extends BootModuleAppOptions<TConn> {
  /** Runs against the booted closure before it closes — drive the module's cross-module ports. */
  probe?: (t: ModuleTestApp<TConn>) => void | Promise<void>;
}

export interface ModuleBootsAloneResult {
  /** The closure's modules (bridges excluded), in input order. */
  readonly closure: readonly string[];
}

export async function assertModuleBootsAlone<TConn = unknown>(
  modules: BootModulesInput<TConn>,
  /** The module — or several roots booted together, when a deployment rule pairs them. */
  name: ModuleName | readonly ModuleName[],
  options: ModuleBootsAloneOptions<TConn> = {},
): Promise<ModuleBootsAloneResult> {
  const roots: readonly ModuleName[] = typeof name === "string" ? [name] : name;
  const label = roots.map((r) => `"${r}"`).join(" + ");
  let closure: readonly string[] = [];
  try {
    const { probe, ...bootOptions } = options;
    const t = await bootModuleApp<TConn>(async (ctx) => {
      const resolved = typeof modules === "function" ? await modules(ctx) : modules;
      const inputs: readonly ArcModuleInput[] = isInputList(resolved) ? resolved : [resolved];
      const nodes = await Promise.all(
        inputs.map((input): ArcModule | LazyBridge | Promise<ArcModule> =>
          isLazyBridge(input) ? input : resolveModule(input),
        ),
      );
      const included = new Set(resolveModuleClosure(nodes, roots).map((m) => m.name));
      closure = nodes.filter((m) => included.has(m.name)).map((m) => m.name);
      return nodes.filter((m) => included.has(m.name) || m.kind === "bridge");
    }, bootOptions);
    try {
      await probe?.(t);
    } finally {
      await t.close();
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `[arc/testing] module ${label} does not boot alone in its closure ` +
        `[${closure.join(", ") || "unresolved"}]: ${msg}`,
      { cause: err },
    );
  }
  return { closure };
}

function isInputList(
  value: ArcModuleInput | readonly ArcModuleInput[],
): value is readonly ArcModuleInput[] {
  return Array.isArray(value);
}
