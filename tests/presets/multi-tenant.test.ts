/**
 * Multi-Tenant Preset Tests
 *
 * Tests the multi-tenant preset configuration including:
 * - Middleware addition for all CRUD operations
 * - Tenant field configuration
 * - Bypass roles configuration
 */

import { describe, expect, it } from "vitest";
import { applyPresets } from "../../src/presets/index.js";
import { multiTenantPreset } from "../../src/presets/multiTenant.js";
import type { ResourceConfig } from "../../src/types/index.js";

describe("multiTenant preset", () => {
  describe("Preset configuration", () => {
    it("should return correct preset name", () => {
      const result = multiTenantPreset();
      expect(result.name).toBe("multiTenant");
    });

    it("should add middleware for list operation (filter)", () => {
      const result = multiTenantPreset();
      expect(result.middlewares).toBeDefined();
      expect(result.middlewares?.list).toBeDefined();
      expect(result.middlewares?.list?.length).toBeGreaterThan(0);
    });

    it("should add middleware for get operation (filter)", () => {
      const result = multiTenantPreset();
      expect(result.middlewares?.get).toBeDefined();
      expect(result.middlewares?.get?.length).toBeGreaterThan(0);
    });

    it("should add middleware for create operation (injection)", () => {
      const result = multiTenantPreset();
      expect(result.middlewares?.create).toBeDefined();
      expect(result.middlewares?.create?.length).toBeGreaterThan(0);
    });

    it("should add middleware for update operation (filter)", () => {
      const result = multiTenantPreset();
      expect(result.middlewares?.update).toBeDefined();
      expect(result.middlewares?.update?.length).toBeGreaterThan(0);
    });

    it("should add middleware for delete operation (filter)", () => {
      const result = multiTenantPreset();
      expect(result.middlewares?.delete).toBeDefined();
      expect(result.middlewares?.delete?.length).toBeGreaterThan(0);
    });
  });

  describe("Custom options", () => {
    it("should support custom tenant field name", () => {
      const result = multiTenantPreset({ tenantField: "companyId" });
      // Middleware is created with custom tenantField internally
      expect(result.middlewares?.list).toBeDefined();
    });

    it("should support custom bypass roles", () => {
      const result = multiTenantPreset({ bypassRoles: ["globalAdmin"] });
      // Middleware is created with custom bypassRoles internally
      expect(result.middlewares?.list).toBeDefined();
    });
  });

  describe("Preset application", () => {
    it("should apply preset to resource config", () => {
      const baseConfig: ResourceConfig = {
        name: "invoice",
        permissions: { list: ["member"], create: ["admin"] },
        presets: ["multiTenant"],
      };

      const result = applyPresets(baseConfig, ["multiTenant"]);

      // Should have middlewares added for all operations
      expect(result.middlewares).toBeDefined();
      expect(result.middlewares?.list).toBeDefined();
      expect(result.middlewares?.get).toBeDefined();
      expect(result.middlewares?.create).toBeDefined();
      expect(result.middlewares?.update).toBeDefined();
      expect(result.middlewares?.delete).toBeDefined();
    });

    it("should merge with existing middlewares", () => {
      const existingMiddleware = async () => {};
      const baseConfig: ResourceConfig = {
        name: "invoice",
        permissions: {},
        middlewares: {
          list: [existingMiddleware],
        },
        presets: ["multiTenant"],
      };

      const result = applyPresets(baseConfig, ["multiTenant"]);

      // Should have both existing and preset middlewares
      expect(result.middlewares?.list).toBeDefined();
      // Existing middleware should be preserved
      expect(result.middlewares?.list?.length).toBeGreaterThan(1);
    });

    it("should apply with custom options", () => {
      const baseConfig: ResourceConfig = {
        name: "project",
        permissions: {},
        presets: [{ name: "multiTenant", tenantField: "workspaceId", bypassRoles: ["superuser"] }],
      };

      const result = applyPresets(baseConfig, [
        { name: "multiTenant", tenantField: "workspaceId", bypassRoles: ["superuser"] },
      ]);

      expect(result.middlewares?.list).toBeDefined();
      expect(result.middlewares?.create).toBeDefined();
    });
  });
});
