/**
 * Transport-neutral context (arc 2.31, P6) — a permission check depends only on
 * FACTS (scope, data, params), never on a raw Fastify request. These pin that a
 * REQUEST-LESS context (as MCP / jobs build) evaluates built-ins correctly.
 */

import { describe, expect, it } from "vitest";
import { evaluatePermissionDecision } from "../../src/permissions/authorizationDecision.js";
import { scopeOf } from "../../src/permissions/context.js";
import { requireOrgRole } from "../../src/permissions/index.js";
import type { PermissionContext } from "../../src/permissions/types.js";
import type { RequestScope } from "../../src/scope/types.js";

/** A context with NO `request` — exactly what MCP/jobs construct. */
function requestlessCtx(
  scope?: RequestScope,
  over: Partial<PermissionContext> = {},
): PermissionContext {
  return { user: null, scope, resource: "doc", action: "list", ...over };
}

describe("scopeOf — request-less contexts", () => {
  it("returns the first-class scope when present", () => {
    const scope: RequestScope = { kind: "service", clientId: "c1", organizationId: "o1" };
    expect(scopeOf(requestlessCtx(scope))).toBe(scope);
  });

  it("falls back to PUBLIC_SCOPE when neither scope nor request is present", () => {
    expect(scopeOf(requestlessCtx()).kind).toBe("public");
  });
});

describe("built-in permissions evaluate on a request-less context (MCP/jobs parity)", () => {
  const member = (orgRoles: string[]): RequestScope => ({
    kind: "member",
    userId: "u1",
    userRoles: [],
    organizationId: "o1",
    orgRoles,
  });

  it("requireOrgRole grants/denies from ctx.scope alone — no request needed", async () => {
    const ctx = (roles: string[]) => requestlessCtx(member(roles), { user: { id: "u1" } });
    expect((await evaluatePermissionDecision(requireOrgRole("admin"), ctx(["admin"]))).effect).toBe(
      "allow",
    );
    expect(
      (await evaluatePermissionDecision(requireOrgRole("admin"), ctx(["viewer"]))).effect,
    ).toBe("deny");
  });
});
