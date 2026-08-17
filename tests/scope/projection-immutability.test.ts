/**
 * The projected scope's `context` must be immutable IN FACT, not just in the
 * type system.
 *
 * `Readonly<Record<string, string>>` is erased at runtime. The projection
 * handed hooks the scope's OWN context object, so `ctx.scope.context.x = 'y'`
 * in a hook rewrote the caller's real `RequestScope`. `requireScopeContext()`
 * authorises against exactly those dimensions, so a later permission check in
 * the same request would read the tampered value and allow what it should
 * refuse — a privilege change made by a stray assignment.
 */

import { describe, expect, it } from "vitest";
import { buildRequestScopeProjection } from "../../src/scope/projection.js";
import type { RequestScope } from "../../src/scope/types.js";

function memberScope(): RequestScope {
  return {
    kind: "member",
    userId: "u1",
    organizationId: "org-1",
    orgRoles: ["member"],
    teamId: "team-1",
    context: { branchId: "branch-A", region: "eu" },
  } as unknown as RequestScope;
}

describe("projected scope context immutability", () => {
  it("writing to projection.context THROWS (ESM is strict mode)", () => {
    const p = buildRequestScopeProjection(memberScope());
    expect(() => {
      (p.context as Record<string, string>).branchId = "branch-B";
    }).toThrow();
  });

  it("a mutation attempt cannot reach the underlying RequestScope", () => {
    const scope = memberScope();
    const p = buildRequestScopeProjection(scope);
    try {
      (p.context as Record<string, string>).branchId = "branch-B";
    } catch {
      /* expected */
    }
    // The authorisation dimension is untouched.
    expect((scope as unknown as { context: Record<string, string> }).context.branchId).toBe(
      "branch-A",
    );
  });

  it("adding a NEW dimension is refused too — not just overwriting", () => {
    const p = buildRequestScopeProjection(memberScope());
    expect(() => {
      (p.context as Record<string, string>).smuggled = "yes";
    }).toThrow();
  });

  it("still PROJECTS the values — frozen, not dropped", () => {
    const p = buildRequestScopeProjection(memberScope());
    expect(p.context).toEqual({ branchId: "branch-A", region: "eu" });
    expect(p.teamId).toBe("team-1");
    expect(p.organizationId).toBe("org-1");
    expect(p.orgRoles).toEqual(["member"]);
  });

  it("a scope kind without context projects undefined, not an empty object", () => {
    // `{}` would read as "has context, it's empty" to a `requireScopeContext`
    // style caller — a different fact from "this scope carries none".
    const anon = { kind: "public" } as unknown as RequestScope;
    const p = buildRequestScopeProjection(anon);
    expect(p.context).toBeUndefined();
    expect(p.teamId).toBeUndefined();
  });
});
