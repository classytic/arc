/**
 * `recipeFromSteps` — folds framework-free `CleanupStep`s (repo-core) into an
 * arc `CleanupRecipe`. Proves: plan unions estimates/blockers/rebuilds;
 * execute runs steps in order, forwards per-chunk deltas to `onStep`, stops on
 * the first failure (retention §8), and propagates `CleanupCancelled`; verify
 * unions checks.
 */

import type { CleanupStep, CleanupStepExecuteContext } from "@classytic/repo-core/cleanup";
import { describe, expect, it, vi } from "vitest";
import { recipeFromSteps } from "../../src/cleanup/compose.js";
import { CleanupCancelled } from "../../src/cleanup/errors.js";
import type {
  CleanupContext,
  CleanupExecutionContext,
  CleanupPlan,
  CleanupStepResult,
} from "../../src/cleanup/types.js";

const NOW = new Date("2026-07-24T00:00:00.000Z");

function planCtx(): CleanupContext {
  return { actor: { ref: "user:admin", kind: "user" }, now: NOW };
}

function execCtx(overrides: Partial<CleanupExecutionContext> = {}): {
  ctx: CleanupExecutionContext;
  steps: CleanupStepResult[];
} {
  const steps: CleanupStepResult[] = [];
  const ctx: CleanupExecutionContext = {
    actor: { ref: "user:admin", kind: "user" },
    now: NOW,
    runId: "run_1",
    operationId: "op_1",
    onStep: async (s) => {
      steps.push(s);
    },
    throwIfCancelled: async () => {},
    ...overrides,
  };
  return { ctx, steps };
}

function sealed(parameters: Record<string, unknown> = {}): CleanupPlan {
  return {
    recipeId: "cleanup.test",
    parameters,
    items: [],
    retains: [],
    blockers: [],
    rebuildActions: [],
    warnings: [],
    estimatedTotal: 0,
    confirmationPhrase: "cleanup.test",
    digest: "d",
  };
}

/** A step that streams cumulative progress then returns a cumulative outcome. */
function streamingStep(id: string, resource: string, chunks: number[]): CleanupStep {
  return {
    id,
    resource,
    destructive: true,
    estimate: async () => ({ resource, estimated: chunks.at(-1) ?? 0 }),
    execute: async (ctx: CleanupStepExecuteContext) => {
      let processed = 0;
      for (const c of chunks) {
        await ctx.throwIfCancelled?.();
        processed = c;
        await ctx.onProgress?.({ resource, processed });
      }
      return { resource, processed, ok: true };
    },
    verify: async () => [{ name: `${id}.clean`, ok: true }],
  };
}

describe("recipeFromSteps", () => {
  it("unions estimates, blockers, rebuildActions, retains in plan", async () => {
    const recipe = recipeFromSteps({
      id: "cleanup.test",
      label: "Test",
      steps: [
        {
          id: "a",
          resource: "orders",
          destructive: true,
          rebuildActions: ["rebuild sales rollup"],
          estimate: async () => ({ resource: "orders", estimated: 3, retained: "invoices kept" }),
          execute: async () => ({ resource: "orders", processed: 3, ok: true }),
        },
        {
          id: "b",
          resource: "journal entries",
          destructive: true,
          estimate: async () => ({
            resource: "journal entries",
            estimated: 0,
            blockers: ["POSTED_BOOKS_IMMUTABLE"],
          }),
          execute: async () => ({ resource: "journal entries", processed: 0, ok: true }),
        },
      ],
    });

    const draft = await recipe.plan({ parameters: {} }, planCtx());
    expect(draft.items).toHaveLength(2);
    expect(draft.blockers).toEqual(["POSTED_BOOKS_IMMUTABLE"]);
    expect(draft.rebuildActions).toEqual(["rebuild sales rollup"]);
    expect(draft.retains).toContain("invoices kept");
    expect(recipe.destructive).toBe(true);
  });

  it("derives destructive=false when no step is destructive (pure rebuild)", async () => {
    const recipe = recipeFromSteps({
      id: "cleanup.rebuild-projections",
      label: "Rebuild",
      steps: [
        {
          id: "r",
          resource: "sales facts",
          destructive: false,
          rebuildActions: ["rebuild sales rollup"],
          estimate: async () => ({ resource: "sales facts", estimated: 100 }),
          execute: async () => ({ resource: "sales facts", processed: 100, ok: true }),
        },
      ],
    });
    expect(recipe.destructive).toBe(false);
  });

  it("forwards per-chunk deltas to onStep so the bounded total is exact", async () => {
    const recipe = recipeFromSteps({
      id: "cleanup.test",
      label: "Test",
      steps: [streamingStep("a", "facts", [10, 25, 40])],
    });
    const { ctx, steps } = execCtx();
    const result = await recipe.execute(sealed(), ctx);

    // Cumulative 10→25→40 must arrive as deltas 10,15,15 (sum 40).
    expect(steps.map((s) => s.processed)).toEqual([10, 15, 15]);
    expect(steps.reduce((n, s) => n + s.processed, 0)).toBe(40);
    expect(result.status).toBe("completed");
    expect(result.results).toEqual([{ resource: "facts", processed: 40, ok: true }]);
  });

  it("runs steps in order and stops on the first failure (retention §8)", async () => {
    const order: string[] = [];
    const recipe = recipeFromSteps({
      id: "cleanup.test",
      label: "Test",
      steps: [
        {
          id: "a",
          resource: "a",
          destructive: true,
          estimate: async () => ({ resource: "a", estimated: 1 }),
          execute: async () => {
            order.push("a");
            return { resource: "a", processed: 1, ok: true };
          },
        },
        {
          id: "b",
          resource: "b",
          destructive: true,
          estimate: async () => ({ resource: "b", estimated: 1 }),
          execute: async () => {
            order.push("b");
            return { resource: "b", processed: 0, ok: false, error: "boom" };
          },
        },
        {
          id: "c",
          resource: "c",
          destructive: true,
          estimate: async () => ({ resource: "c", estimated: 1 }),
          execute: async () => {
            order.push("c");
            return { resource: "c", processed: 1, ok: true };
          },
        },
      ],
    });
    const { ctx, steps } = execCtx();
    const result = await recipe.execute(sealed(), ctx);

    expect(order).toEqual(["a", "b"]); // c never ran
    expect(result.status).toBe("partial"); // a ok, b failed
    expect(result.results.map((r) => r.ok)).toEqual([true, false]);
    // The failed step is surfaced to bounded progress even at delta 0.
    expect(steps.some((s) => !s.ok && s.error === "boom")).toBe(true);
  });

  it("converts a thrown non-cancel error into an ok:false outcome and stops", async () => {
    const recipe = recipeFromSteps({
      id: "cleanup.test",
      label: "Test",
      steps: [
        {
          id: "a",
          resource: "a",
          destructive: true,
          estimate: async () => ({ resource: "a", estimated: 1 }),
          execute: async () => {
            throw new Error("kaboom");
          },
        },
      ],
    });
    const { ctx } = execCtx();
    const result = await recipe.execute(sealed(), ctx);
    expect(result.status).toBe("failed");
    expect(result.results[0]).toMatchObject({ ok: false, error: "kaboom" });
  });

  it("propagates CleanupCancelled (a cancel is not a failure)", async () => {
    const recipe = recipeFromSteps({
      id: "cleanup.test",
      label: "Test",
      steps: [streamingStep("a", "facts", [10, 20])],
    });
    const throwIfCancelled = vi
      .fn<[], Promise<void>>()
      .mockResolvedValueOnce(undefined) // between-steps check passes
      .mockRejectedValueOnce(new CleanupCancelled("run_1")); // first chunk cancels
    const { ctx } = execCtx({ throwIfCancelled });
    await expect(recipe.execute(sealed(), ctx)).rejects.toBeInstanceOf(CleanupCancelled);
  });

  it("threads sealed parameters into steps", async () => {
    let seen: unknown;
    const recipe = recipeFromSteps({
      id: "cleanup.test",
      label: "Test",
      steps: [
        {
          id: "a",
          resource: "a",
          destructive: true,
          estimate: async (c) => {
            seen = c.parameters;
            return { resource: "a", estimated: 0 };
          },
          execute: async () => ({ resource: "a", processed: 0, ok: true }),
        },
      ],
    });
    await recipe.plan({ parameters: { branchId: "b1" } }, planCtx());
    expect(seen).toEqual({ branchId: "b1" });
  });

  it("unions verify checks; recipe verified iff all pass", async () => {
    const recipe = recipeFromSteps({
      id: "cleanup.test",
      label: "Test",
      steps: [
        streamingStep("a", "a", [1]),
        {
          id: "b",
          resource: "b",
          destructive: true,
          estimate: async () => ({ resource: "b", estimated: 0 }),
          execute: async () => ({ resource: "b", processed: 0, ok: true }),
          verify: async () => [{ name: "b.drift", ok: false, detail: "1 row drifted" }],
        },
      ],
    });
    const res = await recipe.verify(sealed(), planCtx());
    expect(res.ok).toBe(false);
    expect(res.checks).toHaveLength(2);
    expect(res.checks.find((c) => c.name === "b.drift")?.ok).toBe(false);
  });

  it("honors a recipe-level availability gate", async () => {
    const recipe = recipeFromSteps({
      id: "cleanup.pre-live-reset",
      label: "Reset",
      available: async () => ({ available: false, reason: "business is live" }),
      steps: [streamingStep("a", "a", [1])],
    });
    expect(await recipe.available(planCtx())).toEqual({
      available: false,
      reason: "business is live",
    });
  });
});
