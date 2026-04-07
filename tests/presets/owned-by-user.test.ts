/**
 * Owned By User Preset Tests
 *
 * Tests the owned-by-user preset configuration including:
 * - Middleware addition (update, delete)
 * - Owner field configuration
 * - Bypass roles configuration
 */

import { describe, expect, it } from "vitest";
import { applyPresets } from "../../src/presets/index.js";
import { ownedByUserPreset } from "../../src/presets/ownedByUser.js";
import type { ResourceConfig } from "../../src/types/index.js";

describe("ownedByUser preset", () => {
  describe("Preset configuration", () => {
    it("should return correct preset name", () => {
      const result = ownedByUserPreset();
      expect(result.name).toBe("ownedByUser");
    });

    it("should add middleware for update operation", () => {
      const result = ownedByUserPreset();
      expect(result.middlewares).toBeDefined();
      expect(result.middlewares?.update).toBeDefined();
      expect(result.middlewares?.update?.length).toBeGreaterThan(0);
    });

    it("should add middleware for delete operation", () => {
      const result = ownedByUserPreset();
      expect(result.middlewares).toBeDefined();
      expect(result.middlewares?.delete).toBeDefined();
      expect(result.middlewares?.delete?.length).toBeGreaterThan(0);
    });

    it("should not add middleware for list/get/create", () => {
      const result = ownedByUserPreset();
      expect(result.middlewares?.list).toBeUndefined();
      expect(result.middlewares?.get).toBeUndefined();
      expect(result.middlewares?.create).toBeUndefined();
    });
  });

  describe("Custom options", () => {
    it("should support custom owner field name", () => {
      const result = ownedByUserPreset({ ownerField: "authorId" });
      // Middleware is created with custom ownerField internally
      expect(result.middlewares?.update).toBeDefined();
    });

    it("should support custom bypass roles", () => {
      const result = ownedByUserPreset({ bypassRoles: ["superuser", "owner"] });
      // Middleware is created with custom bypassRoles internally
      expect(result.middlewares?.update).toBeDefined();
    });
  });

  describe("Preset application", () => {
    it("should apply preset to resource config", () => {
      const baseConfig: ResourceConfig = {
        name: "post",
        permissions: { update: ["user"], delete: ["user"] },
        presets: ["ownedByUser"],
      };

      const result = applyPresets(baseConfig, ["ownedByUser"]);

      // Should have middlewares added
      expect(result.middlewares).toBeDefined();
      expect(result.middlewares?.update).toBeDefined();
      expect(result.middlewares?.delete).toBeDefined();
    });

    it("should merge with existing middlewares", () => {
      const existingMiddleware = async () => {};
      const baseConfig: ResourceConfig = {
        name: "post",
        permissions: {},
        middlewares: {
          create: [existingMiddleware],
        },
        presets: ["ownedByUser"],
      };

      const result = applyPresets(baseConfig, ["ownedByUser"]);

      // Should have both existing and preset middlewares
      expect(result.middlewares?.create).toBeDefined();
      expect(result.middlewares?.create).toContain(existingMiddleware);
      expect(result.middlewares?.update).toBeDefined();
    });

    it("should apply with custom options", () => {
      const baseConfig: ResourceConfig = {
        name: "comment",
        permissions: {},
        presets: [{ name: "ownedByUser", ownerField: "writtenBy", bypassRoles: ["moderator"] }],
      };

      const result = applyPresets(baseConfig, [
        { name: "ownedByUser", ownerField: "writtenBy", bypassRoles: ["moderator"] },
      ]);

      expect(result.middlewares?.update).toBeDefined();
    });
  });
});
