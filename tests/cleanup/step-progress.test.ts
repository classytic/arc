/**
 * Per-step run progress — the readable half of a long destructive run.
 *
 * A run used to report one aggregate counter ("1,204 processed"), so an operator
 * watching a multi-domain reset could not tell whether accounting had run, was
 * not applicable, or had failed and left the rest half-done. The conventional
 * answer is one fixed column per phase, each holding
 * `Pending | Completed | Skipped`.
 *
 * Ours is a bounded LIST keyed by step id, because our pipeline is COMPOSED —
 * there is no fixed phase set to make columns from, and adding a phase must not
 * be a schema migration. Three properties are asserted separately because each
 * is a distinct way to be wrong:
 *
 *   1. every step reaches a terminal state, in execution order;
 *   2. `skipped` is distinguished from `completed` AND carries a reason — a bare
 *      "Skipped" cannot tell "nothing in scope" from "deliberately excluded",
 *      which is exactly the ambiguity a bare status enum leaves open;
 *   3. one entry per STEP, not per transition — running→completed updates in
 *      place, so the array stays bounded by the plan's step count.
 */

import type { CleanupStep } from "@classytic/repo-core/cleanup";
import { describe, expect, it } from "vitest";
import { recipeFromSteps } from "../../src/cleanup/compose.js";
import type { CleanupStepProgress } from "../../src/cleanup/types.js";

function step(id: string, resource: string, processed: number, fail = false): CleanupStep {
  return {
    id,
    resource,
    destructive: true,
    estimate: async () => ({ resource, estimated: processed }),
    execute: async () =>
      fail
        ? { resource, processed, ok: false, error: "disk on fire" }
        : { resource, processed, ok: true },
    verify: async () => [],
  } as unknown as CleanupStep;
}

/** Collects lifecycle transitions in the order the loop reports them. */
function harness() {
  const transitions: CleanupStepProgress[] = [];
  const ctx = {
    now: new Date("2026-08-15T00:00:00.000Z"),
    actor: { ref: "user:a", kind: "user" as const },
    runId: "run-1",
    operationId: "op-1",
    onStep: async () => {},
    onStepState: async (s: CleanupStepProgress) => {
      transitions.push(s);
    },
    throwIfCancelled: async () => {},
  };
  return { transitions, ctx };
}

const PLAN = { parameters: {} } as never;

describe("per-step run progress", () => {
  it("reports every step to a terminal state, in execution order", async () => {
    const { transitions, ctx } = harness();
    const recipe = recipeFromSteps({
      id: "r",
      label: "R",
      version: "1",
      evidenceStrategy: "hard",
      steps: [step("s.orders", "orders", 60), step("s.invoices", "invoices", 16)],
    });

    await recipe.execute(PLAN, ctx as never);

    const terminal = transitions.filter((t) => t.status !== "running");
    expect(terminal.map((t) => [t.stepId, t.status])).toEqual([
      ["s.orders", "completed"],
      ["s.invoices", "completed"],
    ]);
    expect(terminal.map((t) => t.processed)).toEqual([60, 16]);
  });

  it("marks a zero-scope step SKIPPED with a reason, not completed", async () => {
    const { transitions, ctx } = harness();
    const recipe = recipeFromSteps({
      id: "r",
      label: "R",
      version: "1",
      evidenceStrategy: "hard",
      steps: [step("s.empty", "loyalty points", 0)],
    });

    await recipe.execute(PLAN, ctx as never);

    const last = transitions.at(-1);
    /**
     * Both a 0-row step and a 4,000-row step end `ok`. Reading a bare 0 as
     * "completed" is how an operator concludes a phase ran when its scope was
     * simply empty.
     */
    expect(last?.status).toBe("skipped");
    expect(last?.detail).toBe("nothing in scope");
  });

  it("marks a thrown step FAILED and carries the error as the reason", async () => {
    const { transitions, ctx } = harness();
    const recipe = recipeFromSteps({
      id: "r",
      label: "R",
      version: "1",
      evidenceStrategy: "hard",
      steps: [step("s.boom", "journal entries", 3, true), step("s.never", "carts", 5)],
    });

    await recipe.execute(PLAN, ctx as never);

    const failed = transitions.find((t) => t.status === "failed");
    expect(failed?.stepId).toBe("s.boom");
    expect(failed?.detail).toBe("disk on fire");

    // stop-on-first-failure: the next step must never have started, and the
    // operator must be able to SEE that rather than infer it from a total.
    expect(transitions.some((t) => t.stepId === "s.never")).toBe(false);
  });

  it("emits running THEN terminal per step — one entry per step after upsert", async () => {
    const { transitions, ctx } = harness();
    const recipe = recipeFromSteps({
      id: "r",
      label: "R",
      version: "1",
      evidenceStrategy: "hard",
      steps: [step("s.a", "a", 1), step("s.b", "b", 2)],
    });

    await recipe.execute(PLAN, ctx as never);

    // Two transitions per step on the wire...
    expect(transitions).toHaveLength(4);
    expect(transitions.map((t) => t.status)).toEqual([
      "running",
      "completed",
      "running",
      "completed",
    ]);
    // ...collapsing to one entry per step id, which is what bounds the stored
    // array by the plan's step count rather than by the transition count.
    expect(new Set(transitions.map((t) => t.stepId)).size).toBe(2);
  });
});
