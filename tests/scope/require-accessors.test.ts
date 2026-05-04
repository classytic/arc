/**
 * Throwing-accessor tests — `requireOrgId`, `requireUserId`,
 * `requireClientId`, `requireTeamId`.
 *
 * These pin the contract that the symmetric throwing variants:
 *   1. Return the same value as their `get*` counterpart on the happy path.
 *   2. Throw the canonical arc error class on the missing path
 *      (`OrgRequiredError` for org/team, `UnauthorizedError` for user/client).
 *   3. Surface the optional `hint` argument in the error message.
 *
 * Lifecycle: introduced in arc 2.12.0 to close the
 * "everyone hand-rolls `if (!orgId) throw new ForbiddenError(...)`" drift
 * surface. Symmetric to permission combinators (`requireRoles` etc.) but
 * at the accessor layer.
 */

import { describe, expect, it } from "vitest";
import type { RequestScope } from "../../src/scope/types.js";
import {
  PUBLIC_SCOPE,
  requireClientId,
  requireOrgId,
  requireTeamId,
  requireUserId,
} from "../../src/scope/types.js";
import { OrgRequiredError, UnauthorizedError } from "../../src/utils/errors.js";

const memberScope: RequestScope = {
  kind: "member",
  userId: "u_1",
  userRoles: [],
  organizationId: "org_1",
  orgRoles: ["admin"],
  teamId: "team_1",
};

const serviceScope: RequestScope = {
  kind: "service",
  clientId: "svc_ingestion",
  organizationId: "org_2",
  scopes: ["jobs:write"],
};

const elevatedScope: RequestScope = {
  kind: "elevated",
  userId: "u_admin",
  organizationId: "org_3",
  elevatedBy: "platform-admin",
};

const authenticatedScope: RequestScope = {
  kind: "authenticated",
  userId: "u_2",
};

describe("requireOrgId", () => {
  it("returns the org id on member scope", () => {
    expect(requireOrgId(memberScope)).toBe("org_1");
  });

  it("returns the org id on service scope", () => {
    expect(requireOrgId(serviceScope)).toBe("org_2");
  });

  it("returns the org id on elevated scope", () => {
    expect(requireOrgId(elevatedScope)).toBe("org_3");
  });

  it("throws OrgRequiredError on public scope", () => {
    expect(() => requireOrgId(PUBLIC_SCOPE)).toThrow(OrgRequiredError);
  });

  it("throws OrgRequiredError on authenticated-without-org scope", () => {
    expect(() => requireOrgId(authenticatedScope)).toThrow(OrgRequiredError);
  });

  it("the thrown error carries 403 + ORG_SELECTION_REQUIRED code", () => {
    try {
      requireOrgId(PUBLIC_SCOPE);
      throw new Error("expected requireOrgId to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(OrgRequiredError);
      // ArcError shape: statusCode + code
      const e = err as OrgRequiredError;
      expect(e.statusCode).toBe(403);
      expect(e.code).toBe("arc.org.selection_required");
    }
  });

  it("includes the hint in the thrown message when supplied", () => {
    try {
      requireOrgId(PUBLIC_SCOPE, "POST /orders");
      throw new Error("expected throw");
    } catch (err) {
      expect((err as Error).message).toContain("POST /orders");
    }
  });
});

describe("requireUserId", () => {
  it("returns the user id on authenticated scope", () => {
    expect(requireUserId(authenticatedScope)).toBe("u_2");
  });

  it("returns the user id on member scope", () => {
    expect(requireUserId(memberScope)).toBe("u_1");
  });

  it("returns the user id on elevated scope", () => {
    expect(requireUserId(elevatedScope)).toBe("u_admin");
  });

  it("throws UnauthorizedError on public scope", () => {
    expect(() => requireUserId(PUBLIC_SCOPE)).toThrow(UnauthorizedError);
  });

  it("throws UnauthorizedError on service scope (no user behind a service token)", () => {
    expect(() => requireUserId(serviceScope)).toThrow(UnauthorizedError);
  });

  it("the thrown error carries 401", () => {
    try {
      requireUserId(PUBLIC_SCOPE);
      throw new Error("expected throw");
    } catch (err) {
      expect((err as UnauthorizedError).statusCode).toBe(401);
    }
  });
});

describe("requireClientId", () => {
  it("returns the client id on service scope", () => {
    expect(requireClientId(serviceScope)).toBe("svc_ingestion");
  });

  it("throws on member scope (humans aren't service clients)", () => {
    expect(() => requireClientId(memberScope)).toThrow(UnauthorizedError);
  });

  it("throws on public scope", () => {
    expect(() => requireClientId(PUBLIC_SCOPE)).toThrow(UnauthorizedError);
  });
});

describe("requireTeamId", () => {
  it("returns the team id on member scope when set", () => {
    expect(requireTeamId(memberScope)).toBe("team_1");
  });

  it("throws on member scope without a team", () => {
    const noTeam: RequestScope = {
      kind: "member",
      userId: "u_1",
      userRoles: [],
      organizationId: "org_1",
      orgRoles: ["admin"],
    };
    expect(() => requireTeamId(noTeam)).toThrow(OrgRequiredError);
  });

  it("throws on service scope (services don't carry team context)", () => {
    expect(() => requireTeamId(serviceScope)).toThrow(OrgRequiredError);
  });

  it("includes the hint in the thrown message when supplied", () => {
    try {
      requireTeamId(serviceScope, "team-scoped report");
      throw new Error("expected throw");
    } catch (err) {
      expect((err as Error).message).toContain("team-scoped report");
    }
  });
});
