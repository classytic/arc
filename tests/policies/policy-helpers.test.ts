import { describe, expect, it } from "vitest";
import { combinePolicies, anyPolicy, allowAll, denyAll } from "../../src/policies/helpers.js";
import type { PolicyEngine, PolicyResult } from "../../src/policies/PolicyInterface.js";

/** Create a simple test policy engine */
function createPolicy(result: Partial<PolicyResult>): PolicyEngine {
  const fullResult: PolicyResult = {
    allowed: true,
    ...result,
  };
  return {
    can: () => fullResult,
    toMiddleware: () => async () => {},
  };
}

describe("allowAll()", () => {
  it("always returns allowed: true", () => {
    const policy = allowAll();
    const result = policy.can(null, "list");
    expect(result.allowed).toBe(true);
  });
});

describe("denyAll()", () => {
  it("always returns allowed: false", () => {
    const policy = denyAll();
    const result = policy.can(null, "list");
    expect(result.allowed).toBe(false);
  });

  it("includes custom reason", () => {
    const policy = denyAll("maintenance mode");
    const result = policy.can(null, "list");
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("maintenance mode");
  });
});

describe("combinePolicies() — AND logic", () => {
  it("allows when all policies allow", async () => {
    const combined = combinePolicies(
      createPolicy({ allowed: true }),
      createPolicy({ allowed: true }),
    );
    const result = await combined.can(null, "list");
    expect(result.allowed).toBe(true);
  });

  it("denies when any policy denies", async () => {
    const combined = combinePolicies(
      createPolicy({ allowed: true }),
      createPolicy({ allowed: false, reason: "denied by second" }),
    );
    const result = await combined.can(null, "update");
    expect(result.allowed).toBe(false);
  });

  it("merges filters from all policies", async () => {
    const combined = combinePolicies(
      createPolicy({ allowed: true, filters: { org: "a" } }),
      createPolicy({ allowed: true, filters: { status: "active" } }),
    );
    const result = await combined.can(null, "list");
    expect(result.allowed).toBe(true);
    expect(result.filters).toMatchObject({ org: "a", status: "active" });
  });

  it("throws for empty policy list", () => {
    expect(() => combinePolicies()).toThrow("at least one policy");
  });

  it("returns single policy directly for length 1", () => {
    const p = createPolicy({ allowed: true });
    const combined = combinePolicies(p);
    expect(combined).toBe(p);
  });
});

describe("anyPolicy() — OR logic", () => {
  it("allows when at least one policy allows", async () => {
    const combined = anyPolicy(
      createPolicy({ allowed: false }),
      createPolicy({ allowed: true }),
    );
    const result = await combined.can(null, "list");
    expect(result.allowed).toBe(true);
  });

  it("denies when all policies deny", async () => {
    const combined = anyPolicy(
      createPolicy({ allowed: false, reason: "no" }),
      createPolicy({ allowed: false, reason: "nope" }),
    );
    const result = await combined.can(null, "list");
    expect(result.allowed).toBe(false);
  });

  it("returns first allowing result", async () => {
    const combined = anyPolicy(
      createPolicy({ allowed: false }),
      createPolicy({ allowed: true, filters: { mine: true } }),
      createPolicy({ allowed: true, filters: { all: true } }),
    );
    const result = await combined.can(null, "list");
    expect(result.allowed).toBe(true);
    expect(result.filters).toMatchObject({ mine: true });
  });

  it("throws for empty policy list", () => {
    expect(() => anyPolicy()).toThrow("at least one policy");
  });
});
