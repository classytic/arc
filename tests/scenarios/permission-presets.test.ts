/**
 * Permission Presets — Unit Tests
 *
 * Tests all permission preset functions from presets.ts.
 * These are pure functions that return ResourcePermissions objects.
 *
 * Run with: npx vitest run tests/scenarios/permission-presets.test.ts
 */

import { describe, expect, it } from "vitest";
import { allowPublic, type PermissionCheck, requireRoles } from "../../src/permissions/index.js";
import {
  adminOnly,
  authenticated,
  fullPublic,
  ownerWithAdminBypass,
  publicRead,
  publicReadAdminWrite,
  readOnly,
} from "../../src/permissions/presets.js";
import type { PermissionContext } from "../../src/permissions/types.js";

// ============================================================================
// Helpers
// ============================================================================

function makeCtx(overrides: Partial<PermissionContext> = {}): PermissionContext {
  return {
    user: { id: "u1", role: [] },
    request: {} as any,
    resource: "test",
    action: "list",
    ...overrides,
  };
}

function isPublicCheck(check: PermissionCheck | undefined): boolean {
  if (!check) return false;
  // allowPublic marks itself with _isPublic
  return (check as any)._isPublic === true;
}

async function checkGranted(
  check: PermissionCheck | undefined,
  ctx: PermissionContext,
): Promise<boolean> {
  if (!check) return false;
  const result = await check(ctx);
  return result === true || (typeof result === "object" && result.granted === true);
}

// ============================================================================
// Tests
// ============================================================================

describe("Permission Presets", () => {
  // --------------------------------------------------------------------------
  // publicRead
  // --------------------------------------------------------------------------

  describe("publicRead()", () => {
    it("should set list and get to allowPublic", () => {
      const perms = publicRead();
      expect(isPublicCheck(perms.list)).toBe(true);
      expect(isPublicCheck(perms.get)).toBe(true);
    });

    it("should set create, update, delete to requireAuth", async () => {
      const perms = publicRead();
      const unauthed = makeCtx({ user: null });
      const authed = makeCtx({ user: { id: "u1", role: [] } });

      // Unauthenticated should fail create/update/delete
      expect(await checkGranted(perms.create, unauthed)).toBe(false);
      expect(await checkGranted(perms.update, unauthed)).toBe(false);
      expect(await checkGranted(perms.delete, unauthed)).toBe(false);

      // Authenticated should pass
      expect(await checkGranted(perms.create, authed)).toBe(true);
      expect(await checkGranted(perms.update, authed)).toBe(true);
      expect(await checkGranted(perms.delete, authed)).toBe(true);
    });

    it("should accept overrides for individual operations", async () => {
      const perms = publicRead({ delete: requireRoles(["superadmin"]) });
      const authed = makeCtx({ user: { id: "u1", role: ["user"] } });
      const superadmin = makeCtx({ user: { id: "u1", role: ["superadmin"] } });

      // Regular auth user can still create/update
      expect(await checkGranted(perms.create, authed)).toBe(true);
      // But cannot delete (requires superadmin)
      expect(await checkGranted(perms.delete, authed)).toBe(false);
      // Superadmin can delete
      expect(await checkGranted(perms.delete, superadmin)).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // publicReadAdminWrite
  // --------------------------------------------------------------------------

  describe("publicReadAdminWrite()", () => {
    it("should set list/get to allowPublic, writes to requireRoles", () => {
      const perms = publicReadAdminWrite();
      expect(isPublicCheck(perms.list)).toBe(true);
      expect(isPublicCheck(perms.get)).toBe(true);
    });

    it("should deny writes for non-admin", async () => {
      const perms = publicReadAdminWrite();
      const user = makeCtx({ user: { id: "u1", role: ["user"] } });

      expect(await checkGranted(perms.create, user)).toBe(false);
      expect(await checkGranted(perms.update, user)).toBe(false);
      expect(await checkGranted(perms.delete, user)).toBe(false);
    });

    it("should allow writes for admin", async () => {
      const perms = publicReadAdminWrite();
      const admin = makeCtx({ user: { id: "u1", role: ["admin"] } });

      expect(await checkGranted(perms.create, admin)).toBe(true);
      expect(await checkGranted(perms.update, admin)).toBe(true);
      expect(await checkGranted(perms.delete, admin)).toBe(true);
    });

    it("should accept custom role array", async () => {
      const perms = publicReadAdminWrite(["editor", "moderator"]);
      const editor = makeCtx({ user: { id: "u1", role: ["editor"] } });
      const admin = makeCtx({ user: { id: "u1", role: ["admin"] } });

      expect(await checkGranted(perms.create, editor)).toBe(true);
      expect(await checkGranted(perms.create, admin)).toBe(false);
    });

    it("should accept overrides", async () => {
      const perms = publicReadAdminWrite(["admin"], { delete: allowPublic() });
      expect(isPublicCheck(perms.delete)).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // authenticated
  // --------------------------------------------------------------------------

  describe("authenticated()", () => {
    it("should set all operations to requireAuth", async () => {
      const perms = authenticated();
      const unauthed = makeCtx({ user: null });
      const authed = makeCtx({ user: { id: "u1", role: [] } });

      expect(await checkGranted(perms.list, unauthed)).toBe(false);
      expect(await checkGranted(perms.get, unauthed)).toBe(false);
      expect(await checkGranted(perms.create, unauthed)).toBe(false);
      expect(await checkGranted(perms.update, unauthed)).toBe(false);
      expect(await checkGranted(perms.delete, unauthed)).toBe(false);

      expect(await checkGranted(perms.list, authed)).toBe(true);
      expect(await checkGranted(perms.get, authed)).toBe(true);
      expect(await checkGranted(perms.create, authed)).toBe(true);
    });

    it("should accept overrides", async () => {
      const perms = authenticated({ list: allowPublic() });
      expect(isPublicCheck(perms.list)).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // adminOnly
  // --------------------------------------------------------------------------

  describe("adminOnly()", () => {
    it('should set all operations to requireRoles(["admin"])', async () => {
      const perms = adminOnly();
      const user = makeCtx({ user: { id: "u1", role: ["user"] } });
      const admin = makeCtx({ user: { id: "u1", role: ["admin"] } });

      expect(await checkGranted(perms.list, user)).toBe(false);
      expect(await checkGranted(perms.create, user)).toBe(false);
      expect(await checkGranted(perms.list, admin)).toBe(true);
      expect(await checkGranted(perms.create, admin)).toBe(true);
    });

    it("should accept custom roles", async () => {
      const perms = adminOnly(["superadmin"]);
      const admin = makeCtx({ user: { id: "u1", role: ["admin"] } });
      const superadmin = makeCtx({ user: { id: "u1", role: ["superadmin"] } });

      expect(await checkGranted(perms.list, admin)).toBe(false);
      expect(await checkGranted(perms.list, superadmin)).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // ownerWithAdminBypass
  // --------------------------------------------------------------------------

  describe("ownerWithAdminBypass()", () => {
    it("should set list/get/create to requireAuth", async () => {
      const perms = ownerWithAdminBypass();
      const unauthed = makeCtx({ user: null });
      const authed = makeCtx({ user: { id: "u1", role: [] } });

      expect(await checkGranted(perms.list, unauthed)).toBe(false);
      expect(await checkGranted(perms.create, unauthed)).toBe(false);
      expect(await checkGranted(perms.list, authed)).toBe(true);
      expect(await checkGranted(perms.create, authed)).toBe(true);
    });

    it("should have update/delete as anyOf(requireRoles, requireOwnership)", async () => {
      const perms = ownerWithAdminBypass();
      // Update/delete checks should be functions (they are composed)
      expect(perms.update).toBeTypeOf("function");
      expect(perms.delete).toBeTypeOf("function");
    });

    it("should accept custom ownerField and bypassRoles", () => {
      const perms = ownerWithAdminBypass("createdBy", ["superadmin"]);
      expect(perms.update).toBeTypeOf("function");
      expect(perms.delete).toBeTypeOf("function");
    });
  });

  // --------------------------------------------------------------------------
  // fullPublic
  // --------------------------------------------------------------------------

  describe("fullPublic()", () => {
    it("should set all operations to allowPublic", () => {
      const perms = fullPublic();
      expect(isPublicCheck(perms.list)).toBe(true);
      expect(isPublicCheck(perms.get)).toBe(true);
      expect(isPublicCheck(perms.create)).toBe(true);
      expect(isPublicCheck(perms.update)).toBe(true);
      expect(isPublicCheck(perms.delete)).toBe(true);
    });

    it("should accept overrides", async () => {
      const perms = fullPublic({ delete: requireRoles(["admin"]) });
      const user = makeCtx({ user: { id: "u1", role: ["user"] } });
      expect(await checkGranted(perms.delete, user)).toBe(false);
      // Other operations remain public
      expect(isPublicCheck(perms.list)).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // readOnly
  // --------------------------------------------------------------------------

  describe("readOnly()", () => {
    it("should set list and get to requireAuth", async () => {
      const perms = readOnly();
      const authed = makeCtx({ user: { id: "u1", role: [] } });
      expect(await checkGranted(perms.list, authed)).toBe(true);
      expect(await checkGranted(perms.get, authed)).toBe(true);
    });

    it("should not define create/update/delete", () => {
      const perms = readOnly();
      expect(perms.create).toBeUndefined();
      expect(perms.update).toBeUndefined();
      expect(perms.delete).toBeUndefined();
    });

    it("should accept overrides", async () => {
      const perms = readOnly({ create: requireRoles(["admin"]) });
      const admin = makeCtx({ user: { id: "u1", role: ["admin"] } });
      expect(await checkGranted(perms.create, admin)).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // Override Mechanics
  // --------------------------------------------------------------------------

  describe("Override mechanics", () => {
    it("undefined override values should not clear base operations", () => {
      const perms = publicRead({ create: undefined });
      // create should still be requireAuth (not undefined)
      expect(perms.create).toBeTypeOf("function");
    });

    it("override should replace individual operations", async () => {
      const perms = authenticated({ delete: allowPublic() });
      expect(isPublicCheck(perms.delete)).toBe(true);
      // Other operations unchanged
      const unauthed = makeCtx({ user: null });
      expect(await checkGranted(perms.list, unauthed)).toBe(false);
    });
  });
});
