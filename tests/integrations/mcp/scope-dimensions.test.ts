/**
 * MCP must carry the SAME scope dimensions as HTTP.
 *
 * `buildScope` dropped `teamId` and `context`, so a resource gated by
 * `requireScopeContext('branchId')` worked over HTTP and DENIED every MCP
 * call — the dimension it authorises against was never populated. Fail-closed,
 * which is why nothing caught it: the tool was unusable rather than wrong.
 */

import { describe, expect, it } from "vitest";
import { buildScope } from "../../../src/integrations/mcp/buildRequestContext.js";
import { requireScopeContext } from "../../../src/permissions/scope.js";
import { getScopeContext, getTeamId } from "../../../src/scope/types.js";

describe("MCP scope dimensions", () => {
  it("a member session carries teamId and context onto the scope", () => {
    const scope = buildScope({
      userId: "u1",
      organizationId: "org-1",
      orgRoles: ["member"],
      teamId: "team-9",
      context: { branchId: "branch-A" },
    });
    expect(scope.kind).toBe("member");
    expect(getTeamId(scope)).toBe("team-9");
    expect(getScopeContext(scope, "branchId")).toBe("branch-A");
  });

  it("a SERVICE session carries context (teamId is member-only, as on HTTP)", () => {
    const scope = buildScope({
      clientId: "client-1",
      organizationId: "org-1",
      context: { region: "eu" },
    });
    expect(scope.kind).toBe("service");
    expect(getScopeContext(scope, "region")).toBe("eu");
    expect(getTeamId(scope)).toBeUndefined();
  });

  it("requireScopeContext() now PASSES on MCP when the resolver supplies it", async () => {
    const check = requireScopeContext("branchId", "branch-A");
    const scope = buildScope({
      userId: "u1",
      organizationId: "org-1",
      context: { branchId: "branch-A" },
    });
    expect(await check({ scope } as never)).toBe(true);
  });

  it("and still DENIES when the dimension is absent — fail-closed preserved", async () => {
    const check = requireScopeContext("branchId");
    const scope = buildScope({ userId: "u1", organizationId: "org-1" });
    const result = await check({ scope } as never);
    expect(result).not.toBe(true);
  });

  it("non-string dimensions are DROPPED, never coerced", async () => {
    // Coercing would make the check compare against something that was
    // never a branch id.
    const scope = buildScope({
      userId: "u1",
      organizationId: "org-1",
      context: { branchId: 42, region: "eu" } as never,
    });
    expect(getScopeContext(scope, "branchId")).toBeUndefined();
    expect(getScopeContext(scope, "region")).toBe("eu");
  });

  it("an empty/garbage context yields NO context, not an empty one", () => {
    expect(buildScope({ userId: "u1", organizationId: "o", context: {} }).kind).toBe("member");
    const s1 = buildScope({ userId: "u1", organizationId: "o", context: {} });
    const s2 = buildScope({ userId: "u1", organizationId: "o", context: "nope" as never });
    expect(getScopeContext(s1, "any")).toBeUndefined();
    expect(getScopeContext(s2, "any")).toBeUndefined();
  });
});
