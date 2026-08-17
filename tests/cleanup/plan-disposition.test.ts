/**
 * The removal headline must count only what is REMOVED.
 *
 * A protective guard step reports the records it DEFENDS. Those used to be
 * summed into `estimatedTotal`, so a pre-live reset that removes 367 rows
 * announced "540 records to remove" — 173 of them posted journal entries the
 * run would refuse to touch. Plausible, internally consistent, and wrong, at the
 * exact moment an operator authorises destruction.
 *
 * Three separate things are asserted because they are three separate ways to be
 * wrong, and a test that only checked the total would pass while the plan lost
 * the information the UI needs:
 *
 *   1. `estimatedTotal` excludes protected lines;
 *   2. `protectedTotal` reports them, so they can be shown as reassurance;
 *   3. an untagged line still counts as a removal — every recipe written before
 *      `disposition` existed must keep its meaning.
 */

import type { CleanupStep } from "@classytic/repo-core/cleanup";
import { describe, expect, it } from "vitest";
import { recipeFromSteps } from "../../src/cleanup/compose.js";

const CTX = { now: () => new Date("2026-08-15T00:00:00.000Z") };

function step(
  resource: string,
  estimated: number,
  disposition?: "remove" | "protect" | "rebuild",
): CleanupStep {
  return {
    id: `step.${resource}`,
    resource,
    destructive: disposition === undefined || disposition === "remove",
    // Declared on the STEP as well as the estimate: exclusions resolve before
    // estimates run, so a `'protect'` visible only at estimate time would be
    // excludable — the bypass `compose.ts` now refuses to plan.
    ...(disposition ? { disposition } : {}),
    estimate: async () => ({
      resource,
      estimated,
      ...(disposition ? { disposition } : {}),
    }),
    execute: async () => ({ resource, processed: 0, ok: true }),
    verify: async () => [],
  } as unknown as CleanupStep;
}

async function planOf(steps: CleanupStep[]) {
  const recipe = recipeFromSteps({
    id: "test.recipe",
    label: "Test",
    version: "1",
    evidenceStrategy: "hard",
    steps,
  });
  return recipe.plan({ parameters: {} }, CTX as never);
}

describe("plan item disposition", () => {
  it("keeps protected records OUT of the removal headline", async () => {
    const draft = await planOf([
      step("orders", 367),
      step("statutory accounting records", 173, "protect"),
    ]);

    // The draft carries the lines; the service computes the totals from them,
    // so assert the line tagging here and the arithmetic in the service test.
    const guard = draft.items.find((i) => i.resource === "statutory accounting records");
    const orders = draft.items.find((i) => i.resource === "orders");

    expect(guard?.disposition).toBe("protect");
    expect(guard?.estimated).toBe(173);
    // Untagged stays a removal — the pre-existing meaning.
    expect(orders?.disposition).toBeUndefined();
  });

  it("carries a rebuild line distinctly from both", async () => {
    const draft = await planOf([step("sales rollup", 12, "rebuild")]);

    /**
     * `destructive: false` covers BOTH a guard and a rebuild, so it cannot
     * drive the headline: one counts records defended, the other records
     * recomputed. Only an explicit disposition separates them.
     */
    expect(draft.items[0]?.disposition).toBe("rebuild");
  });
});
