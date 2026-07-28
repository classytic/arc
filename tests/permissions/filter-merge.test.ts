/**
 * Unit tests for conjoinPolicyFilters — the AND-composition of row-level policy
 * filters. The security contract: a later constraint can ADD or narrow, but must
 * never silently REPLACE an earlier constraint on the same key.
 */

import { describe, expect, it } from "vitest";
import { conjoinPolicyFilters } from "../../src/permissions/filter-merge.js";

describe("conjoinPolicyFilters", () => {
  it("returns a fresh empty object when both sides are empty/undefined", () => {
    expect(conjoinPolicyFilters(undefined, undefined)).toEqual({});
    expect(conjoinPolicyFilters({}, {})).toEqual({});
  });

  it("returns a copy of the non-empty side (never the same reference)", () => {
    const base = { organizationId: "org-1" };
    const out = conjoinPolicyFilters(base, undefined);
    expect(out).toEqual({ organizationId: "org-1" });
    expect(out).not.toBe(base);
  });

  it("merges non-overlapping keys flat (common case, identical to old spread)", () => {
    expect(conjoinPolicyFilters({ a: 1, b: 2 }, { c: 3 })).toEqual({ a: 1, b: 2, c: 3 });
  });

  it("keeps a same-key EQUAL value once (idempotent)", () => {
    expect(conjoinPolicyFilters({ organizationId: "org-1" }, { organizationId: "org-1" })).toEqual({
      organizationId: "org-1",
    });
  });

  it("CONJOINS a same-key DIFFERENT value under $and (never overwrites)", () => {
    expect(conjoinPolicyFilters({ organizationId: "a" }, { organizationId: "b" })).toEqual({
      $and: [{ organizationId: "a" }, { organizationId: "b" }],
    });
  });

  it("only conjoins the conflicting key; siblings stay flat", () => {
    expect(
      conjoinPolicyFilters({ tenantId: "t1", projectId: "p1" }, { projectId: "p2", feature: "x" }),
    ).toEqual({
      tenantId: "t1",
      feature: "x",
      $and: [{ projectId: "p1" }, { projectId: "p2" }],
    });
  });

  it("treats equal operator objects as idempotent", () => {
    expect(
      conjoinPolicyFilters({ status: { $in: ["a", "b"] } }, { status: { $in: ["a", "b"] } }),
    ).toEqual({ status: { $in: ["a", "b"] } });
  });

  it("conjoins differing operator objects (fail-safe: no silent drop)", () => {
    const out = conjoinPolicyFilters({ status: { $in: ["a"] } }, { status: { $in: ["b"] } });
    expect(out).toEqual({ $and: [{ status: { $in: ["a"] } }, { status: { $in: ["b"] } }] });
  });

  it("accumulates a three-way conjoin — all constraints preserved (AND)", () => {
    // ab has orgId only inside $and; the third conjoin lands orgId flat. Mongo
    // implicitly ANDs a top-level field with $and, so this is still the full
    // conjunction (orgId=a AND orgId=b AND orgId=c) — no constraint dropped.
    const ab = conjoinPolicyFilters({ orgId: "a" }, { orgId: "b" });
    const abc = conjoinPolicyFilters(ab, { orgId: "c" });
    expect(abc).toEqual({ orgId: "c", $and: [{ orgId: "a" }, { orgId: "b" }] });
  });

  it("merges pre-existing $and fragments from both sides", () => {
    const left = { $and: [{ a: 1 }] };
    const right = { $and: [{ b: 2 }], c: 3 };
    expect(conjoinPolicyFilters(left, right)).toEqual({ c: 3, $and: [{ a: 1 }, { b: 2 }] });
  });

  it("THROWS on a malformed non-array $and (never silently drops a constraint)", () => {
    expect(() =>
      conjoinPolicyFilters({ $and: { organizationId: "a" } as unknown as [] }, { x: 1 }),
    ).toThrow(/malformed '\$and'/);
    expect(() => conjoinPolicyFilters({ a: 1 }, { $and: "nope" as unknown as [] })).toThrow(
      /malformed '\$and'/,
    );
  });

  it("does not mutate its inputs", () => {
    const base = { organizationId: "a" };
    const incoming = { organizationId: "b" };
    conjoinPolicyFilters(base, incoming);
    expect(base).toEqual({ organizationId: "a" });
    expect(incoming).toEqual({ organizationId: "b" });
  });
});
