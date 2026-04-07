import { describe, expect, it } from "vitest";
import { buildRequestContext } from "../../../src/integrations/mcp/buildRequestContext.js";

const auth = { userId: "user-1", organizationId: "org-1" };

describe("buildRequestContext", () => {
  describe("list operation", () => {
    it("puts all input into query", () => {
      const ctx = buildRequestContext({ page: 1, limit: 10, status: "active" }, auth, "list");
      expect(ctx.query).toEqual({ page: 1, limit: 10, status: "active" });
      expect(ctx.params).toEqual({});
      expect(ctx.body).toBeUndefined();
    });
  });

  describe("get operation", () => {
    it("puts id into params", () => {
      const ctx = buildRequestContext({ id: "abc-123" }, auth, "get");
      expect(ctx.params).toEqual({ id: "abc-123" });
      expect(ctx.query).toEqual({});
      expect(ctx.body).toBeUndefined();
    });
  });

  describe("create operation", () => {
    it("puts all input into body", () => {
      const ctx = buildRequestContext({ name: "Widget", price: 10 }, auth, "create");
      expect(ctx.body).toEqual({ name: "Widget", price: 10 });
      expect(ctx.params).toEqual({});
    });
  });

  describe("update operation", () => {
    it("puts id into params and rest into body", () => {
      const ctx = buildRequestContext({ id: "abc-123", name: "Updated" }, auth, "update");
      expect(ctx.params).toEqual({ id: "abc-123" });
      expect(ctx.body).toEqual({ name: "Updated" });
    });

    it("handles update with only id", () => {
      const ctx = buildRequestContext({ id: "abc-123" }, auth, "update");
      expect(ctx.params).toEqual({ id: "abc-123" });
      expect(ctx.body).toEqual({});
    });
  });

  describe("delete operation", () => {
    it("puts id into params", () => {
      const ctx = buildRequestContext({ id: "abc-123" }, auth, "delete");
      expect(ctx.params).toEqual({ id: "abc-123" });
      expect(ctx.body).toBeUndefined();
    });
  });

  describe("auth context", () => {
    it("sets member scope with org", () => {
      const ctx = buildRequestContext({}, auth, "list");
      expect(ctx.user).toMatchObject({ id: "user-1", _id: "user-1" });
      expect((ctx.metadata as Record<string, unknown>)._scope).toEqual({
        kind: "member",
        userId: "user-1",
        userRoles: [],
        organizationId: "org-1",
        orgRoles: [],
      });
    });

    it("sets authenticated scope without org", () => {
      const ctx = buildRequestContext({}, { userId: "user-1" }, "list");
      expect((ctx.metadata as Record<string, unknown>)._scope).toEqual({
        kind: "authenticated",
        userId: "user-1",
        userRoles: [],
      });
    });

    it("sets public scope when no auth", () => {
      const ctx = buildRequestContext({}, null, "list");
      expect(ctx.user).toBeNull();
      expect((ctx.metadata as Record<string, unknown>)._scope).toEqual({ kind: "public" });
    });
  });

  // ==========================================================================
  // expandOperatorKeys — covers ALL operators MongoKit's QueryParser recognizes
  // ==========================================================================
  describe("expandOperatorKeys (list mode operator rewriting)", () => {
    it("rewrites comparison operators (gt, gte, lt, lte, eq, ne)", () => {
      const ctx = buildRequestContext(
        {
          price_gt: 10,
          price_lte: 100,
          stock_eq: 5,
          status_ne: "deleted",
        },
        null,
        "list",
      );
      expect(ctx.query).toEqual({
        price: { gt: 10, lte: 100 },
        stock: { eq: 5 },
        status: { ne: "deleted" },
      });
    });

    it("rewrites set operators (in, nin)", () => {
      const ctx = buildRequestContext(
        { category_in: "books,electronics", role_nin: "guest" },
        null,
        "list",
      );
      expect(ctx.query).toEqual({
        category: { in: "books,electronics" },
        role: { nin: "guest" },
      });
    });

    it("rewrites string operators (like, contains, regex)", () => {
      const ctx = buildRequestContext(
        { name_like: "foo", description_contains: "bar", code_regex: "^A" },
        null,
        "list",
      );
      expect(ctx.query).toEqual({
        name: { like: "foo" },
        description: { contains: "bar" },
        code: { regex: "^A" },
      });
    });

    it("rewrites misc operators (exists, size, type)", () => {
      const ctx = buildRequestContext(
        { deletedAt_exists: false, tags_size: 3, value_type: "string" },
        null,
        "list",
      );
      expect(ctx.query).toEqual({
        deletedAt: { exists: false },
        tags: { size: 3 },
        value: { type: "string" },
      });
    });

    it("rewrites geo operators (near, nearSphere, withinRadius, geoWithin) — MongoKit 3.5.5+", () => {
      // Regression: before MongoKit 3.5.5 integration, expandOperatorKeys
      // didn't recognize geo operators and silently passed `location_geoWithin`
      // through as a literal key, which the QueryParser then dropped because
      // it wasn't in `allowedFilterFields`. Result: unfiltered docs returned.
      // This test pins the contract for all 4 geo operators.
      const ctx = buildRequestContext(
        {
          location_near: "-122.4,37.7,5000",
          location_nearSphere: "-122.4,37.7,5000",
          location_withinRadius: "-122.4,37.7,2000",
          location_geoWithin: "-122.45,37.75,-122.40,37.79",
        },
        null,
        "list",
      );
      expect(ctx.query).toEqual({
        location: {
          near: "-122.4,37.7,5000",
          nearSphere: "-122.4,37.7,5000",
          withinRadius: "-122.4,37.7,2000",
          geoWithin: "-122.45,37.75,-122.40,37.79",
        },
      });
    });

    it("leaves unknown operator-looking keys as literals (forward-compat safety)", () => {
      // If MongoKit adds a new operator we don't know about yet, the worst
      // case is the query reaches the parser as a flat key — the parser
      // will either recognize it (if we forgot to update Arc) or drop it
      // (allowedFilterFields will block it). Either way, no security leak.
      const ctx = buildRequestContext({ price_unknownOp: 10 }, null, "list");
      expect(ctx.query).toEqual({ price_unknownOp: 10 });
    });

    it("does not rewrite snake_case fields with no operator suffix", () => {
      // `created_by` is a field name, not `created` + `_by` operator.
      // Since `by` is not in OPERATOR_SUFFIXES, the key passes through.
      const ctx = buildRequestContext({ created_by: "user-1" }, null, "list");
      expect(ctx.query).toEqual({ created_by: "user-1" });
    });
  });
});
