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
});
