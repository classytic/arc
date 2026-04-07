/**
 * Soft Delete Preset Tests
 *
 * Tests the soft delete preset configuration including:
 * - Route addition (GET /deleted, POST /:id/restore)
 * - Preset metadata and permissions
 * - Route registration
 */

import { describe, expect, it } from "vitest";
import { allowPublic, requireRoles } from "../../src/permissions/index.js";
import { applyPresets } from "../../src/presets/index.js";
import { softDeletePreset } from "../../src/presets/softDelete.js";
import type { ResourceConfig, ResourcePermissions } from "../../src/types/index.js";

describe("softDelete preset", () => {
  describe("Preset configuration", () => {
    it("should return correct preset name", () => {
      const result = softDeletePreset();
      expect(result.name).toBe("softDelete");
    });

    it("should add GET /deleted route", () => {
      const result = softDeletePreset();
      const permissions: ResourcePermissions = { list: allowPublic() };

      // additionalRoutes is a function that takes permissions
      const routes =
        typeof result.additionalRoutes === "function"
          ? result.additionalRoutes(permissions)
          : result.additionalRoutes || [];

      const deletedRoute = routes.find((r) => r.path === "/deleted");
      expect(deletedRoute).toBeDefined();
      expect(deletedRoute?.method).toBe("GET");
      expect(deletedRoute?.handler).toBe("getDeleted");
    });

    it("should add POST /:id/restore route", () => {
      const result = softDeletePreset();
      const permissions: ResourcePermissions = { update: requireRoles(["admin"]) };

      const routes =
        typeof result.additionalRoutes === "function"
          ? result.additionalRoutes(permissions)
          : result.additionalRoutes || [];

      const restoreRoute = routes.find((r) => r.path === "/:id/restore");
      expect(restoreRoute).toBeDefined();
      expect(restoreRoute?.method).toBe("POST");
      expect(restoreRoute?.handler).toBe("restore");
    });

    it("should use list permission for /deleted route", () => {
      const result = softDeletePreset();
      const listPermission = requireRoles(["admin"]);
      const permissions: ResourcePermissions = { list: listPermission };

      const routes =
        typeof result.additionalRoutes === "function"
          ? result.additionalRoutes(permissions)
          : result.additionalRoutes || [];

      const deletedRoute = routes.find((r) => r.path === "/deleted");
      expect(deletedRoute?.permissions).toBe(listPermission);
    });

    it("should fallback to requireRoles admin if list permission not defined", () => {
      const result = softDeletePreset();
      const permissions: ResourcePermissions = {};

      const routes =
        typeof result.additionalRoutes === "function"
          ? result.additionalRoutes(permissions)
          : result.additionalRoutes || [];

      const deletedRoute = routes.find((r) => r.path === "/deleted");
      expect(deletedRoute?.permissions).toBeDefined();
      expect(typeof deletedRoute?.permissions).toBe("function");
    });

    it("should use update permission for restore route", () => {
      const result = softDeletePreset();
      const updatePermission = requireRoles(["superadmin"]);
      const permissions: ResourcePermissions = { update: updatePermission };

      const routes =
        typeof result.additionalRoutes === "function"
          ? result.additionalRoutes(permissions)
          : result.additionalRoutes || [];

      const restoreRoute = routes.find((r) => r.path === "/:id/restore");
      expect(restoreRoute?.permissions).toBe(updatePermission);
    });

    it("should fallback to requireRoles admin if update permission not defined", () => {
      const result = softDeletePreset();
      const permissions: ResourcePermissions = {};

      const routes =
        typeof result.additionalRoutes === "function"
          ? result.additionalRoutes(permissions)
          : result.additionalRoutes || [];

      const restoreRoute = routes.find((r) => r.path === "/:id/restore");
      expect(restoreRoute?.permissions).toBeDefined();
      expect(typeof restoreRoute?.permissions).toBe("function");
    });
  });

  describe("Preset application", () => {
    it("should apply preset to resource config", () => {
      const baseConfig: ResourceConfig = {
        name: "product",
        permissions: { list: allowPublic(), update: requireRoles(["admin"]) },
        presets: ["softDelete"],
      };

      const result = applyPresets(baseConfig, ["softDelete"]);

      // Should have additional routes added
      expect(result.additionalRoutes).toBeDefined();
      expect(result.additionalRoutes?.length).toBeGreaterThanOrEqual(2);

      // Find the preset routes
      const routePaths = result.additionalRoutes?.map((r) => r.path) || [];
      expect(routePaths).toContain("/deleted");
      expect(routePaths).toContain("/:id/restore");
    });

    it("should preserve existing additional routes", () => {
      const baseConfig: ResourceConfig = {
        name: "product",
        permissions: {},
        additionalRoutes: [
          {
            method: "GET",
            path: "/custom",
            handler: "custom",
            permissions: allowPublic(),
            wrapHandler: true,
          },
        ],
        presets: ["softDelete"],
      };

      const result = applyPresets(baseConfig, ["softDelete"]);

      // Should have both existing and preset routes
      const routePaths = result.additionalRoutes?.map((r) => r.path) || [];
      expect(routePaths).toContain("/custom");
      expect(routePaths).toContain("/deleted");
    });
  });
});
