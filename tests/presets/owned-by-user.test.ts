/**
 * Owned By User Preset Tests
 *
 * Tests the owned-by-user preset configuration including:
 * - Middleware addition (update, delete)
 * - Owner field configuration
 * - Fail-closed middleware (no user / no id / missingOwner)
 */

import type { FastifyReply } from "fastify";
import { describe, expect, it } from "vitest";
import { applyPresets } from "../../src/presets/index.js";
import { ownedByUserPreset } from "../../src/presets/ownedByUser.js";
import type { RequestWithExtras, ResourceConfig } from "../../src/types/index.js";
import { UnauthorizedError } from "../../src/utils/errors.js";

/** Pull the ownership middleware the preset installs on `update`. */
function ownershipMiddleware(opts?: Parameters<typeof ownedByUserPreset>[0]) {
  const mw = ownedByUserPreset(opts).middlewares?.update;
  if (!mw?.length) throw new Error("no update middleware");
  return mw[mw.length - 1] as (req: RequestWithExtras, reply: FastifyReply) => Promise<void>;
}

const noReply = {} as FastifyReply;

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

    it("injects a requireAuth() permission for update/delete (authorization in the permission model)", () => {
      const result = ownedByUserPreset();
      const update = result.permissions?.update as { _isPublic?: boolean } | undefined;
      expect(typeof update).toBe("function");
      expect(typeof result.permissions?.delete).toBe("function");
      // requireAuth marks _isPublic false / no roles — an authenticated gate.
      expect(update?._isPublic).not.toBe(true);
    });
  });

  describe("Fail-closed middleware", () => {
    it("DENIES (throws Unauthorized) when there is no authenticated user", async () => {
      const mw = ownershipMiddleware();
      const req = {} as RequestWithExtras;
      await expect(mw(req, noReply)).rejects.toBeInstanceOf(UnauthorizedError);
    });

    it("DENIES when the authenticated identity has no usable id", async () => {
      const mw = ownershipMiddleware();
      const req = { user: { name: "no-id" } } as unknown as RequestWithExtras;
      await expect(mw(req, noReply)).rejects.toBeInstanceOf(UnauthorizedError);
    });

    it("installs the ownership check (with default missingOwner:'deny') for a valid user", async () => {
      const mw = ownershipMiddleware({ ownerField: "authorId" });
      const req = { user: { _id: "u1" } } as unknown as RequestWithExtras;
      await mw(req, noReply);
      expect(req._ownershipCheck).toEqual({
        field: "authorId",
        userId: "u1",
        missingOwner: "deny",
      });
    });

    it("threads missingOwner:'allow' through to the controller check", async () => {
      const mw = ownershipMiddleware({ missingOwner: "allow" });
      const req = { user: { id: "u2" } } as unknown as RequestWithExtras;
      await mw(req, noReply);
      expect(req._ownershipCheck).toMatchObject({ missingOwner: "allow", userId: "u2" });
    });
  });

  describe("Custom options", () => {
    it("should support custom owner field name", () => {
      const result = ownedByUserPreset({ ownerField: "authorId" });
      // Middleware is created with custom ownerField internally
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
        presets: [{ name: "ownedByUser", ownerField: "writtenBy" }],
      };

      const result = applyPresets(baseConfig, [{ name: "ownedByUser", ownerField: "writtenBy" }]);

      expect(result.middlewares?.update).toBeDefined();
    });
  });
});
