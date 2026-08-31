/**
 * Module system — memory + efficiency (perf lane, run with `--expose-gc`).
 *
 * The module lifecycle (`dependsOn` topological sort, per-app `arc.modules`
 * export map, per-module close closures, hooks) is per-app state. This proves
 * it is fully RELEASED when the app closes — composing + closing many
 * module-heavy apps must not accumulate heap — and that `orderModules` is both
 * fast and allocation-clean when called repeatedly.
 *
 * Shared heap helpers come from `tests/_helpers/heap.ts` (same measurement as
 * the CRUD leak test).
 */

import { describe, expect, it } from "vitest";
import { createApp } from "../../src/factory/createApp.js";
import {
  type ArcModule,
  defineModule,
  getModuleExports,
  orderModules,
} from "../../src/factory/module/index.js";
import { gc, measureHeapMedian } from "../_helpers/heap.js";

/**
 * A small ecosystem of 5 modules with a realistic dependency chain and every
 * lifecycle slot populated (plugins + bootstrap→export + afterResources +
 * onClose) — the shape whose retention we care about.
 */
function buildModules(tag: number): ArcModule[] {
  const engine = { tag, data: new Array(64).fill(tag) }; // small payload per export
  const base = defineModule({
    name: "base",
    plugins: () => {},
    bootstrap: () => engine,
    afterResources: () => {},
    onClose: () => {},
  });
  const mid = defineModule({
    name: "mid",
    dependsOn: ["base"],
    plugins: () => {},
    bootstrap: () => ({ tag }),
    onClose: () => {},
  });
  const leaf = defineModule({
    name: "leaf",
    dependsOn: ["mid"],
    bootstrap: () => ({ tag }),
    onClose: () => {},
  });
  const sideA = defineModule({ name: "sideA", dependsOn: ["base"], bootstrap: () => ({ tag }) });
  const sideB = defineModule({ name: "sideB", dependsOn: ["base"], bootstrap: () => ({ tag }) });
  // Listed out of dependency order — orderModules must resolve it every time.
  return [leaf, sideB, mid, sideA, base];
}

async function composeAndCloseApps(count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    const app = await createApp({
      preset: "testing",
      auth: false,
      logger: false,
      modules: buildModules(i),
    });
    await app.ready();
    await app.close();
  }
}

describe("module system — memory + efficiency", () => {
  it("per-app module state is instance-scoped, not shared/global", async () => {
    // No cross-app retention by construction: two live apps have DISTINCT
    // `arc.modules` maps holding their OWN exports. If the module system kept
    // state in a module-level singleton, these would alias.
    const a = await createApp({
      preset: "testing",
      auth: false,
      logger: false,
      modules: [defineModule({ name: "eng", bootstrap: () => ({ id: "a" }) })],
    });
    const b = await createApp({
      preset: "testing",
      auth: false,
      logger: false,
      modules: [defineModule({ name: "eng", bootstrap: () => ({ id: "b" }) })],
    });
    await a.ready();
    await b.ready();
    expect(getModuleExports(a, "eng")).toEqual({ id: "a" });
    expect(getModuleExports(b, "eng")).toEqual({ id: "b" }); // independent
    await a.close();
    // Closing a must not disturb b's export map.
    expect(getModuleExports(b, "eng")).toEqual({ id: "b" });
    await b.close();
  }, 60_000);

  it("compose + close of many module-heavy apps reaches steady state (no per-app leak)", async () => {
    // The discriminator is TOTAL SLOPE over several windows, not deceleration
    // between two adjacent ones.
    //
    // The two-window form compared `window2 < window1 * 0.75`, which assumes V8
    // collects on a schedule that makes each window monotonically smaller. Node
    // 24 does not: measured across four windows the sequence was
    // `15.4, 32.9, -18.0, 9.8` MB — window2 absorbing window1's deferred
    // garbage, window3 handing it back. A NEGATIVE window is proof the memory
    // was never retained, yet the two-window check read that same run as a leak.
    //
    // Total growth per app is immune to when the collector runs. A real per-app
    // leak retains a whole app's worth of structures — MBs per app, tens of MB
    // per window, sustained. Fastify's own per-app churn is ~125KB/app and the
    // measured total here is ~167KB/app, so the bound below sits ~3x above
    // baseline and roughly an order of magnitude below any real retention.
    await composeAndCloseApps(25); // warm up: JIT, mongoose model cache, steady caches
    await gc();
    const m0 = await measureHeapMedian(5);

    const WINDOW = 60;
    const WINDOWS = 4;
    const marks: number[] = [];
    for (let i = 0; i < WINDOWS; i++) {
      await composeAndCloseApps(WINDOW);
      await gc();
      marks.push(await measureHeapMedian(5));
    }

    const perWindow = marks.map((m, i) => m - (i === 0 ? m0 : (marks[i - 1] as number)));
    const totalMB = (marks[WINDOWS - 1] as number) - m0;
    const perAppKB = (totalMB * 1024) / (WINDOW * WINDOWS);
    console.log(
      `[module-mem] windows=[${perWindow.map((w) => w.toFixed(1)).join(", ")}]MB ` +
        `total=${totalMB.toFixed(2)}MB over ${WINDOW * WINDOWS} apps → ${perAppKB.toFixed(0)}KB/app`,
    );

    expect(perAppKB).toBeLessThan(500);
  }, 120_000);

  it("orderModules is fast and allocation-clean under repeated calls", async () => {
    // A 30-module chain (base ← m1 ← m2 ← … ← m29) — the worst case for the
    // stable O(N²) ready-scan, still trivial in absolute terms.
    const chain: ArcModule[] = [];
    for (let i = 0; i < 30; i++) {
      chain.push(defineModule({ name: `m${i}`, ...(i > 0 ? { dependsOn: [`m${i - 1}`] } : {}) }));
    }
    // Shuffle so the sort does real work each call (not a no-op fast path).
    const shuffled = [...chain].reverse();

    // Correctness: the sort yields the strict chain order every time.
    expect(orderModules(shuffled).map((m) => m.name)).toEqual(chain.map((m) => m.name));

    // TWO identical batches, and the assertion is on the SECOND.
    //
    // Measuring one batch against a baseline taken right after the previous
    // test made this a measure of that test's leftovers, not of `orderModules`.
    // The threshold had already been raised once for exactly that reason ("test
    // 2 leaves residual V8 heap … passes in isolation") — an absolute cap that
    // has to move whenever a NEIGHBOUR changes is measuring the neighbour.
    //
    // The first batch runs the same work and settles that residue; the second
    // is then bracketed by two marks taken in the same state, so its delta is
    // what 5000 sorts actually retain. A pure function retains nothing, so the
    // bound is tight — and unlike the old form it cannot be perturbed by
    // whatever ran before.
    const RUNS = 5000;
    const batch = () => {
      const start = performance.now();
      for (let i = 0; i < RUNS; i++) orderModules(shuffled);
      return performance.now() - start;
    };

    batch(); // absorb prior residue + JIT warmup
    await gc();
    const beforeMB = await measureHeapMedian(3);

    // NET across several batches — a single bracketed delta cannot work here.
    // `--expose-gc` does not force a full collection on Node 24: consecutive
    // identical batches measured +13.78, -47.71, +13.77 MB. The +13.78 is
    // stable to 0.1MB and looks exactly like retention, but the net is NEGATIVE
    // — the heap handed back more than any batch "kept". Only the net over
    // several batches separates allocation volume from retention.
    const BATCHES = 4;
    let elapsedMs = 0;
    for (let i = 0; i < BATCHES; i++) {
      elapsedMs = batch();
      await gc();
    }
    const afterMB = await measureHeapMedian(3);

    const netMB = afterMB - beforeMB;
    const perSortBytes = (netMB * 1024 * 1024) / (RUNS * BATCHES);
    console.log(
      `[order-mem] ${RUNS} sorts of 30 modules in ${elapsedMs.toFixed(1)}ms (${(elapsedMs / RUNS).toFixed(3)}ms/sort), net over ${BATCHES} batches=${netMB.toFixed(2)}MB (${perSortBytes.toFixed(0)}B/sort)`,
    );

    // A pure function nets ~zero or negative. Real retention at the ~2.8KB/sort
    // the single-delta form appeared to show would be ~56MB over 20k sorts, so
    // this still fails loudly on genuine retention.
    expect(netMB).toBeLessThan(10);
    expect(elapsedMs / RUNS).toBeLessThan(1);
  }, 60_000);
});
