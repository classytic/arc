/**
 * Tree Preset Tests
 *
 * Tests the tree preset configuration including:
 * - Route addition (GET /tree, GET /:parent/children)
 * - Controller options (parentField)
 * - Permission inheritance
 */

import { describe, expect, it, vi } from "vitest";
import { allowPublic, requireRoles } from "../../src/permissions/index.js";
import { applyPresets } from "../../src/presets/index.js";
import { unresolvedPresetPermission } from "../../src/presets/presetPermission.js";
import { treePreset } from "../../src/presets/tree.js";
import type {
  ControllerHandler,
  IRequestContext,
  PresetController,
  PresetResult,
  ResourceConfig,
  ResourcePermissions,
  RouteDefinition,
} from "../../src/types/index.js";

function getPresetRoutes(
  result: PresetResult,
  permissions: ResourcePermissions = {},
  controller: Record<string, unknown> = {},
) {
  if (result.routes) {
    return typeof result.routes === "function"
      ? result.routes(permissions, controller as PresetController)
      : result.routes;
  }
  return [];
}

/** The route's function handler calls `controller[method]` and returns its response. */
async function expectCallsController(
  build: (controller: Record<string, unknown>) => RouteDefinition | undefined,
  method: string,
) {
  const response = { data: method };
  const fn = vi.fn(async () => response);
  const route = build({ [method]: fn });
  const ctx = { params: {} } as unknown as IRequestContext;
  const handler = route?.handler as ControllerHandler;
  expect(typeof handler).toBe("function");
  await expect(handler(ctx)).resolves.toBe(response);
  expect(fn).toHaveBeenCalledWith(ctx);
}

describe("tree preset", () => {
  describe("Preset configuration", () => {
    it("should return correct preset name", () => {
      const result = treePreset();
      expect(result.name).toBe("tree");
    });

    it("should add GET /tree route", async () => {
      const routes = getPresetRoutes(treePreset(), { list: allowPublic() });
      const treeRoute = routes.find((r) => r.path === "/tree");
      expect(treeRoute).toBeDefined();
      expect(treeRoute?.method).toBe("GET");
      await expectCallsController(
        (c) => getPresetRoutes(treePreset(), {}, c).find((r) => r.path === "/tree"),
        "getTree",
      );
    });

    it("should add GET /:parent/children route with default parent field", async () => {
      const routes = getPresetRoutes(treePreset(), { list: allowPublic() });
      const childrenRoute = routes.find((r) => r.path.includes("/children"));
      expect(childrenRoute).toBeDefined();
      expect(childrenRoute?.method).toBe("GET");
      expect(childrenRoute?.path).toBe("/:parent/children");
      await expectCallsController(
        (c) => getPresetRoutes(treePreset(), {}, c).find((r) => r.path === "/:parent/children"),
        "getChildren",
      );
    });

    it("should use list permission for /tree route", () => {
      const listPermission = requireRoles(["admin"]);
      const routes = getPresetRoutes(treePreset(), { list: listPermission });
      const treeRoute = routes.find((r) => r.path === "/tree");
      expect(treeRoute?.permissions).toBe(listPermission);
    });

    it("marks both routes unresolved (never public) when list permission is not defined", () => {
      const routes = getPresetRoutes(treePreset(), {});
      for (const route of routes) {
        expect(unresolvedPresetPermission(route.permissions)).toEqual({
          preset: "tree",
          inherits: "list",
        });
      }
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
