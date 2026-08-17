/**
 * Cleanup framework — pure core (registry, plan digest, errors).
 */
import { describe, expect, it } from "vitest";
import {
  CleanupError,
  type CleanupPlan,
  type CleanupRecipe,
  computePlanDigest,
  createCleanupRegistry,
} from "../../src/cleanup/index.js";

function recipe(id: string, destructive = true): CleanupRecipe {
  return {
    id,
    label: id,
    destructive,
    available: async () => ({ available: true }),
    plan: async () => ({ items: [] }),
    execute: async () => ({ status: "completed", results: [] }),
    verify: async () => ({ ok: true, checks: [] }),
  };
}

const basePlan = (over: Partial<CleanupPlan> = {}): Omit<CleanupPlan, "digest"> => ({
  recipeId: "cleanup.drafts",
  parameters: { module: "sales", before: "2026-01-01" },
  items: [
    { resource: "orders", estimated: 12, blockers: [] },
    { resource: "invoices", estimated: 4 },
  ],
  retains: ["master data"],
  blockers: [],
  rebuildActions: ["sales facts"],
  warnings: ["some warning"],
  estimatedTotal: 16,
  protectedTotal: 0,
  excludeSteps: [],
  confirmationPhrase: "cleanup.drafts",
  ...over,
});

describe("createCleanupRegistry", () => {
  it("looks up by id and lists all", () => {
    const reg = createCleanupRegistry([recipe("a"), recipe("b")]);
    expect(reg.get("a").id).toBe("a");
    expect(reg.find("missing")).toBeUndefined();
    expect(reg.all()).toHaveLength(2);
  });

  it("throws CLEANUP_DUPLICATE_RECIPE at construction on an id clash", () => {
    try {
      createCleanupRegistry([recipe("dup"), recipe("dup")]);
      throw new Error("expected duplicate to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(CleanupError);
      expect((err as CleanupError).code).toBe("CLEANUP_DUPLICATE_RECIPE");
    }
  });

  it("get() throws CLEANUP_UNKNOWN_RECIPE for an unregistered id", () => {
    const reg = createCleanupRegistry([recipe("a")]);
    expect(() => reg.get("nope")).toThrow(CleanupError);
    try {
      reg.get("nope");
    } catch (err) {
      expect((err as CleanupError).code).toBe("CLEANUP_UNKNOWN_RECIPE");
      expect((err as CleanupError).status).toBe(404);
    }
  });

  it("introspect() returns method-free recipe cards", () => {
    const reg = createCleanupRegistry([recipe("a", true), recipe("b", false)]);
    expect(reg.introspect()).toEqual([
      { id: "a", label: "a", destructive: true },
      { id: "b", label: "b", destructive: false },
    ]);
  });
});

describe("computePlanDigest", () => {
  it("is stable across object key insertion order", () => {
    const a = basePlan();
    const b = basePlan({
      // same content, different key order + reordered blockers
      items: [
        { estimated: 4, resource: "invoices" },
        { blockers: [], estimated: 12, resource: "orders" },
      ],
    });
    expect(computePlanDigest(a)).toBe(computePlanDigest(b));
  });

  it("ignores advisory warnings (not part of consent)", () => {
    expect(computePlanDigest(basePlan({ warnings: ["x"] }))).toBe(
      computePlanDigest(basePlan({ warnings: ["totally different"] })),
    );
  });

  it("changes when a material field changes (estimate, blocker, parameter)", () => {
    const base = computePlanDigest(basePlan());
    expect(computePlanDigest(basePlan({ estimatedTotal: 17 }))).not.toBe(base);
    expect(computePlanDigest(basePlan({ blockers: ["OPEN_TRANSFER"] }))).not.toBe(base);
    expect(computePlanDigest(basePlan({ parameters: { module: "inventory" } }))).not.toBe(base);
    expect(
      computePlanDigest(basePlan({ items: [{ resource: "orders", estimated: 99 }] })),
    ).not.toBe(base);
  });
});
