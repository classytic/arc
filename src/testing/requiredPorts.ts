/**
 * Assert a module declares EXACTLY `ports` as required, and that composing it without any one of
 * them fails naming the module and that port — alone, and all together in one error. `[]` asserts
 * it declares none and plans with nothing supplied. `with` composes peers it depends on; `ports`
 * supplies what they need. Pass `ports` as a literal, never the module's own list: dropping a port
 * from the module must fail here.
 *
 * ```ts
 * it("fails loud without each port", () =>
 *   assertRequiresPorts(createOrderModule(deps), ["connection", "outbox"], { with: [catalog] }));
 * ```
 */

import { compositionProblems, planModules } from "../factory/module/plan.js";
import { declareModules, resolveModule } from "../factory/module/resolve.js";
import type { ArcModuleInput, ArcPorts } from "../factory/module/types.js";

export interface RequiredPortsOptions {
  /** Modules composed alongside — the peers the module `dependsOn` or `requires.modules`. */
  readonly with?: readonly ArcModuleInput[];
  /** Ports supplied in every case — the peers' own required ports. Never one under test. Values are never read. */
  readonly ports?: Readonly<Record<string, unknown>>;
}

export interface RequiredPortsResult {
  readonly module: string;
  /** The required ports, in declared order. */
  readonly ports: readonly string[];
}

export async function assertRequiresPorts(
  module: ArcModuleInput,
  ports: readonly string[],
  options: RequiredPortsOptions = {},
): Promise<RequiredPortsResult> {
  const peers = options.with ?? [];
  const base: Readonly<Record<string, unknown>> = options.ports ?? {};
  const fail = (msg: string): never => {
    throw new Error(`[arc/testing] assertRequiresPorts: ${msg}`);
  };

  const target = await resolveModule(module);
  const name = target.name;
  const { active } = await declareModules([...peers, module]);
  if (!active.some((m) => m.name === name))
    fail(`module "${name}" is not active in this composition`);
  const declared = target.requires?.ports ?? [];
  if (!sameList(declared, ports)) {
    fail(
      `module "${name}" declares required ports [${declared.join(", ")}], expected [${ports.join(", ")}]`,
    );
  }
  const shadowed = ports.filter((p) => Object.hasOwn(base, p));
  if (shadowed.length > 0) fail(`options.ports supplies a port under test: ${shadowed.join(", ")}`);

  const supplying = (names: readonly string[]): ArcPorts => {
    const out: Record<string, unknown> = { ...base };
    for (const p of names) out[p] = Object.freeze({ port: p });
    return out;
  };
  const missingFor = (supplied: ArcPorts): string[] => {
    const problems = compositionProblems(active, supplied);
    const foreign = problems.filter((p) => p.module !== name || p.code !== "missing-port");
    if (foreign.length > 0) {
      fail(
        `the composition has problems besides the module's ports — fix \`with\`/\`ports\`:\n${foreign.map((p) => `  - ${p.message}`).join("\n")}`,
      );
    }
    return problems.map((p) => p.target);
  };

  const unplanned = await planModules([...peers, module], { ports: supplying(ports) }).catch(
    (err: unknown) => err,
  );
  if (unplanned instanceof Error)
    fail(`module "${name}" does not plan with every port supplied: ${unplanned.message}`);

  if (ports.length === 0) return { module: name, ports };

  const allMissing = missingFor(supplying([]));
  if (!sameList(allMissing, ports)) {
    fail(
      `with no port supplied, module "${name}" reported [${allMissing.join(", ")}], expected [${ports.join(", ")}] in ONE error`,
    );
  }
  const refused = await planModules([...peers, module], { ports: supplying([]) }).then(
    () => null,
    (err: unknown) => (err instanceof Error ? err.message : String(err)),
  );
  if (refused === null) fail(`module "${name}" planned with none of its required ports supplied`);
  for (const port of ports) {
    const missing = missingFor(supplying(ports.filter((p) => p !== port)));
    if (!sameList(missing, [port])) {
      fail(
        `without "${port}", module "${name}" reported [${missing.join(", ")}], expected exactly ["${port}"]`,
      );
    }
    if (!refused?.includes(`module "${name}" requires port "${port}"`)) {
      fail(`the composition error does not name module "${name}" and port "${port}": ${refused}`);
    }
  }
  return { module: name, ports };
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}
