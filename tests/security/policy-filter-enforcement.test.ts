/**
 * Security Tests: Policy Filter Enforcement
 *
 * Tests that policy filters are enforced on ALL CRUD operations,
 * not just list(). Critical for multi-tenant isolation and ownership.
 *
 * CRITICAL: Prevents cross-tenant data access.
 *
 * NOTE: Policy filters are set by permission middleware via req.metadata._policyFilters
 * (NOT req.query._policyFilters which can be user-supplied and is stripped out)
 */

import { ObjectId } from "mongodb";
import { beforeEach, describe, expect, it } from "vitest";
import { BaseController } from "../../src/core/BaseController.js";
import type { StandardRepo } from "@classytic/repo-core/repository";
import type { AnyRecord, IRequestContext } from "../../src/types/index.js";

/**
 * Helper to create context with policy filters in the correct location
 * Policy filters are set by permission middleware, not query params
 */
function createContextWithPolicyFilters(
  base: Omit<IRequestContext, "metadata">,
  policyFilters?: AnyRecord,
  arcContext?: AnyRecord,
): IRequestContext {
  return {
    ...base,
    metadata: {
      ...arcContext,
      _policyFilters: policyFilters,
    },
  };
}

// Mock repository
class MockRepository implements StandardRepo {
  private items: Map<string, AnyRecord> = new Map();

  constructor(initialData: AnyRecord[] = []) {
    initialData.forEach((item) => {
      this.items.set(item._id, item);
    });
  }

  async getAll() {
    return Array.from(this.items.values());
  }

  async getById(id: string) {
    return this.items.get(id) || null;
  }

  async create(data: AnyRecord) {
    const item = { ...data, _id: `${Date.now()}` };
    this.items.set(item._id, item);
    return item;
  }

  async update(id: string, data: AnyRecord) {
    const existing = this.items.get(id);
    if (!existing) return null;
    const updated = { ...existing, ...data };
    this.items.set(id, updated);
    return updated;
  }

  async delete(id: string) {
    const exists = this.items.has(id);
    if (!exists) return false;
    this.items.delete(id);
    return true;
  }
}

describe("Security: Policy Filter Enforcement", () => {
  let repo: MockRepository;
  let controller: BaseController;

  beforeEach(() => {
    // Setup: 3 items across 2 tenants
    repo = new MockRepository([
      { _id: "1", name: "Item 1", tenantId: "tenant-a", ownerId: "user-1" },
      { _id: "2", name: "Item 2", tenantId: "tenant-a", ownerId: "user-2" },
      { _id: "3", name: "Item 3", tenantId: "tenant-b", ownerId: "user-3" },
    ]);

    controller = new BaseController(repo);
  });

  describe("get() operation", () => {
    it("should enforce policy filters - return 404 if policy mismatch", async () => {
      // Policy filters set via context.context._policyFilters (as permission middleware does)
      const context = createContextWithPolicyFilters(
        {
          params: { id: "3" }, // tenant-b item
          query: {},
          body: {},
          user: { id: "user-1" },
          headers: {},
        },
        { tenantId: "tenant-a" }, // tenant-a policy
      );

      const result = await controller.get(context);

      expect(result.success).toBe(false);
      expect(result.status).toBe(404); // Should not leak existence
      expect(result.error).toBe("Resource not found");
    });

    it("should allow get when policy filters match", async () => {
      const context = createContextWithPolicyFilters(
        {
          params: { id: "1" }, // tenant-a item
          query: {},
          body: {},
          user: { id: "user-1" },
          headers: {},
        },
        { tenantId: "tenant-a" }, // tenant-a policy
      );

      const result = await controller.get(context);

      expect(result.success).toBe(true);
      expect(result.status).toBe(200);
      expect((result.data as AnyRecord).name).toBe("Item 1");
    });

    it("should allow get when no policy filters", async () => {
      const context: IRequestContext = {
        params: { id: "3" },
        query: {},
        body: {},
        user: { id: "user-1" },
        headers: {},
      };

      const result = await controller.get(context);

      expect(result.success).toBe(true);
      expect(result.status).toBe(200);
    });

    it("should IGNORE policy filters in query params (security: prevent injection)", async () => {
      // Attacker tries to inject policy filters via query string - should be ignored
      const context: IRequestContext = {
        params: { id: "3" }, // tenant-b item
        query: {
          _policyFilters: { tenantId: "tenant-a" }, // INJECTED - should be ignored
        },
        body: {},
        user: { id: "user-1" },
        headers: {},
        // No context._policyFilters = no enforcement
      };

      const result = await controller.get(context);

      // Should succeed because query._policyFilters is not trusted
      expect(result.success).toBe(true);
      expect(result.status).toBe(200);
    });

    it("should match $in filters by value for ObjectId-like values", async () => {
      const jobIdA = new ObjectId();
      const repoWithObjectId = new MockRepository([
        {
          _id: "oid-1",
          name: "Interview 1",
          // Simulate Mongo document value type
          jobId: jobIdA,
        },
      ]);
      const ctrl = new BaseController(repoWithObjectId);

      const context = createContextWithPolicyFilters(
        {
          params: { id: "oid-1" },
          query: {},
          body: {},
          user: { id: "u-1" },
          headers: {},
        },
        {
          // Different ObjectId instance, same value string
          jobId: { $in: [new ObjectId(jobIdA.toHexString())] },
        },
      );

      const result = await ctrl.get(context);
      expect(result.success).toBe(true);
      expect(result.status).toBe(200);
      expect((result.data as AnyRecord).name).toBe("Interview 1");
    });
  });

  describe("update() operation", () => {
    it("should enforce policy filters - return 404 if policy mismatch", async () => {
      const context = createContextWithPolicyFilters(
        {
          params: { id: "3" }, // tenant-b item
          query: {},
          body: { name: "Updated" },
          user: { id: "user-1" },
          headers: {},
        },
        { tenantId: "tenant-a" }, // tenant-a policy
      );

      const result = await controller.update(context);

      expect(result.success).toBe(false);
      expect(result.status).toBe(404); // Should not leak existence
      expect(result.error).toBe("Resource not found");

      // Verify item was NOT updated
      const item = await repo.getById("3");
      expect(item?.name).toBe("Item 3"); // Original name
    });

    it("should allow update when policy filters match", async () => {
      const context = createContextWithPolicyFilters(
        {
          params: { id: "1" },
          query: {},
          body: { name: "Updated Item 1" },
          user: { id: "user-1" },
          headers: {},
        },
        { tenantId: "tenant-a" },
      );

      const result = await controller.update(context);

      expect(result.success).toBe(true);
      expect(result.status).toBe(200);
      expect((result.data as AnyRecord).name).toBe("Updated Item 1");
    });

    it("should enforce multiple policy filters", async () => {
      const context = createContextWithPolicyFilters(
        {
          params: { id: "1" },
          query: {},
          body: { name: "Hacked" },
          user: { id: "user-1" },
          headers: {},
        },
        {
          tenantId: "tenant-a",
          ownerId: "user-2", // Wrong owner
        },
      );

      const result = await controller.update(context);

      expect(result.success).toBe(false);
      expect(result.status).toBe(404); // Policy mismatch
    });
  });

  describe("delete() operation", () => {
    it("should enforce policy filters - return 404 if policy mismatch", async () => {
      const context = createContextWithPolicyFilters(
        {
          params: { id: "3" }, // tenant-b item
          query: {},
          body: {},
          user: { id: "user-1" },
          headers: {},
        },
        { tenantId: "tenant-a" }, // tenant-a policy
      );

      const result = await controller.delete(context);

      expect(result.success).toBe(false);
      expect(result.status).toBe(404); // Should not leak existence

      // Verify item was NOT deleted
      const item = await repo.getById("3");
      expect(item).not.toBeNull();
    });

    it("should allow delete when policy filters match", async () => {
      const context = createContextWithPolicyFilters(
        {
          params: { id: "1" },
          query: {},
          body: {},
          user: { id: "user-1" },
          headers: {},
        },
        { tenantId: "tenant-a" },
      );

      const result = await controller.delete(context);

      expect(result.success).toBe(true);
      expect(result.status).toBe(200);

      // Verify item was deleted
      const item = await repo.getById("1");
      expect(item).toBeNull();
    });

    it("should block cross-tenant deletion", async () => {
      const context = createContextWithPolicyFilters(
        {
          params: { id: "3" }, // tenant-b item
          query: {},
          body: {},
          user: { id: "user-1" },
          headers: {},
        },
        { tenantId: "tenant-a" }, // tenant-a user trying to delete
      );

      const result = await controller.delete(context);

      expect(result.success).toBe(false);
      expect(result.status).toBe(404);

      // Verify ALL tenant-b items still exist
      const item = await repo.getById("3");
      expect(item).not.toBeNull();
      expect(item?.tenantId).toBe("tenant-b");
    });
  });

  describe("org scope + policy filters combined", () => {
    it("should enforce both org scope AND policy filters", async () => {
      const context = createContextWithPolicyFilters(
        {
          params: { id: "1" },
          query: {},
          body: {},
          user: { id: "user-1" },
          headers: {},
        },
        { ownerId: "user-2" }, // Wrong owner
        { organizationId: "org-xyz" }, // Org scope in context
      );

      const result = await controller.get(context);

      // Should fail because item doesn't have organizationId matching org-xyz
      expect(result.success).toBe(false);
      expect(result.status).toBe(404);
    });
  });

  describe("Policy filter edge cases", () => {
    it("should handle null policy filters", async () => {
      const context = createContextWithPolicyFilters(
        {
          params: { id: "1" },
          query: {},
          body: {},
          user: { id: "user-1" },
          headers: {},
        },
        null as any,
      );

      const result = await controller.get(context);

      expect(result.success).toBe(true);
    });

    it("should handle undefined policy filters", async () => {
      const context: IRequestContext = {
        params: { id: "1" },
        query: {},
        body: {},
        user: { id: "user-1" },
        headers: {},
      };

      const result = await controller.get(context);

      expect(result.success).toBe(true);
    });

    it("should handle empty object policy filters", async () => {
      const context = createContextWithPolicyFilters(
        {
          params: { id: "1" },
          query: {},
          body: {},
          user: { id: "user-1" },
          headers: {},
        },
        {},
      );

      const result = await controller.get(context);

      expect(result.success).toBe(true);
    });
  });
});
