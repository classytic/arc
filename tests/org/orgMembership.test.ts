import { describe, expect, it, vi } from "vitest";
import { getUserOrgRoles, hasOrgRole, orgMembershipCheck } from "../../src/org/orgMembership.js";

describe("orgMembershipCheck()", () => {
  const makeUser = (orgs: Array<{ organizationId: string; roles?: string[] }>) => ({
    _id: "user-1",
    organizations: orgs,
  });

  it("returns false when user is null/undefined", async () => {
    expect(await orgMembershipCheck(null, "org-1")).toBe(false);
    expect(await orgMembershipCheck(undefined, "org-1")).toBe(false);
  });

  it("returns false when orgId is null/undefined", async () => {
    expect(await orgMembershipCheck(makeUser([]), null)).toBe(false);
    expect(await orgMembershipCheck(makeUser([]), undefined)).toBe(false);
  });

  it("returns true when user is member of organization", async () => {
    const user = makeUser([{ organizationId: "org-1" }]);
    expect(await orgMembershipCheck(user, "org-1")).toBe(true);
  });

  it("returns false when user is not member", async () => {
    const user = makeUser([{ organizationId: "org-2" }]);
    expect(await orgMembershipCheck(user, "org-1")).toBe(false);
  });

  it("supports custom userOrgsPath", async () => {
    const user = { _id: "u1", teams: [{ organizationId: "t1" }] };
    expect(await orgMembershipCheck(user, "t1", { userOrgsPath: "teams" })).toBe(true);
  });

  it("falls back to validateFromDb when not found in user object", async () => {
    const user = makeUser([]);
    const validateFromDb = vi.fn().mockResolvedValue(true);
    expect(await orgMembershipCheck(user, "org-1", { validateFromDb })).toBe(true);
    expect(validateFromDb).toHaveBeenCalledWith("user-1", "org-1");
  });

  it("does not call validateFromDb if found in user object", async () => {
    const user = makeUser([{ organizationId: "org-1" }]);
    const validateFromDb = vi.fn();
    await orgMembershipCheck(user, "org-1", { validateFromDb });
    expect(validateFromDb).not.toHaveBeenCalled();
  });

  it("handles user.id instead of user._id", async () => {
    const user = { id: "u2", organizations: [] as Array<{ organizationId: string }> };
    const validateFromDb = vi.fn().mockResolvedValue(false);
    await orgMembershipCheck(user, "org-1", { validateFromDb });
    expect(validateFromDb).toHaveBeenCalledWith("u2", "org-1");
  });

  it("compares orgId as string (handles ObjectId-like toString)", async () => {
    const user = makeUser([{ organizationId: "507f1f77bcf86cd799439011" }]);
    expect(await orgMembershipCheck(user, "507f1f77bcf86cd799439011")).toBe(true);
  });
});

describe("getUserOrgRoles()", () => {
  const makeUser = (orgs: Array<{ organizationId: string; roles?: string[] }>) => ({
    _id: "user-1",
    organizations: orgs,
  });

  it("returns empty array for null user", () => {
    expect(getUserOrgRoles(null, "org-1")).toEqual([]);
  });

  it("returns empty array for null orgId", () => {
    expect(getUserOrgRoles(makeUser([]), null)).toEqual([]);
  });

  it("returns roles for matching organization", () => {
    const user = makeUser([{ organizationId: "org-1", roles: ["admin", "editor"] }]);
    expect(getUserOrgRoles(user, "org-1")).toEqual(["admin", "editor"]);
  });

  it("returns empty array when not a member", () => {
    const user = makeUser([{ organizationId: "org-2", roles: ["admin"] }]);
    expect(getUserOrgRoles(user, "org-1")).toEqual([]);
  });

  it("returns empty array when membership has no roles", () => {
    const user = makeUser([{ organizationId: "org-1" }]);
    expect(getUserOrgRoles(user, "org-1")).toEqual([]);
  });
});

describe("hasOrgRole()", () => {
  const makeUser = (orgs: Array<{ organizationId: string; roles?: string[] }>) => ({
    _id: "user-1",
    organizations: orgs,
  });

  it("returns true when user has the role", () => {
    const user = makeUser([{ organizationId: "org-1", roles: ["admin", "editor"] }]);
    expect(hasOrgRole(user, "org-1", "admin")).toBe(true);
  });

  it("returns false when user lacks the role", () => {
    const user = makeUser([{ organizationId: "org-1", roles: ["editor"] }]);
    expect(hasOrgRole(user, "org-1", "admin")).toBe(false);
  });

  it("accepts array of roles (any match)", () => {
    const user = makeUser([{ organizationId: "org-1", roles: ["viewer"] }]);
    expect(hasOrgRole(user, "org-1", ["admin", "viewer"])).toBe(true);
  });

  it("returns false when no roles match", () => {
    const user = makeUser([{ organizationId: "org-1", roles: ["viewer"] }]);
    expect(hasOrgRole(user, "org-1", ["admin", "editor"])).toBe(false);
  });

  it("returns false for null user/orgId", () => {
    expect(hasOrgRole(null, "org-1", "admin")).toBe(false);
    expect(hasOrgRole(makeUser([]), null, "admin")).toBe(false);
  });
});
