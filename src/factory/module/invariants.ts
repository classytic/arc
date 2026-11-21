/**
 * Module facts and invariants — evaluated once, after composition planning and before any
 * module setup, by `composeModules` (boot) and `planModules` (dry run). Pure: no I/O, no
 * Fastify. `arc describe` runs the same evaluation over the modules an entry file exports.
 */

import { ArcBootError, type BootProblem, formatBootProblems } from "../../utils/bootError.js";
import type { ArcModule, ComposedModuleFacts, ModuleFacts } from "./types.js";

/** The outcome of one invariant. */
export interface InvariantResult {
  readonly module: string;
  readonly code: string;
  readonly fix: string;
  readonly ok: boolean;
  /** Why it failed — the check's own reason string, or a description of the misuse. */
  readonly reason?: string;
}

type InvariantSource = Pick<ArcModule, "name" | "facts" | "invariants">;

/** Every composed module's facts, frozen copies; `{}` for a module that declares none. */
function composedFacts(modules: readonly InvariantSource[]): ComposedModuleFacts {
  const all: Record<string, ModuleFacts> = Object.create(null);
  for (const m of modules) all[m.name] = deepFreeze(structuredClone(m.facts ?? {}));
  return Object.freeze(all);
}

/**
 * Evaluate every module's invariants. Never throws: a throwing, async or malformed check is
 * a failed result, so every problem reaches one report.
 */
export function evaluateModuleInvariants(modules: readonly InvariantSource[]): InvariantResult[] {
  const results: InvariantResult[] = [];
  const unserialisable = new Set<string>();
  for (const m of modules) {
    const path = firstUnserialisable(m.facts ?? {}, "facts");
    if (path !== undefined) {
      unserialisable.add(m.name);
      results.push({
        module: m.name,
        code: "module-facts-not-serialisable",
        fix: "facts hold plain data only: strings, numbers, booleans, null, arrays and plain objects",
        ok: false,
        reason: `${path} is not plain serialisable data`,
      });
    }
  }
  const all = composedFacts(modules.filter((m) => !unserialisable.has(m.name)));
  for (const m of modules) {
    if (unserialisable.has(m.name)) continue;
    const own = all[m.name] ?? {};
    for (const inv of m.invariants ?? []) {
      results.push({ module: m.name, code: inv.code, fix: inv.fix, ...runCheck(inv, own, all) });
    }
  }
  return results;
}

/** Throw ONE `ArcBootError` listing every failed invariant, or return. */
export function assertModuleInvariants(modules: readonly InvariantSource[]): void {
  const failed = evaluateModuleInvariants(modules).filter((r) => !r.ok);
  if (failed.length === 0) return;
  const problems: BootProblem[] = failed.map((r) => ({
    code: r.code,
    module: r.module,
    message: r.reason ?? "invariant failed",
    fix: r.fix,
  }));
  throw new ArcBootError(
    formatBootProblems("[arc] module invariants failed — no module was set up", problems),
    problems,
  );
}

function runCheck(
  inv: NonNullable<ArcModule["invariants"]>[number],
  own: ModuleFacts,
  all: ComposedModuleFacts,
): { ok: boolean; reason?: string } {
  let verdict: unknown;
  try {
    verdict = inv.check(own, all);
  } catch (err) {
    return {
      ok: false,
      reason: `check threw: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (verdict === true) return { ok: true };
  if (typeof verdict === "string" && verdict.length > 0) return { ok: false, reason: verdict };
  if (typeof (verdict as { then?: unknown } | null)?.then === "function") {
    // A floating rejection would surface as unhandled; the verdict is already "failed".
    Promise.resolve(verdict).catch(() => undefined);
    return { ok: false, reason: "check returned a Promise — invariants must be synchronous" };
  }
  return { ok: false, reason: "check returned false" };
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

/** The first path holding something JSON cannot carry faithfully, or `undefined`. */
function firstUnserialisable(value: unknown, path: string): string | undefined {
  if (value === null) return undefined;
  switch (typeof value) {
    case "string":
    case "boolean":
      return undefined;
    case "number":
      return Number.isFinite(value) ? undefined : path;
    case "object": {
      if (Array.isArray(value)) {
        for (const [i, v] of value.entries()) {
          const bad = firstUnserialisable(v, `${path}[${i}]`);
          if (bad !== undefined) return bad;
        }
        return undefined;
      }
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) return path;
      for (const [k, v] of Object.entries(value)) {
        const bad = firstUnserialisable(v, `${path}.${k}`);
        if (bad !== undefined) return bad;
      }
      return undefined;
    }
    default:
      return path;
  }
}
