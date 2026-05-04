/**
 * Tree Preset Tests
 *
 * Tests the tree preset configuration including:
 * - Route addition (GET /tree, GET /:parent/children)
 * - Controller options (parentField)
 * - Permission inheritance
 */

import { describe, expect, it } from "vitest";
import { allowPublic, requireRoles } from "../../src/permissions/index.js";
import { applyPresets } from "../../src/presets/index.js";
import { treePreset } from "../../src/presets/tree.js";
import type { PresetResult, ResourceConfig, ResourcePermissions } from "../../src/types/index.js";

function getPresetRoutes(result: PresetResult, permissions: ResourcePermissions = {}) {
  if (result.routes) {
    return typeof result.routes === "function" ? result.routes(permissions) : result.routes;
  }
  return [];
}

describe("tree preset", () => {
  describe("Preset configuration", () => {
    it("should return correct preset name", () => {
      const result = treePreset();
      expect(result.name).toBe("tree");
    });

    it("should add GET /tree route", () => {
      const routes = getPresetRoutes(treePreset(), { list: allowPublic() });
      const treeRoute = routes.find((r) => r.path === "/tree");
      expect(treeRoute).toBeDefined();
      expect(treeRoute?.method).toBe("GET");
      expect(treeRoute?.handler).toBe("getTree");
    });

    it("should add GET /:parent/children route with default parent field", () => {
      const routes = getPresetRoutes(treePreset(), { list: allowPublic() });
      const childrenRoute = routes.find((r) => r.path.includes("/children"));
      expect(childrenRoute).toBeDefined();
      expect(childrenRoute?.method).toBe("GET");
      expect(childrenRoute?.path).toBe("/:parent/children");
      expect(childrenRoute?.handler).toBe("getChildren");
    });

    it("should use list permission for /tree route", () => {
      const listPermission = requireRoles(["admin"]);
      const routes = getPresetRoutes(treePreset(), { list: listPermission });
      const treeRoute = routes.find((r) => r.path === "/tree");
      expect(treeRoute?.permissions).toBe(listPermission);
    });

    it("should fallback to allowPublic if list permission not defined", () => {
      const routes = getPresetRoutes(treePreset(), {});
      const treeRoute = routes.find((r) => r.path === "/tree");
      expect(treeRoute?.permissions).toBeDefined();
      expect(typeof treeRoute?.permissions).toBe("function");
    });

    it("should use list permission for children route", () => {
      const listPermission = requireRoles(["editor"]);
      const routes = getPresetRoutes(treePreset(), { list: listPermission });
      const childrenRoute = routes.find((r) => r.path.includes("/children"));
      expect(childrenRoute?.permissions).toBe(listPermission);
    });

    it("should provide controllerOptions with parentField", () => {
      const result = treePreset();
      expect(result.controllerOptions).toBeDefined();
      expect(result.controllerOptions?.parentField).toBe("parent");
    });
  });

  describe("Custom parent field", () => {
    it("should support custom parent field name", () => {
      const routes = getPresetRoutes(treePreset({ parentField: "parentItem" }), {
        list: allowPublic(),
      });
      const childrenRoute = routes.find((r) => r.path.includes("/children"));
      expect(childrenRoute?.path).toBe("/:parentItem/children");
    });

    it("should pass custom parentField to controller options", () => {
      const result = treePreset({ parentField: "parentItem" });
      expect(result.controllerOptions?.parentField).toBe("parentItem");
    });
  });

  describe("Preset application", () => {
    it("should apply preset to resource config", () => {
      const baseConfig: ResourceConfig = {
        name: "category",
        permissions: { list: allowPublic() },
        presets: ["tree"],
      };

      const result = applyPresets(baseConfig, ["tree"]);

      expect(result.routes).toBeDefined();
      const routePaths = result.routes?.map((r) => r.path);
      expect(routePaths).toContain("/tree");
      expect(routePaths.some((p) => p.includes("/children"))).toBe(true);
    });

    it("should merge controller options", () => {
      const baseConfig: ResourceConfig = {
        name: "category",
        permissions: { list: allowPublic() },
        presets: [{ name: "tree", parentField: "parentCategory" }],
      };

      const result = applyPresets(baseConfig, [{ name: "tree", parentField: "parentCategory" }]);

      expect(result._controllerOptions?.parentField).toBe("parentCategory");
    });
  });
});
