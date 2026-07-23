import { describe, expect, it } from "vitest";
import { getUserRoles, normalizeRoles } from "../../src/utils/userHelpers.js";

describe("user role helpers", () => {
  it("normalizes comma-separated and array role values", () => {
    expect(normalizeRoles("admin, user")).toEqual(["admin", "user"]);
    expect(normalizeRoles(["admin", " user "])).toEqual(["admin", "user"]);
  });

  it("supports canonical role and legacy/plural roles identity shapes", () => {
    expect(getUserRoles({ role: "admin" })).toEqual(["admin"]);
    expect(getUserRoles({ roles: ["editor", "viewer"] })).toEqual(["editor", "viewer"]);
  });

  it("prefers role when both shapes are present", () => {
    expect(getUserRoles({ role: "admin", roles: ["viewer"] })).toEqual(["admin"]);
  });
});
