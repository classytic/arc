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

/** Extract routes from preset result (supports both `routes` and legacy `routes`). */
function getPresetRoutes(
  result: ReturnType<typeof softDeletePreset>,
  permissions: ResourcePermissions = {},
) {
  if (result.routes) {
    return typeof result.routes === "function" ? result.routes(permissions) : result.routes;
  }
  if (result.routes) {
    return typeof result.routes === "function"
      ? result.routes(permissions)
      : result.routes;
  }
  return [];
}

describe("softDelete preset", () => {
  describe("Preset configuration", () => {
    it("should return correct preset name", () => {
      const result = softDeletePreset();
      expect(result.name).toBe("softDelete");
    });

    it("should add GET /deleted route", () => {
      const routes = getPresetRoutes(softDeletePreset(), { list: allowPublic() });
      const deletedRoute = routes.find((r) => r.path === "/deleted");
      expect(deletedRoute).toBeDefined();
      expect(deletedRoute?.method).toBe("GET");
      expect(deletedRoute?.handler).toBe("getDeleted");
    });

    it("should add POST /:id/restore route", () => {
      const routes = getPresetRoutes(softDeletePreset(), {
        update: requireRoles(["admin"]),
      });
      const restoreRoute = routes.find((r) => r.path === "/:id/restore");
      expect(restoreRoute).toBeDefined();
      expect(restoreRoute?.method).toBe("POST");
      expect(restoreRoute?.handler).toBe("restore");
    });

    it("should use list permission for /deleted route", () => {
      const listPermission = requireRoles(["admin"]);
      const routes = getPresetRoutes(softDeletePreset(), { list: listPermission });
      const deletedRoute = routes.find((r) => r.path === "/deleted");
      expect(deletedRoute?.permissions).toBe(listPermission);
    });

    it("should fallback to requireRoles admin if list permission not defined", () => {
      const routes = getPresetRoutes(softDeletePreset(), {});
      const deletedRoute = routes.find((r) => r.path === "/deleted");
      expect(deletedRoute?.permissions).toBeDefined();
      expect(typeof deletedRoute?.permissions).toBe("function");
    });

    it("should use update permission for restore route", () => {
      const updatePermission = requireRoles(["superadmin"]);
      const routes = getPresetRoutes(softDeletePreset(), { update: updatePermission });
      const restoreRoute = routes.find((r) => r.path === "/:id/restore");
      expect(restoreRoute?.permissions).toBe(updatePermission);
    });

    it("should fallback to requireRoles admin if update permission not defined", () => {
      const routes = getPresetRoutes(softDeletePreset(), {});
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

      // Preset routes merged into config.routes
      expect(result.routes).toBeDefined();
      expect(result.routes!.length).toBeGreaterThanOrEqual(2);

      const routePaths = result.routes!.map((r) => r.path);
      expect(routePaths).toContain("/deleted");
      expect(routePaths).toContain("/:id/restore");
    });

    it("should preserve existing routes", () => {
      const baseConfig: ResourceConfig = {
        name: "product",
        permissions: {},
        routes: [
          {
            method: "GET",
            path: "/custom",
            handler: "custom",
            permissions: allowPublic(),
          },
        ],
        presets: ["softDelete"],
      };

      const result = applyPresets(baseConfig, ["softDelete"]);

      const routePaths = result.routes!.map((r) => r.path);
      expect(routePaths).toContain("/custom");
      expect(routePaths).toContain("/deleted");
    });
  });
});
