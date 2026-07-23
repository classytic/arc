/**
 * `orderModules` — stable topological sort of the module set by `dependsOn`.
 *
 * Pure-function coverage of the ordering contract every phase relies on:
 * dependency-before-dependent, STABLE among independents (no silent reorder),
 * transitive chains, diamonds, and fail-fast on duplicate / missing / self /
 * cyclic edges. The composition wiring is proven separately in modules.test.ts.
 */
import { describe, expect, it } from "vitest";
import { type ArcModule, orderModules } from "../../src/factory/module/index.js";

const mod = (name: string, dependsOn?: string[]): ArcModule =>
  dependsOn ? { name, dependsOn } : { name };

const names = (mods: readonly ArcModule[]): string[] => mods.map((m) => m.name);

describe("orderModules — ordering", () => {
  it("returns the list unchanged when no module declares dependsOn", () => {
    const list = [mod("a"), mod("b"), mod("c")];
    expect(names(orderModules(list))).toEqual(["a", "b", "c"]);
  });

  it("places a dependency before its dependent even when listed after it", () => {
    // reservation is listed FIRST but dependsOn order → order must come first.
    const list = [mod("reservation", ["order"]), mod("order")];
    expect(names(orderModules(list))).toEqual(["order", "reservation"]);
  });

  it("resolves a transitive chain (c→b→a) into a→b→c", () => {
    const list = [mod("c", ["b"]), mod("b", ["a"]), mod("a")];
    expect(names(orderModules(list))).toEqual(["a", "b", "c"]);
  });

  it("is STABLE — every emittable module keeps original order; only the blocked one defers", () => {
    // x, y, z independent (idx 0,2,3); w (idx 1) depends on z. The sort keeps
    // x, y, z in their exact original order and defers w until z is emitted —
    // maximally stable (it never pulls z ahead of y just to place w earlier).
    const list = [mod("x"), mod("w", ["z"]), mod("y"), mod("z")];
    expect(names(orderModules(list))).toEqual(["x", "y", "z", "w"]);
  });

  it("handles a diamond (d→b, d→c, b→a, c→a) with a before b/c before d", () => {
    // Input order [d, c, b, a] → c is listed before b.
    const list = [mod("d", ["b", "c"]), mod("c", ["a"]), mod("b", ["a"]), mod("a")];
    const out = names(orderModules(list));
    expect(out.indexOf("a")).toBeLessThan(out.indexOf("b"));
    expect(out.indexOf("a")).toBeLessThan(out.indexOf("c"));
    expect(out.indexOf("b")).toBeLessThan(out.indexOf("d"));
    expect(out.indexOf("c")).toBeLessThan(out.indexOf("d"));
    // stable tiebreak: c (listed before b in the input) precedes b
    expect(out.indexOf("c")).toBeLessThan(out.indexOf("b"));
    expect(out).toEqual(["a", "c", "b", "d"]);
  });

  it("does not mutate the input array", () => {
    const list = [mod("b", ["a"]), mod("a")];
    const snapshot = names(list);
    orderModules(list);
    expect(names(list)).toEqual(snapshot);
  });
});

describe("orderModules — fail-fast", () => {
  it("throws on duplicate module names", () => {
    expect(() => orderModules([mod("dupe"), mod("dupe")])).toThrow(/Duplicate module name "dupe"/);
  });

  it("throws when a dependency is not in the composed set", () => {
    expect(() => orderModules([mod("order", ["ghost"])])).toThrow(
      /module "order" dependsOn "ghost", which is not composed/,
    );
  });

  it("throws on a self-reference", () => {
    expect(() => orderModules([mod("loop", ["loop"])])).toThrow(/module "loop" dependsOn itself/);
  });

  it("throws on a direct cycle and names the path", () => {
    expect(() => orderModules([mod("a", ["b"]), mod("b", ["a"])])).toThrow(
      /module dependency cycle: a → b → a/,
    );
  });

  it("throws on a longer cycle and names the path", () => {
    const err = (() => {
      try {
        orderModules([mod("a", ["b"]), mod("b", ["c"]), mod("c", ["a"])]);
      } catch (e) {
        return (e as Error).message;
      }
      return "";
    })();
    // a → b → c → a (any rotation is a valid report of the same cycle)
    expect(err).toMatch(/module dependency cycle:/);
    expect(err).toMatch(/a → b → c → a|b → c → a → b|c → a → b → c/);
  });

  it("still orders the acyclic part around an isolated cycle detection", () => {
    // Independent good module + a 2-cycle → must throw (cycle wins over partial).
    expect(() => orderModules([mod("ok"), mod("a", ["b"]), mod("b", ["a"])])).toThrow(
      /module dependency cycle/,
    );
  });
});
