/**
 * Field-Level Permissions Tests
 *
 * Tests the field permission system:
 * - hidden() — always stripped from reads and writes
 * - visibleTo(roles) — only visible to specified roles
 * - writableBy(roles) — only writable by specified roles
 * - redactFor(roles) — redacted value for specified roles
 * - applyFieldReadPermissions
 * - applyFieldWritePermissions
 */

import { describe, expect, it } from "vitest";
import {
  applyFieldReadPermissions,
  applyFieldWritePermissions,
  type FieldPermissionMap,
  fields,
  resolveEffectiveRoles,
} from "../../src/permissions/fields.js";

describe("Field Permissions", () => {
  // ========================================================================
  // fields.hidden()
  // ========================================================================

  describe("fields.hidden()", () => {
    const permissions: FieldPermissionMap = {
      password: fields.hidden(),
      secret: fields.hidden(),
    };

    it("should strip hidden fields from reads for all roles", () => {
      const data = { name: "John", email: "j@example.com", password: "hash123", secret: "xyz" };

      const result = applyFieldReadPermissions(data, permissions, ["admin"]);
      expect(result.name).toBe("John");
      expect(result.email).toBe("j@example.com");
      expect(result).not.toHaveProperty("password");
      expect(result).not.toHaveProperty("secret");
    });

    it("should strip hidden fields even for unauthenticated users", () => {
      const data = { name: "John", password: "hash123" };

      const result = applyFieldReadPermissions(data, permissions, []);
      expect(result.name).toBe("John");
      expect(result).not.toHaveProperty("password");
    });

    it("should strip hidden fields from writes", () => {
      const body = { name: "John", password: "newpass", secret: "new-secret" };

      const { body: result, deniedFields } = applyFieldWritePermissions(body, permissions, ["admin"]);
      expect(result.name).toBe("John");
      expect(result).not.toHaveProperty("password");
      expect(result).not.toHaveProperty("secret");
      expect(deniedFields).toEqual(expect.arrayContaining(["password", "secret"]));
    });
  });

  // ========================================================================
  // fields.visibleTo(roles)
  // ========================================================================

  describe("fields.visibleTo(roles)", () => {
    const permissions: FieldPermissionMap = {
      salary: fields.visibleTo(["admin", "hr"]),
      internalNotes: fields.visibleTo(["admin"]),
    };

    it("should show field to users with matching role", () => {
      const data = { name: "John", salary: 50000, internalNotes: "good employee" };

      const result = applyFieldReadPermissions(data, permissions, ["admin"]);
      expect(result.salary).toBe(50000);
      expect(result.internalNotes).toBe("good employee");
    });

    it("should show field when user has one matching role (OR logic)", () => {
      const data = { name: "John", salary: 50000, internalNotes: "good" };

      const result = applyFieldReadPermissions(data, permissions, ["hr"]);
      expect(result.salary).toBe(50000);
      // hr doesn't have access to internalNotes
      expect(result).not.toHaveProperty("internalNotes");
    });

    it("should strip field for users without matching role", () => {
      const data = { name: "John", salary: 50000, internalNotes: "good" };

      const result = applyFieldReadPermissions(data, permissions, ["viewer"]);
      expect(result.name).toBe("John");
      expect(result).not.toHaveProperty("salary");
      expect(result).not.toHaveProperty("internalNotes");
    });

    it("should strip field for unauthenticated users (empty roles)", () => {
      const data = { name: "John", salary: 50000 };

      const result = applyFieldReadPermissions(data, permissions, []);
      expect(result).not.toHaveProperty("salary");
    });

    it("should NOT affect writes (visibleTo is read-only)", () => {
      const body = { name: "John", salary: 60000 };

      // visibleTo doesn't restrict writes
      const { body: result, deniedFields } = applyFieldWritePermissions(body, permissions, ["viewer"]);
      expect(result.salary).toBe(60000);
      expect(deniedFields).toEqual([]);
    });
  });

  // ========================================================================
  // fields.writableBy(roles)
  // ========================================================================

  describe("fields.writableBy(roles)", () => {
    const permissions: FieldPermissionMap = {
      role: fields.writableBy(["admin"]),
      isVerified: fields.writableBy(["admin", "moderator"]),
    };

    it("should allow write when user has matching role", () => {
      const body = { name: "John", role: "editor", isVerified: true };

      const { body: result, deniedFields } = applyFieldWritePermissions(body, permissions, ["admin"]);
      expect(result.role).toBe("editor");
      expect(result.isVerified).toBe(true);
      expect(deniedFields).toEqual([]);
    });

    it("should report denied fields when user lacks role", () => {
      const body = { name: "John", role: "admin", isVerified: true };

      const { body: result, deniedFields } = applyFieldWritePermissions(body, permissions, ["viewer"]);
      expect(result.name).toBe("John");
      expect(result).not.toHaveProperty("role");
      expect(result).not.toHaveProperty("isVerified");
      expect(deniedFields).toEqual(expect.arrayContaining(["role", "isVerified"]));
    });

    it("should NOT affect reads (writableBy is write-only)", () => {
      const data = { name: "John", role: "editor", isVerified: true };

      // writableBy doesn't restrict reads
      const result = applyFieldReadPermissions(data, permissions, ["viewer"]);
      expect(result.role).toBe("editor");
      expect(result.isVerified).toBe(true);
    });

    it("should only strip fields present in the body", () => {
      const body = { name: "John" }; // role is not in body

      const { body: result, deniedFields } = applyFieldWritePermissions(body, permissions, ["viewer"]);
      expect(result).toEqual({ name: "John" });
      expect(deniedFields).toEqual([]);
    });
  });

  // ========================================================================
  // fields.redactFor(roles)
  // ========================================================================

  describe("fields.redactFor(roles)", () => {
    const permissions: FieldPermissionMap = {
      email: fields.redactFor(["viewer"]),
      ssn: fields.redactFor(["basic"], "***-**-****"),
    };

    it("should redact field for matching roles with default placeholder", () => {
      const data = { name: "John", email: "john@example.com" };

      const result = applyFieldReadPermissions(data, permissions, ["viewer"]);
      expect(result.email).toBe("***");
    });

    it("should redact field with custom placeholder", () => {
      const data = { name: "John", ssn: "123-45-6789" };

      const result = applyFieldReadPermissions(data, permissions, ["basic"]);
      expect(result.ssn).toBe("***-**-****");
    });

    it("should show real value to non-matching roles", () => {
      const data = { name: "John", email: "john@example.com", ssn: "123-45-6789" };

      const result = applyFieldReadPermissions(data, permissions, ["admin"]);
      expect(result.email).toBe("john@example.com");
      expect(result.ssn).toBe("123-45-6789");
    });

    it("should show real value to unauthenticated users (empty roles)", () => {
      const data = { name: "John", email: "john@example.com" };

      // redactFor targets specific roles — empty roles don't match
      const result = applyFieldReadPermissions(data, permissions, []);
      expect(result.email).toBe("john@example.com");
    });

    it("should NOT affect writes (redactFor is read-only)", () => {
      const body = { email: "new@example.com" };

      const { body: result, deniedFields } = applyFieldWritePermissions(body, permissions, ["viewer"]);
      expect(result.email).toBe("new@example.com");
      expect(deniedFields).toEqual([]);
    });
  });

  // ========================================================================
  // Combined Permissions
  // ========================================================================

  describe("Combined permissions", () => {
    const permissions: FieldPermissionMap = {
      password: fields.hidden(),
      salary: fields.visibleTo(["admin", "hr"]),
      role: fields.writableBy(["admin"]),
      email: fields.redactFor(["viewer"]),
    };

    it("should apply all permission types together on reads", () => {
      const data = {
        name: "John",
        password: "hash",
        salary: 50000,
        role: "editor",
        email: "john@example.com",
      };

      // Admin sees everything except password
      const adminResult = applyFieldReadPermissions(data, permissions, ["admin"]);
      expect(adminResult).not.toHaveProperty("password");
      expect(adminResult.salary).toBe(50000);
      expect(adminResult.role).toBe("editor");
      expect(adminResult.email).toBe("john@example.com");

      // Viewer sees redacted email, no salary, no password
      const viewerResult = applyFieldReadPermissions(data, permissions, ["viewer"]);
      expect(viewerResult).not.toHaveProperty("password");
      expect(viewerResult).not.toHaveProperty("salary");
      expect(viewerResult.role).toBe("editor");
      expect(viewerResult.email).toBe("***");
    });

    it("should apply all permission types together on writes", () => {
      const body = {
        name: "John",
        password: "newpass",
        salary: 60000,
        role: "admin",
        email: "new@example.com",
      };

      // Admin can write role but not password
      const adminRes = applyFieldWritePermissions(body, permissions, ["admin"]);
      expect(adminRes.body).not.toHaveProperty("password");
      expect(adminRes.body.role).toBe("admin");
      expect(adminRes.body.email).toBe("new@example.com");
      expect(adminRes.deniedFields).toEqual(["password"]);

      // Viewer can't write password or role
      const viewerRes = applyFieldWritePermissions(body, permissions, ["viewer"]);
      expect(viewerRes.body).not.toHaveProperty("password");
      expect(viewerRes.body).not.toHaveProperty("role");
      expect(viewerRes.body.email).toBe("new@example.com");
      expect(viewerRes.deniedFields).toEqual(expect.arrayContaining(["password", "role"]));
    });
  });

  // ========================================================================
  // Edge Cases
  // ========================================================================

  describe("Edge cases", () => {
    it("should handle null/undefined data gracefully", () => {
      const permissions: FieldPermissionMap = { password: fields.hidden() };

      const result = applyFieldReadPermissions(null as any, permissions, ["admin"]);
      expect(result).toBeNull();
    });

    it("should handle empty permission map", () => {
      const data = { name: "John", email: "j@example.com" };
      const result = applyFieldReadPermissions(data, {}, ["admin"]);
      expect(result).toEqual(data);
    });

    it("should not mutate the original data object", () => {
      const permissions: FieldPermissionMap = { password: fields.hidden() };
      const original = { name: "John", password: "hash" };

      applyFieldReadPermissions(original, permissions, ["admin"]);
      // Original should still have password
      expect(original.password).toBe("hash");
    });

    it("should not mutate the original body object", () => {
      const permissions: FieldPermissionMap = { role: fields.writableBy(["admin"]) };
      const original = { name: "John", role: "admin" };

      applyFieldWritePermissions(original, permissions, ["viewer"]);
      // Original should still have role
      expect(original.role).toBe("admin");
    });
  });

  // ========================================================================
  // resolveEffectiveRoles
  // ========================================================================

  describe("resolveEffectiveRoles", () => {
    it("should return global roles when org roles are empty", () => {
      expect(resolveEffectiveRoles(["superadmin"], [])).toEqual(["superadmin"]);
    });

    it("should return org roles when global roles are empty", () => {
      expect(resolveEffectiveRoles([], ["admin"])).toEqual(["admin"]);
    });

    it("should merge global and org roles without duplicates", () => {
      const result = resolveEffectiveRoles(["user", "admin"], ["admin", "delivery_manager"]);
      expect(result).toContain("user");
      expect(result).toContain("admin");
      expect(result).toContain("delivery_manager");
      expect(result).toHaveLength(3); // deduped
    });
  });

  // ========================================================================
  // Bypass-Scoped Users (superadmin)
  //
  // Validates the core bug: superadmin users have orgRoles=['superadmin']
  // (their global roles), NOT org-level roles like 'admin'.
  // writableBy(['admin', 'delivery_manager']) would strip fields.
  // ========================================================================

  describe("Bypass-scoped user field permissions", () => {
    // Simulates the exact scenario from ai-hire: job field permissions
    const jobFieldPermissions: FieldPermissionMap = {
      assignedDeliveryManagers: fields.writableBy(["admin", "delivery_manager"]),
      assignedAccountManagers: fields.writableBy(["admin", "delivery_manager"]),
      assignedRecruiters: fields.writableBy(["admin", "delivery_manager", "account_manager"]),
    };

    it("should strip writableBy fields when superadmin role is not in allowed list", () => {
      // This is the BUG scenario — superadmin's effective roles don't include 'admin'
      const body = {
        title: "React Dev",
        assignedDeliveryManagers: ["user-id-1"],
        assignedAccountManagers: [],
        assignedRecruiters: [],
      };

      const effectiveRoles = resolveEffectiveRoles(["superadmin"], ["superadmin"]);
      // effectiveRoles = ['superadmin'] — does NOT include 'admin'
      expect(effectiveRoles).toEqual(["superadmin"]);

      const { body: result, deniedFields } = applyFieldWritePermissions(body, jobFieldPermissions, effectiveRoles);

      // BUG: without bypass check, all assignment fields are stripped
      expect(result).not.toHaveProperty("assignedDeliveryManagers");
      expect(result).not.toHaveProperty("assignedAccountManagers");
      expect(result).not.toHaveProperty("assignedRecruiters");
      expect(result.title).toBe("React Dev");
      expect(deniedFields).toEqual(
        expect.arrayContaining([
          "assignedDeliveryManagers",
          "assignedAccountManagers",
          "assignedRecruiters",
        ]),
      );
    });

    it("should preserve writableBy fields for regular org admin", () => {
      // Regular org admin — NOT superadmin, goes through normal membership lookup
      const body = {
        title: "React Dev",
        assignedDeliveryManagers: ["user-id-1"],
        assignedAccountManagers: [],
        assignedRecruiters: [],
      };

      // user.role = ['user'], orgRoles = ['admin'] (from membership)
      const effectiveRoles = resolveEffectiveRoles(["user"], ["admin"]);
      expect(effectiveRoles).toContain("admin");

      const { body: result, deniedFields } = applyFieldWritePermissions(body, jobFieldPermissions, effectiveRoles);

      // All fields preserved — 'admin' is in writableBy lists
      expect(result.assignedDeliveryManagers).toEqual(["user-id-1"]);
      expect(result.assignedAccountManagers).toEqual([]);
      expect(result.assignedRecruiters).toEqual([]);
      expect(deniedFields).toEqual([]);
    });

    it("should preserve writableBy fields for delivery_manager role", () => {
      const body = {
        title: "React Dev",
        assignedDeliveryManagers: ["dm-id"],
        assignedAccountManagers: ["am-id"],
      };

      const effectiveRoles = resolveEffectiveRoles(["user"], ["delivery_manager"]);
      const { body: result, deniedFields } = applyFieldWritePermissions(body, jobFieldPermissions, effectiveRoles);

      expect(result.assignedDeliveryManagers).toEqual(["dm-id"]);
      expect(result.assignedAccountManagers).toEqual(["am-id"]);
      expect(deniedFields).toEqual([]);
    });

    it("should strip DM/AM fields for account_manager role", () => {
      const body = {
        title: "React Dev",
        assignedDeliveryManagers: ["dm-id"],
        assignedAccountManagers: ["am-id"],
        assignedRecruiters: ["recruiter-id"],
      };

      const effectiveRoles = resolveEffectiveRoles(["user"], ["account_manager"]);
      const { body: result, deniedFields } = applyFieldWritePermissions(body, jobFieldPermissions, effectiveRoles);

      // AM can only write recruiters, not DM or AM assignments
      expect(result).not.toHaveProperty("assignedDeliveryManagers");
      expect(result).not.toHaveProperty("assignedAccountManagers");
      expect(result.assignedRecruiters).toEqual(["recruiter-id"]);
      expect(deniedFields).toEqual(
        expect.arrayContaining(["assignedDeliveryManagers", "assignedAccountManagers"]),
      );
    });
  });
});
