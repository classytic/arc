/**
 * Slug Lookup Preset Tests
 *
 * Tests the slug lookup preset configuration including:
 * - Route addition (GET /slug/:slug)
 * - Controller options (slugField)
 * - Permission inheritance
 */

import { describe, expect, it } from "vitest";
import { allowPublic, requireRoles } from "../../src/permissions/index.js";
import { applyPresets } from "../../src/presets/index.js";
import { slugLookupPreset } from "../../src/presets/slugLookup.js";
import type { PresetResult, ResourceConfig, ResourcePermissions } from "../../src/types/index.js";

function getPresetRoutes(result: PresetResult, permissions: ResourcePermissions = {}) {
  if (result.routes) {
    return typeof result.routes === "function" ? result.routes(permissions) : result.routes;
  }
  return [];
}

describe("slugLookup preset", () => {
  describe("Preset configuration", () => {
    it("should return correct preset name", () => {
      const result = slugLookupPreset();
      expect(result.name).toBe("slugLookup");
    });

    it("should add GET /slug/:slug route with default slug field", () => {
      const routes = getPresetRoutes(slugLookupPreset(), { get: allowPublic() });
      const slugRoute = routes.find((r) => r.path.includes("/slug/"));
      expect(slugRoute).toBeDefined();
      expect(slugRoute?.method).toBe("GET");
      expect(slugRoute?.path).toBe("/slug/:slug");
      expect(slugRoute?.handler).toBe("getBySlug");
    });

    it("should use get permission for slug route", () => {
      const getPermission = requireRoles(["user", "admin"]);
      const routes = getPresetRoutes(slugLookupPreset(), { get: getPermission });
      const slugRoute = routes.find((r) => r.path.includes("/slug/"));
      expect(slugRoute?.permissions).toBe(getPermission);
    });

    it("should default to allowPublic if get permission not defined", () => {
      const routes = getPresetRoutes(slugLookupPreset(), {});
      const slugRoute = routes.find((r) => r.path.includes("/slug/"));
      expect(slugRoute?.permissions).toBeDefined();
      expect(typeof slugRoute?.permissions).toBe("function");
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
      const routePaths = result.routes!.map((r) => r.path);
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
