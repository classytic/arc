/**
 * Operator exclusions — an ignore-list with the property a plain one lacks.
 *
 * The conventional shape lets an operator ignore ANY phase, from the same screen
 * that starts the deletion. That makes every protective check advisory: a run
 * can be narrowed past the thing standing between it and records that must
 * never be purged.
 *
 * Here the exclusion list REFUSES rather than filters, on two counts, and each
 * is asserted separately because they fail differently:
 *
 *   1. an UNKNOWN id — silently dropping it leaves an operator believing they
 *      narrowed a destructive run when the named domain will in fact be purged;
 *   2. a PROTECTIVE step — a guard cannot be switched off by the request that
 *      starts the run.
 *
 * Plus the two behavioural halves: an excluded line is still SHOWN (a line that
 * vanishes is indistinguishable from one that was never in scope) and is not
 * estimated (so it cannot contribute blockers that refuse a run it is not part
 * of).
 */

import type { CleanupStep } from "@classytic/repo-core/cleanup";
import { describe, expect, it } from "vitest";
import { recipeFromSteps, resolveExclusions } from "../../src/cleanup/compose.js";
import { CleanupError } from "../../src/cleanup/errors.js";

let estimateCalls: string[] = [];

function step(
  id: string,
  resource: string,
  n: number,
  disposition?: "remove" | "protect" | "rebuild",
): CleanupStep {
  return {
    id,
    resource,
    destructive: disposition === undefined || disposition === "remove",
    ...(disposition ? { disposition } : {}),
    estimate: async () => {
      estimateCalls.push(id);
      return {
        resource,
        estimated: n,
        ...(disposition ? { disposition } : {}),
        // A guard contributes a blocker — the thing that must NOT leak into a
        // run the excluded line is not part of.
        ...(disposition === "protect" && n > 0 ? { blockers: [`PROTECTED:${n}`] } : {}),
      };
    },
    execute: async () => ({ resource, processed: n, ok: true }),
    verify: async () => [],
  } as unknown as CleanupStep;
}

const GUARD = () => step("s.guard", "statutory accounting records", 173, "protect");
const ORDERS = () => step("s.orders", "orders", 60);
const CARTS = () => step("s.carts", "carts", 12);

function recipe(steps: CleanupStep[]) {
  return recipeFromSteps({
    id: "r",
    label: "R",
    version: "1",
    evidenceStrategy: "hard",
    steps,
  });
}

const CTX = { now: new Date("2026-08-15T00:00:00.000Z") } as never;

describe("resolveExclusions", () => {
  it("REFUSES an unknown step id rather than ignoring it", () => {
    expect(() => resolveExclusions([ORDERS()], ["s.typo"])).toThrow(CleanupError);
    try {
      resolveExclusions([ORDERS()], ["s.typo"]);
    } catch (e) {
      const err = e as CleanupError;
      expect(err.code).toBe("CLEANUP_INVALID_EXCLUSION");
      expect(err.status).toBe(400);
      expect(err.meta?.steps).toEqual(["s.typo"]);
    }
  });

  it("REFUSES to exclude a PROTECTIVE step — the guard cannot be switched off", () => {
    try {
      resolveExclusions([ORDERS(), GUARD()], ["s.guard"]);
      throw new Error("should have refused");
    } catch (e) {
      const err = e as CleanupError;
      expect(err.code).toBe("CLEANUP_INVALID_EXCLUSION");
      expect(err.meta?.steps).toEqual(["s.guard"]);
    }
  });

  it("ALLOWS excluding a non-destructive REBUILD — destructive is not the test", () => {
    const rebuild = step("s.rollup", "sales rollup", 4, "rebuild");
    // A rebuild is `destructive: false` exactly like a guard, and is perfectly
    // reasonable to leave out. Only `disposition: 'protect'` is unexcludable.
    expect(() => resolveExclusions([rebuild], ["s.rollup"])).not.toThrow();
  });

  it("is a no-op for an empty or absent list", () => {
    expect(resolveExclusions([ORDERS()], undefined).size).toBe(0);
    expect(resolveExclusions([ORDERS()], []).size).toBe(0);
  });
});

describe("plan with exclusions", () => {
  it("SHOWS the excluded line and keeps its count out of the totals", async () => {
    estimateCalls = [];
    const draft = await recipe([ORDERS(), CARTS()]).plan(
      { parameters: {}, excludeSteps: ["s.carts"] },
      CTX,
    );

    const carts = draft.items.find((i) => i.resource === "carts");
    expect(carts?.excluded).toBe(true);
    expect(carts?.estimated).toBe(0);
    // Still listed: a line that disappears is indistinguishable from one that
    // was never in scope.
    expect(draft.items.map((i) => i.resource)).toEqual(["orders", "carts"]);
  });

  it("does NOT estimate an excluded step, so it cannot contribute a blocker", async () => {
    estimateCalls = [];
    const draft = await recipe([ORDERS(), CARTS()]).plan(
      { parameters: {}, excludeSteps: ["s.carts"] },
      CTX,
    );

    /**
     * Estimating an excluded line costs its counting queries for work being
     * taken out, and — worse — surfaces its blockers, so leaving a domain out
     * could still refuse the run because of that domain.
     */
    expect(estimateCalls).toEqual(["s.orders"]);
    expect(draft.blockers ?? []).toHaveLength(0);
  });
});

describe("execute with exclusions", () => {
  it("reports an excluded step as SKIPPED with the reason, and never runs it", async () => {
    const transitions: { stepId: string; status: string; detail?: string }[] = [];
    const ran: string[] = [];
    const steps = [
      ORDERS(),
      {
        ...CARTS(),
        execute: async () => (ran.push("s.carts"), { resource: "carts", processed: 12, ok: true }),
      } as CleanupStep,
    ];

    await recipe(steps).execute(
      { parameters: {}, excludeSteps: ["s.carts"] } as never,
      {
        now: CTX.now,
        actor: { ref: "user:a", kind: "user" },
        runId: "r1",
        operationId: "o1",
        onStep: async () => {},
        onStepState: async (s: { stepId: string; status: string; detail?: string }) =>
          void transitions.push(s),
        throwIfCancelled: async () => {},
      } as never,
    );

    expect(ran).toEqual([]); // never executed
    const carts = transitions.find((t) => t.stepId === "s.carts");
    expect(carts?.status).toBe("skipped");
    expect(carts?.detail).toBe("excluded by the operator");
  });
});

/**
 * The guard reads `step.disposition`, and it must — exclusions are resolved
 * BEFORE any estimate runs (that is what decides which steps to estimate).
 *
 * So a guard that declared `'protect'` only from its estimate was excludable:
 * the plan line came back marked protective and looked defended, while
 * `excludeSteps: [thatId]` still switched it off — the exact property this
 * feature exists to make impossible. The mismatch is now an authoring error.
 */
describe("protection must be declared where the guard can see it", () => {
  /** Declares nothing on the step, but returns 'protect' from the estimate. */
  function estimateOnlyGuard(id: string, resource: string, n: number): CleanupStep {
    return {
      id,
      resource,
      destructive: false,
      estimate: async () => ({ resource, estimated: n, disposition: "protect" as const }),
      execute: async () => ({ resource, processed: 0, ok: true }),
      verify: async () => [],
    } as unknown as CleanupStep;
  }

  it("REFUSES to plan a step whose estimate protects but whose step does not declare it", async () => {
    const r = recipe([step("purge", "orders", 10), estimateOnlyGuard("guard", "journal", 5)]);
    await expect(r.plan({ parameters: {} }, CTX)).rejects.toThrow(/does not declare/);
  });

  it("a step declaring 'protect' on BOTH plans normally and stays unexcludable", async () => {
    const r = recipe([step("purge", "orders", 10), step("guard", "journal", 5, "protect")]);
    const draft = await r.plan({ parameters: {} }, CTX);
    expect(draft.items.find((i) => i.stepId === "guard")?.disposition).toBe("protect");
    expect(() =>
      resolveExclusions(
        [step("purge", "orders", 10), step("guard", "journal", 5, "protect")],
        ["guard"],
      ),
    ).toThrow(/protective/);
  });
});
