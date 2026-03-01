/**
 * Configurable idField Tests
 *
 * Verifies that BaseController supports custom primary key field names
 * for non-MongoDB adapters (e.g., SQL databases using 'id' instead of '_id').
 *
 * Scenarios:
 * - Default _id field
 * - Custom idField via constructor options
 * - Custom idField via configure()
 * - accessControl.buildIdFilter uses configured field
 * - Policy filters combine correctly with custom idField
 */

import { describe, it, expect, beforeEach } from "vitest";
import { BaseController } from "../../src/core/BaseController.js";
import type {
  IRequestContext,
  CrudRepository,
  AnyRecord,
} from "../../src/types/index.js";
import type { RequestScope } from "../../src/scope/types.js";

// --------------------------------------------------------------------------
// Mock repository that tracks filter arguments
// --------------------------------------------------------------------------

class FilterTrackingRepository implements CrudRepository {
  public lastGetFilter: AnyRecord | null = null;
  public lastUpdateFilter: AnyRecord | null = null;
  public lastDeleteFilter: AnyRecord | null = null;

  private items: Map<string, AnyRecord> = new Map();

  constructor(initialData: AnyRecord[] = []) {
    initialData.forEach((item) => {
      const key = item._id || item.id;
      this.items.set(key, item);
    });
  }

  async getAll(options?: any) {
    const filter = options?.filter ?? {};
    return {
      docs: Array.from(this.items.values()).filter((item) => {
        return Object.entries(filter).every(([k, v]) => item[k] === v);
      }),
      total: this.items.size,
      page: 1,
      limit: 20,
      pages: 1,
      hasNext: false,
      hasPrev: false,
    };
  }

  async getById(id: string, options?: any) {
    return this.items.get(id) || null;
  }

  async getOne(filter: AnyRecord) {
    this.lastGetFilter = filter;
    const entries = Array.from(this.items.values());
    return (
      entries.find((item) =>
        Object.entries(filter).every(([k, v]) => item[k] === v),
      ) || null
    );
  }

  async create(data: AnyRecord) {
    const id = data._id || data.id || `${Date.now()}`;
    const item = { ...data, _id: id };
    this.items.set(id, item);
    return item;
  }

  async update(id: string, data: AnyRecord, options?: any) {
    this.lastUpdateFilter = options?.filter;
    const existing = this.items.get(id);
    if (!existing) return null;
    const updated = { ...existing, ...data };
    this.items.set(id, updated);
    return updated;
  }

  async delete(id: string, options?: any) {
    this.lastDeleteFilter = options?.filter;
    return this.items.delete(id);
  }
}

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

function createReq(overrides: Partial<IRequestContext> = {}): IRequestContext {
  return {
    query: {},
    body: {},
    params: {},
    user: { _id: "user-1", email: "test@example.com", roles: ["admin"] },
    headers: {},
    metadata: {
      arc: {
        hooks: { executeBefore: async () => {}, executeAfter: async () => {} },
      },
    },
    ...overrides,
  };
}

// --------------------------------------------------------------------------
// Tests
// --------------------------------------------------------------------------

describe("Configurable idField", () => {
  describe("default _id field", () => {
    it("should use _id as default idField", () => {
      const repo = new FilterTrackingRepository();
      const controller = new BaseController(repo as any);

      expect(controller.idField).toBe("_id");
    });

    it("should build filter with _id by default", () => {
      const repo = new FilterTrackingRepository();
      const controller = new BaseController(repo as any);

      const req = createReq({ params: { id: "abc123" } });
      const filter = controller.accessControl.buildIdFilter("abc123", req);

      expect(filter).toHaveProperty("_id", "abc123");
      expect(filter).not.toHaveProperty("id");
    });
  });

  describe("custom idField via constructor options", () => {
    it("should use custom idField when specified", () => {
      const repo = new FilterTrackingRepository();
      const controller = new BaseController(repo as any, { idField: "id" });

      expect(controller.idField).toBe("id");
    });

    it("should build filter with custom field name", () => {
      const repo = new FilterTrackingRepository();
      const controller = new BaseController(repo as any, { idField: "id" });

      const req = createReq({ params: { id: "row-42" } });
      const filter = controller.accessControl.buildIdFilter("row-42", req);

      expect(filter).toHaveProperty("id", "row-42");
      expect(filter).not.toHaveProperty("_id");
    });

    it("should support uuid as idField", () => {
      const repo = new FilterTrackingRepository();
      const controller = new BaseController(repo as any, { idField: "uuid" });

      const req = createReq({
        params: { id: "550e8400-e29b-41d4-a716-446655440000" },
      });
      const filter = controller.accessControl.buildIdFilter(
        "550e8400-e29b-41d4-a716-446655440000",
        req,
      );

      expect(filter).toHaveProperty(
        "uuid",
        "550e8400-e29b-41d4-a716-446655440000",
      );
    });
  });

  describe("idField with policy filters and tenant scoping", () => {
    it("should combine custom idField with policy filters", () => {
      const repo = new FilterTrackingRepository();
      const controller = new BaseController(repo as any, { idField: "id" });

      const req = createReq({
        params: { id: "row-42" },
        metadata: {
          _policyFilters: { createdBy: "user-1" },
          arc: {
            hooks: {
              executeBefore: async () => {},
              executeAfter: async () => {},
            },
          },
        },
      });

      const filter = controller.accessControl.buildIdFilter("row-42", req);

      expect(filter).toHaveProperty("id", "row-42");
      expect(filter).toHaveProperty("createdBy", "user-1");
    });

    it("should combine custom idField with tenant scoping", () => {
      const repo = new FilterTrackingRepository();
      const controller = new BaseController(repo as any, {
        idField: "id",
        tenantField: "tenantId",
      });

      const scope: RequestScope = {
        kind: "member",
        organizationId: "org-1",
        orgRoles: ["admin"],
      };

      const req = createReq({
        params: { id: "row-42" },
        metadata: {
          _scope: scope,
          arc: {
            hooks: {
              executeBefore: async () => {},
              executeAfter: async () => {},
            },
          },
        },
      });

      const filter = controller.accessControl.buildIdFilter("row-42", req);

      expect(filter).toHaveProperty("id", "row-42");
      expect(filter).toHaveProperty("tenantId", "org-1");
    });
  });
});
