/**
 * Bulk Preset — Full Integration Suite
 *
 * Tests: preset route generation, BaseController bulk methods,
 * input validation (400), missing repo methods (501), permission
 * inheritance, and DB-agnostic repository contract.
 */

import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

// ============================================================================
// Helpers
// ============================================================================

/** Minimal mock repo — DB-agnostic, no MongoDB types */
function createMockRepo(overrides: Record<string, unknown> = {}) {
  return {
    getAll: vi
      .fn()
      .mockResolvedValue({ docs: [], total: 0, page: 1, pages: 0, hasNext: false, hasPrev: false }),
    getById: vi.fn().mockResolvedValue(null),
    create: vi.fn().mockResolvedValue({ _id: "new" }),
    update: vi.fn().mockResolvedValue({ _id: "updated" }),
    delete: vi.fn().mockResolvedValue({ success: true }),
    ...overrides,
  };
}

let _HookSystem: new () => unknown;

async function loadHookSystem() {
  if (!_HookSystem) {
    const mod = await import("../../src/hooks/HookSystem.js");
    _HookSystem = mod.HookSystem;
  }
  return _HookSystem;
}

async function createReqCtx(body: unknown) {
  const HookSystem = await loadHookSystem();
  return {
    params: {},
    query: {},
    body,
    headers: {},
    metadata: { arc: { hooks: new HookSystem() } },
  };
}

describe("Bulk Preset", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    if (app) await app.close().catch(() => {});
    vi.restoreAllMocks();
  });

  // ==========================================================================
  // Preset route generation
  // ==========================================================================

  describe("route generation", () => {
    it("generates additionalRoutes as function that receives resource permissions", async () => {
      const { bulkPreset } = await import("../../src/presets/bulk.js");
      const result = bulkPreset();

      expect(typeof result.additionalRoutes).toBe("function");
    });

    it("POST /bulk inherits create permission", async () => {
      const { bulkPreset } = await import("../../src/presets/bulk.js");
      const createPerm = Object.assign(() => true, { _isPublic: false });

      const routes = (bulkPreset().additionalRoutes as Function)({ create: createPerm });
      const postRoute = routes.find((r: { method: string }) => r.method === "POST");

      expect(postRoute.permissions).toBe(createPerm);
      expect(postRoute.path).toBe("/bulk");
      expect(postRoute.wrapHandler).toBe(true);
      expect(postRoute.handler).toBe("bulkCreate");
    });

    it("PATCH /bulk inherits update permission", async () => {
      const { bulkPreset } = await import("../../src/presets/bulk.js");
      const updatePerm = Object.assign(() => true, { _isPublic: false });

      const routes = (bulkPreset().additionalRoutes as Function)({ update: updatePerm });
      const patchRoute = routes.find((r: { method: string }) => r.method === "PATCH");

      expect(patchRoute.permissions).toBe(updatePerm);
    });

    it("DELETE /bulk inherits delete permission", async () => {
      const { bulkPreset } = await import("../../src/presets/bulk.js");
      const deletePerm = Object.assign(() => true, { _isPublic: false });

      const routes = (bulkPreset().additionalRoutes as Function)({ delete: deletePerm });
      const deleteRoute = routes.find((r: { method: string }) => r.method === "DELETE");

      expect(deleteRoute.permissions).toBe(deletePerm);
    });

    it("falls back to requireAuth when resource has no permission for operation", async () => {
      const { bulkPreset } = await import("../../src/presets/bulk.js");

      const routes = (bulkPreset().additionalRoutes as Function)({});
      // Every route should have a permissions function (not undefined)
      for (const route of routes) {
        expect(typeof route.permissions).toBe("function");
      }
    });

    it("allows selecting specific operations only", async () => {
      const { bulkPreset } = await import("../../src/presets/bulk.js");

      const onlyCreate = (bulkPreset({ operations: ["createMany"] }).additionalRoutes as Function)(
        {},
      );
      expect(onlyCreate).toHaveLength(1);
      expect(onlyCreate[0].method).toBe("POST");

      const onlyDelete = (bulkPreset({ operations: ["deleteMany"] }).additionalRoutes as Function)(
        {},
      );
      expect(onlyDelete).toHaveLength(1);
      expect(onlyDelete[0].method).toBe("DELETE");
    });

    it("includes OpenAPI schema on each route", async () => {
      const { bulkPreset } = await import("../../src/presets/bulk.js");

      const routes = (bulkPreset().additionalRoutes as Function)({});
      for (const route of routes) {
        expect(route.schema).toBeDefined();
        expect(route.schema.body).toBeDefined();
      }
    });
  });

  // ==========================================================================
  // BaseController.bulkCreate
  // ==========================================================================

  describe("BaseController.bulkCreate", () => {
    it("calls repo.createMany and returns 201 with created items", async () => {
      const { BaseController } = await import("../../src/core/BaseController.js");

      const repo = createMockRepo({
        createMany: vi.fn().mockResolvedValue([
          { _id: "1", name: "A", price: 10 },
          { _id: "2", name: "B", price: 20 },
        ]),
      });

      const controller = new BaseController(repo, { resourceName: "product" });
      const result = await controller.bulkCreate(
        await createReqCtx({
          items: [
            { name: "A", price: 10 },
            { name: "B", price: 20 },
          ],
        }),
      );

      expect(result.success).toBe(true);
      expect(result.status).toBe(201);
      expect(result.data).toHaveLength(2);
      expect(result.meta).toEqual({ count: 2 });
      expect(repo.createMany).toHaveBeenCalledWith([
        { name: "A", price: 10 },
        { name: "B", price: 20 },
      ]);
    });

    it("returns 400 when items is empty", async () => {
      const { BaseController } = await import("../../src/core/BaseController.js");
      const repo = createMockRepo({ createMany: vi.fn() });
      const controller = new BaseController(repo, { resourceName: "product" });

      const result = await controller.bulkCreate(await createReqCtx({ items: [] }));

      expect(result.success).toBe(false);
      expect(result.status).toBe(400);
      expect(repo.createMany).not.toHaveBeenCalled();
    });

    it("returns 400 when items is missing", async () => {
      const { BaseController } = await import("../../src/core/BaseController.js");
      const repo = createMockRepo({ createMany: vi.fn() });
      const controller = new BaseController(repo, { resourceName: "product" });

      const result = await controller.bulkCreate(await createReqCtx({}));

      expect(result.success).toBe(false);
      expect(result.status).toBe(400);
    });

    it("returns 501 when repo lacks createMany", async () => {
      const { BaseController } = await import("../../src/core/BaseController.js");
      const repo = createMockRepo(); // no createMany
      const controller = new BaseController(repo, { resourceName: "product" });

      const result = await controller.bulkCreate(await createReqCtx({ items: [{ name: "A" }] }));

      expect(result.success).toBe(false);
      expect(result.status).toBe(501);
    });
  });

  // ==========================================================================
  // BaseController.bulkUpdate
  // ==========================================================================

  describe("BaseController.bulkUpdate", () => {
    it("calls repo.updateMany with filter and data", async () => {
      const { BaseController } = await import("../../src/core/BaseController.js");

      const repo = createMockRepo({
        updateMany: vi.fn().mockResolvedValue({ matchedCount: 5, modifiedCount: 5 }),
      });

      const controller = new BaseController(repo, { resourceName: "product" });
      const result = await controller.bulkUpdate(
        await createReqCtx({
          filter: { status: "draft" },
          data: { $set: { status: "published" } },
        }),
      );

      expect(result.success).toBe(true);
      expect(result.status).toBe(200);
      expect(result.data).toEqual({ matchedCount: 5, modifiedCount: 5 });
      expect(repo.updateMany).toHaveBeenCalledWith(
        { status: "draft" },
        { $set: { status: "published" } },
      );
    });

    it("returns 400 when filter is empty", async () => {
      const { BaseController } = await import("../../src/core/BaseController.js");
      const repo = createMockRepo({ updateMany: vi.fn() });
      const controller = new BaseController(repo, { resourceName: "product" });

      const result = await controller.bulkUpdate(
        await createReqCtx({ filter: {}, data: { name: "x" } }),
      );

      expect(result.success).toBe(false);
      expect(result.status).toBe(400);
      expect(repo.updateMany).not.toHaveBeenCalled();
    });

    it("returns 400 when data is empty", async () => {
      const { BaseController } = await import("../../src/core/BaseController.js");
      const repo = createMockRepo({ updateMany: vi.fn() });
      const controller = new BaseController(repo, { resourceName: "product" });

      const result = await controller.bulkUpdate(
        await createReqCtx({ filter: { active: true }, data: {} }),
      );

      expect(result.success).toBe(false);
      expect(result.status).toBe(400);
    });

    it("returns 501 when repo lacks updateMany", async () => {
      const { BaseController } = await import("../../src/core/BaseController.js");
      const repo = createMockRepo();
      const controller = new BaseController(repo, { resourceName: "product" });

      const result = await controller.bulkUpdate(
        await createReqCtx({ filter: { a: 1 }, data: { b: 2 } }),
      );

      expect(result.success).toBe(false);
      expect(result.status).toBe(501);
    });
  });

  // ==========================================================================
  // BaseController.bulkDelete
  // ==========================================================================

  describe("BaseController.bulkDelete", () => {
    it("calls repo.deleteMany with filter", async () => {
      const { BaseController } = await import("../../src/core/BaseController.js");

      const repo = createMockRepo({
        deleteMany: vi.fn().mockResolvedValue({ deletedCount: 3 }),
      });

      const controller = new BaseController(repo, { resourceName: "product" });
      const result = await controller.bulkDelete(
        await createReqCtx({ filter: { archived: true } }),
      );

      expect(result.success).toBe(true);
      expect(result.status).toBe(200);
      expect(result.data).toEqual({ deletedCount: 3 });
      expect(repo.deleteMany).toHaveBeenCalledWith({ archived: true });
    });

    it("returns 400 when filter is empty", async () => {
      const { BaseController } = await import("../../src/core/BaseController.js");
      const repo = createMockRepo({ deleteMany: vi.fn() });
      const controller = new BaseController(repo, { resourceName: "product" });

      const result = await controller.bulkDelete(await createReqCtx({ filter: {} }));

      expect(result.success).toBe(false);
      expect(result.status).toBe(400);
      expect(repo.deleteMany).not.toHaveBeenCalled();
    });

    it("returns 400 when filter is missing", async () => {
      const { BaseController } = await import("../../src/core/BaseController.js");
      const repo = createMockRepo({ deleteMany: vi.fn() });
      const controller = new BaseController(repo, { resourceName: "product" });

      const result = await controller.bulkDelete(await createReqCtx({}));

      expect(result.success).toBe(false);
      expect(result.status).toBe(400);
    });

    it("returns 501 when repo lacks deleteMany", async () => {
      const { BaseController } = await import("../../src/core/BaseController.js");
      const repo = createMockRepo();
      const controller = new BaseController(repo, { resourceName: "product" });

      const result = await controller.bulkDelete(await createReqCtx({ filter: { old: true } }));

      expect(result.success).toBe(false);
      expect(result.status).toBe(501);
    });
  });

  // ==========================================================================
  // DB-agnostic contract
  // ==========================================================================

  describe("DB-agnostic repository contract", () => {
    it("works with a plain object repository (no class, no Mongoose)", async () => {
      const { BaseController } = await import("../../src/core/BaseController.js");

      // Simulate a Prisma-style or Drizzle-style repo — just plain functions
      const plainRepo = {
        getAll: async () => ({ docs: [], total: 0 }),
        getById: async () => null,
        create: async (d: unknown) => ({ id: "sql-1", ...(d as object) }),
        update: async (_id: string, d: unknown) => ({ id: "sql-1", ...(d as object) }),
        delete: async () => ({ success: true }),
        createMany: async (items: unknown[]) =>
          items.map((item, i) => ({ id: `sql-${i}`, ...(item as object) })),
        updateMany: async () => ({ matchedCount: 2, modifiedCount: 2 }),
        deleteMany: async () => ({ deletedCount: 1 }),
      };

      const controller = new BaseController(plainRepo, { resourceName: "user" });

      const createResult = await controller.bulkCreate(
        await createReqCtx({ items: [{ email: "a@b.com" }] }),
      );
      expect(createResult.success).toBe(true);
      expect(createResult.data).toHaveLength(1);

      const updateResult = await controller.bulkUpdate(
        await createReqCtx({ filter: { role: "guest" }, data: { role: "user" } }),
      );
      expect(updateResult.success).toBe(true);

      const deleteResult = await controller.bulkDelete(
        await createReqCtx({ filter: { deactivated: true } }),
      );
      expect(deleteResult.success).toBe(true);
    });
  });
});
