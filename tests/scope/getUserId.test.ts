/**
 * getUserId Scope Accessor Tests
 *
 * Validates extraction of userId from RequestScope variants.
 * userId is set by auth adapters at scope-building time from user.id / user._id / user.sub.
 */

import { describe, expect, it } from "vitest";
import type { RequestScope } from "../../src/scope/types.js";
import { AUTHENTICATED_SCOPE, getUserId, PUBLIC_SCOPE } from "../../src/scope/types.js";

describe("getUserId", () => {
  it("should return undefined for public scope", () => {
    expect(getUserId(PUBLIC_SCOPE)).toBeUndefined();
  });

  it("should return undefined for AUTHENTICATED_SCOPE constant (no userId)", () => {
    expect(getUserId(AUTHENTICATED_SCOPE)).toBeUndefined();
  });

  it("should return userId from authenticated scope", () => {
    const scope: RequestScope = { kind: "authenticated", userId: "ba_user_123" };
    expect(getUserId(scope)).toBe("ba_user_123");
  });

  it("should return userId from member scope", () => {
    const scope: RequestScope = {
      kind: "member",
      userId: "507f1f77bcf86cd799439011",
      userRoles: [],
      organizationId: "org_1",
      orgRoles: ["admin"],
    };
    expect(getUserId(scope)).toBe("507f1f77bcf86cd799439011");
  });

  it("should return userId from elevated scope", () => {
    const scope: RequestScope = {
      kind: "elevated",
      userId: "jwt_subject_456",
      elevatedBy: "jwt_subject_456",
    };
    expect(getUserId(scope)).toBe("jwt_subject_456");
  });

  it("should return undefined when userId is not set on authenticated scope", () => {
    const scope: RequestScope = { kind: "authenticated" };
    expect(getUserId(scope)).toBeUndefined();
  });

  it("should return undefined when userId is not set on elevated scope", () => {
    const scope: RequestScope = { kind: "elevated", elevatedBy: "system" };
    expect(getUserId(scope)).toBeUndefined();
  });
});
