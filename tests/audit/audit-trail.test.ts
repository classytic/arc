/**
 * Audit Trail Tests
 *
 * Comprehensive tests for audit entry creation, change detection,
 * memory store, and query interface.
 */

import { describe, expect, it } from "vitest";

describe("Audit Trail", () => {
  // ==========================================================================
  // createAuditEntry
  // ==========================================================================

  describe("createAuditEntry", () => {
    it("should create entry with before/after snapshots", async () => {
      const { createAuditEntry } = await import("../../src/audit/stores/interface.js");

      const entry = createAuditEntry(
        "product",
        "prod-1",
        "update",
        {
          user: { _id: "u1" },
          organizationId: "org-1",
          requestId: "req-1",
          ipAddress: "1.2.3.4",
        },
        {
          before: { name: "Old Name", price: 10 },
          after: { name: "New Name", price: 10 },
        },
      );

      expect(entry.resource).toBe("product");
      expect(entry.documentId).toBe("prod-1");
      expect(entry.action).toBe("update");
      expect(entry.userId).toBe("u1");
      expect(entry.organizationId).toBe("org-1");
      expect(entry.before).toEqual({ name: "Old Name", price: 10 });
      expect(entry.after).toEqual({ name: "New Name", price: 10 });
      expect(entry.changes).toEqual(["name"]); // price unchanged
      expect(entry.id).toMatch(/^aud_/);
      expect(entry.timestamp).toBeInstanceOf(Date);
    });

    it("should detect multiple changed fields", async () => {
      const { createAuditEntry } = await import("../../src/audit/stores/interface.js");

      const entry = createAuditEntry(
        "product",
        "prod-1",
        "update",
        { user: { _id: "u1" } },
        {
          before: { name: "A", price: 10, status: "draft" },
          after: { name: "B", price: 20, status: "draft" },
        },
      );

      expect(entry.changes).toContain("name");
      expect(entry.changes).toContain("price");
      expect(entry.changes).not.toContain("status");
    });

    it("should handle create action (no before)", async () => {
      const { createAuditEntry } = await import("../../src/audit/stores/interface.js");

      const entry = createAuditEntry(
        "product",
        "prod-1",
        "create",
        { user: { _id: "u1" } },
        {
          after: { name: "New", price: 10 },
        },
      );

      expect(entry.action).toBe("create");
      expect(entry.before).toBeUndefined();
      expect(entry.after).toEqual({ name: "New", price: 10 });
    });

    it("should handle delete action (no after)", async () => {
      const { createAuditEntry } = await import("../../src/audit/stores/interface.js");

      const entry = createAuditEntry(
        "product",
        "prod-1",
        "delete",
        { user: { _id: "u1" } },
        {
          before: { name: "Deleted", price: 10 },
        },
      );

      expect(entry.action).toBe("delete");
      expect(entry.before).toBeDefined();
      expect(entry.after).toBeUndefined();
    });

    it("should include custom metadata", async () => {
      const { createAuditEntry } = await import("../../src/audit/stores/interface.js");

      const entry = createAuditEntry(
        "product",
        "prod-1",
        "update",
        { user: { _id: "u1" } },
        {
          metadata: { reason: "price correction", approvedBy: "admin" },
        },
      );

      expect(entry.metadata).toEqual({ reason: "price correction", approvedBy: "admin" });
    });
  });

  // ==========================================================================
  // MemoryAuditStore
  // ==========================================================================

  describe("MemoryAuditStore", () => {
    it("should store and query audit entries", async () => {
      const { MemoryAuditStore, createAuditEntry } = await import(
        "../../src/audit/stores/index.js"
      );

      const store = new MemoryAuditStore();

      const entry = createAuditEntry("product", "prod-1", "create", {
        user: { _id: "u1" },
        organizationId: "org-1",
      });

      await store.log(entry);

      const results = await store.query?.({ resource: "product" });
      expect(results).toHaveLength(1);
      expect(results[0].documentId).toBe("prod-1");
    });

    it("should filter by documentId", async () => {
      const { MemoryAuditStore, createAuditEntry } = await import(
        "../../src/audit/stores/index.js"
      );

      const store = new MemoryAuditStore();

      await store.log(createAuditEntry("product", "prod-1", "create", { user: { _id: "u1" } }));
      await store.log(createAuditEntry("product", "prod-2", "create", { user: { _id: "u1" } }));

      const results = await store.query?.({ documentId: "prod-1" });
      expect(results).toHaveLength(1);
    });

    it("should filter by userId", async () => {
      const { MemoryAuditStore, createAuditEntry } = await import(
        "../../src/audit/stores/index.js"
      );

      const store = new MemoryAuditStore();

      await store.log(createAuditEntry("product", "prod-1", "create", { user: { _id: "u1" } }));
      await store.log(createAuditEntry("product", "prod-2", "create", { user: { _id: "u2" } }));

      const results = await store.query?.({ userId: "u2" });
      expect(results).toHaveLength(1);
    });

    it("should filter by action", async () => {
      const { MemoryAuditStore, createAuditEntry } = await import(
        "../../src/audit/stores/index.js"
      );

      const store = new MemoryAuditStore();

      await store.log(createAuditEntry("product", "prod-1", "create", { user: { _id: "u1" } }));
      await store.log(createAuditEntry("product", "prod-1", "update", { user: { _id: "u1" } }));
      await store.log(createAuditEntry("product", "prod-1", "delete", { user: { _id: "u1" } }));

      const results = await store.query?.({ action: "update" });
      expect(results).toHaveLength(1);
    });

    it("should respect limit", async () => {
      const { MemoryAuditStore, createAuditEntry } = await import(
        "../../src/audit/stores/index.js"
      );

      const store = new MemoryAuditStore();

      for (let i = 0; i < 10; i++) {
        await store.log(
          createAuditEntry("product", `prod-${i}`, "create", { user: { _id: "u1" } }),
        );
      }

      const results = await store.query?.({ limit: 3 });
      expect(results).toHaveLength(3);
    });

    it("should filter by organizationId", async () => {
      const { MemoryAuditStore, createAuditEntry } = await import(
        "../../src/audit/stores/index.js"
      );

      const store = new MemoryAuditStore();

      await store.log(
        createAuditEntry("product", "p1", "create", {
          user: { _id: "u1" },
          organizationId: "org-a",
        }),
      );
      await store.log(
        createAuditEntry("product", "p2", "create", {
          user: { _id: "u1" },
          organizationId: "org-b",
        }),
      );

      const results = await store.query?.({ organizationId: "org-a" });
      expect(results).toHaveLength(1);
      expect(results[0].organizationId).toBe("org-a");
    });

    it("should filter by date range (from/to)", async () => {
      const { MemoryAuditStore } = await import("../../src/audit/stores/index.js");
      const { createAuditEntry } = await import("../../src/audit/stores/interface.js");

      const store = new MemoryAuditStore();

      const old = createAuditEntry("product", "p1", "create", { user: { _id: "u1" } });
      old.timestamp = new Date("2025-01-01");
      await store.log(old);

      const recent = createAuditEntry("product", "p2", "create", { user: { _id: "u1" } });
      recent.timestamp = new Date("2025-06-15");
      await store.log(recent);

      const now = createAuditEntry("product", "p3", "create", { user: { _id: "u1" } });
      now.timestamp = new Date("2025-12-01");
      await store.log(now);

      const results = await store.query?.({
        from: new Date("2025-03-01"),
        to: new Date("2025-09-01"),
      });
      expect(results).toHaveLength(1);
      expect(results[0].documentId).toBe("p2");
    });

    it("should filter by multiple actions (array)", async () => {
      const { MemoryAuditStore, createAuditEntry } = await import(
        "../../src/audit/stores/index.js"
      );

      const store = new MemoryAuditStore();

      await store.log(createAuditEntry("product", "p1", "create", { user: { _id: "u1" } }));
      await store.log(createAuditEntry("product", "p2", "update", { user: { _id: "u1" } }));
      await store.log(createAuditEntry("product", "p3", "delete", { user: { _id: "u1" } }));

      const results = await store.query?.({ action: ["create", "delete"] });
      expect(results).toHaveLength(2);
      expect(results.map((r) => r.action).sort()).toEqual(["create", "delete"]);
    });

    it("should support combined filters", async () => {
      const { MemoryAuditStore, createAuditEntry } = await import(
        "../../src/audit/stores/index.js"
      );

      const store = new MemoryAuditStore();

      await store.log(
        createAuditEntry("product", "p1", "create", {
          user: { _id: "u1" },
          organizationId: "org-a",
        }),
      );
      await store.log(
        createAuditEntry("product", "p2", "update", {
          user: { _id: "u1" },
          organizationId: "org-a",
        }),
      );
      await store.log(
        createAuditEntry("order", "o1", "create", { user: { _id: "u2" }, organizationId: "org-a" }),
      );

      const results = await store.query?.({ resource: "product", userId: "u1", action: "create" });
      expect(results).toHaveLength(1);
      expect(results[0].documentId).toBe("p1");
    });

    it("should support offset pagination", async () => {
      const { MemoryAuditStore, createAuditEntry } = await import(
        "../../src/audit/stores/index.js"
      );

      const store = new MemoryAuditStore();

      for (let i = 0; i < 5; i++) {
        await store.log(createAuditEntry("product", `p${i}`, "create", { user: { _id: "u1" } }));
      }

      const page1 = await store.query?.({ limit: 2, offset: 0 });
      const page2 = await store.query?.({ limit: 2, offset: 2 });
      const page3 = await store.query?.({ limit: 2, offset: 4 });

      expect(page1).toHaveLength(2);
      expect(page2).toHaveLength(2);
      expect(page3).toHaveLength(1);
    });

    it("should cap at maxEntries", async () => {
      const { MemoryAuditStore, createAuditEntry } = await import(
        "../../src/audit/stores/index.js"
      );

      const store = new MemoryAuditStore({ maxEntries: 3 });

      for (let i = 0; i < 5; i++) {
        await store.log(createAuditEntry("product", `p${i}`, "create", { user: { _id: "u1" } }));
      }

      const results = await store.query?.({});
      expect(results).toHaveLength(3);
    });

    it("should clear all entries on close()", async () => {
      const { MemoryAuditStore, createAuditEntry } = await import(
        "../../src/audit/stores/index.js"
      );

      const store = new MemoryAuditStore();
      await store.log(createAuditEntry("product", "p1", "create", { user: { _id: "u1" } }));
      await store.close?.();

      const results = await store.query?.({});
      expect(results).toHaveLength(0);
    });
  });

  // ==========================================================================
  // User ID extraction (DB-agnostic)
  // ==========================================================================

  describe("userId extraction", () => {
    it("should extract string _id", async () => {
      const { createAuditEntry } = await import("../../src/audit/stores/interface.js");
      const entry = createAuditEntry("r", "1", "create", { user: { _id: "user-123" } });
      expect(entry.userId).toBe("user-123");
    });

    it("should extract string id (no _id)", async () => {
      const { createAuditEntry } = await import("../../src/audit/stores/interface.js");
      const entry = createAuditEntry("r", "1", "create", { user: { id: "user-456" } });
      expect(entry.userId).toBe("user-456");
    });

    it("should handle ObjectId-like objects via String()", async () => {
      const { createAuditEntry } = await import("../../src/audit/stores/interface.js");
      const objectId = { toString: () => "507f1f77bcf86cd799439011" };
      const entry = createAuditEntry("r", "1", "create", {
        user: { _id: objectId as unknown as string },
      });
      expect(entry.userId).toBe("507f1f77bcf86cd799439011");
    });

    it("should handle numeric id", async () => {
      const { createAuditEntry } = await import("../../src/audit/stores/interface.js");
      const entry = createAuditEntry("r", "1", "create", { user: { id: 42 as unknown as string } });
      expect(entry.userId).toBe("42");
    });

    it("should return undefined when no user", async () => {
      const { createAuditEntry } = await import("../../src/audit/stores/interface.js");
      const entry = createAuditEntry("r", "1", "create", {});
      expect(entry.userId).toBeUndefined();
    });

    it("should prefer _id over id", async () => {
      const { createAuditEntry } = await import("../../src/audit/stores/interface.js");
      const entry = createAuditEntry("r", "1", "create", {
        user: { _id: "from-id", id: "from-fallback" },
      });
      expect(entry.userId).toBe("from-id");
    });
  });

  // ==========================================================================
  // Change detection edge cases
  // ==========================================================================

  describe("change detection", () => {
    it("should skip internal fields starting with _", async () => {
      const { createAuditEntry } = await import("../../src/audit/stores/interface.js");
      const entry = createAuditEntry(
        "r",
        "1",
        "update",
        { user: { _id: "u1" } },
        {
          before: { name: "A", _version: 1, __v: 0 },
          after: { name: "A", _version: 2, __v: 1 },
        },
      );
      expect(entry.changes).toEqual([]);
    });

    it("should skip updatedAt field", async () => {
      const { createAuditEntry } = await import("../../src/audit/stores/interface.js");
      const entry = createAuditEntry(
        "r",
        "1",
        "update",
        { user: { _id: "u1" } },
        {
          before: { name: "A", updatedAt: "2025-01-01" },
          after: { name: "A", updatedAt: "2025-06-01" },
        },
      );
      expect(entry.changes).toEqual([]);
    });

    it("should detect new fields added", async () => {
      const { createAuditEntry } = await import("../../src/audit/stores/interface.js");
      const entry = createAuditEntry(
        "r",
        "1",
        "update",
        { user: { _id: "u1" } },
        {
          before: { name: "A" },
          after: { name: "A", category: "books" },
        },
      );
      expect(entry.changes).toEqual(["category"]);
    });

    it("should detect removed fields", async () => {
      const { createAuditEntry } = await import("../../src/audit/stores/interface.js");
      const entry = createAuditEntry(
        "r",
        "1",
        "update",
        { user: { _id: "u1" } },
        {
          before: { name: "A", category: "books" },
          after: { name: "A" },
        },
      );
      expect(entry.changes).toEqual(["category"]);
    });

    it("should return undefined when no before state", async () => {
      const { createAuditEntry } = await import("../../src/audit/stores/interface.js");
      const entry = createAuditEntry(
        "r",
        "1",
        "create",
        { user: { _id: "u1" } },
        {
          after: { name: "New" },
        },
      );
      expect(entry.changes).toBeUndefined();
    });
  });
});
