/**
 * Slug Lookup Preset Tests
 *
 * Tests the slug lookup preset configuration including:
 * - Route addition (GET /slug/:slug)
 * - Controller options (slugField)
 * - Permission inheritance
 */

import { describe, expect, it, vi } from "vitest";
import { allowPublic, requireRoles } from "../../src/permissions/index.js";
import { applyPresets } from "../../src/presets/index.js";
import { unresolvedPresetPermission } from "../../src/presets/presetPermission.js";
import { slugLookupPreset } from "../../src/presets/slugLookup.js";
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

describe("slugLookup preset", () => {
  describe("Preset configuration", () => {
    it("should return correct preset name", () => {
      const result = slugLookupPreset();
      expect(result.name).toBe("slugLookup");
    });

    it("should add GET /slug/:slug route with default slug field", async () => {
      const routes = getPresetRoutes(slugLookupPreset(), { get: allowPublic() });
      const slugRoute = routes.find((r) => r.path.includes("/slug/"));
      expect(slugRoute).toBeDefined();
      expect(slugRoute?.method).toBe("GET");
      expect(slugRoute?.path).toBe("/slug/:slug");
      await expectCallsController(
        (c) => getPresetRoutes(slugLookupPreset(), {}, c).find((r) => r.path.includes("/slug/")),
        "getBySlug",
      );
    });

    it("should use get permission for slug route", () => {
      const getPermission = requireRoles(["user", "admin"]);
      const routes = getPresetRoutes(slugLookupPreset(), { get: getPermission });
      const slugRoute = routes.find((r) => r.path.includes("/slug/"));
      expect(slugRoute?.permissions).toBe(getPermission);
    });

    it("marks the route unresolved (never public) when get permission is not defined", () => {
      const routes = getPresetRoutes(slugLookupPreset(), {});
      const slugRoute = routes.find((r) => r.path.includes("/slug/"));
      expect(unresolvedPresetPermission(slugRoute?.permissions)).toEqual({
        preset: "slugLookup",
        inherits: "get",
      });
      expect(slugRoute?.permissions._isPublic).toBeUndefined();
    });

    it("should provide controllerOptions with slugField", () => {
      const result = slugLookupPreset();
      expect(result.controllerOptions).toBeDefined();
      expect(result.controllerOptions?.slugField).toBe("slug");
    });
  });

  describe("Custom slug field", () => {
    it("should support custom slug field name", () => {
      const routes = getPresetRoutes(slugLookupPreset({ slugField: "permalink" }), {
        get: allowPublic(),
      });
      const slugRoute = routes.find((r) => r.path.includes("/slug/"));
      expect(slugRoute?.path).toBe("/slug/:permalink");
    });

    it("should pass custom slugField to controller options", () => {
      const result = slugLookupPreset({ slugField: "permalink" });
      expect(result.controllerOptions?.slugField).toBe("permalink");
    });
  });

  describe("Preset application", () => {
    it("should apply preset to resource config", () => {
      const baseConfig: ResourceConfig = {
        name: "article",
        permissions: { get: allowPublic() },
        presets: ["slugLookup"],
      };

      const result = applyPresets(baseConfig, ["slugLookup"]);

      expect(result.routes).toBeDefined();
      const routePaths = result.routes?.map((r) => r.path);
      expect(routePaths.some((p) => p.includes("/slug/"))).toBe(true);
    });

    it("should merge controller options", () => {
      const baseConfig: ResourceConfig = {
        name: "article",
        permissions: { get: allowPublic() },
        presets: [{ name: "slugLookup", slugField: "handle" }],
      };

      const result = applyPresets(baseConfig, [{ name: "slugLookup", slugField: "handle" }]);

      expect(result._controllerOptions?.slugField).toBe("handle");
    });
  });
});
