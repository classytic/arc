/**
 * MCP nested filter operators — end-to-end
 *
 * Verifies that MCP tool inputs with operator-suffixed keys (price_gte, name_contains)
 * are correctly converted to bracket notation that BaseController/QueryParser expect.
 *
 * MCP convention (flat JSON keys):     { price_gte: 100, price_lte: 500 }
 * Internal QueryParser format:          { price: { gte: 100, lte: 500 } }
 *
 * This is the contract test — if it breaks, MCP filtering breaks.
 */

import { describe, expect, it } from "vitest";
import { buildRequestContext } from "../../../src/integrations/mcp/buildRequestContext.js";

describe("MCP buildRequestContext — operator key expansion", () => {
  it("expands single operator: price_gte → price.gte", () => {
    const ctx = buildRequestContext({ price_gte: 100 }, null, "list");
    expect(ctx.query).toEqual({ price: { gte: 100 } });
  });

  it("expands multiple operators on same field: price_gte + price_lte", () => {
    const ctx = buildRequestContext({ price_gte: 10, price_lte: 100 }, null, "list");
    expect(ctx.query).toEqual({ price: { gte: 10, lte: 100 } });
  });

  it("supports all comparison ops: gt, gte, lt, lte, ne, eq", () => {
    const ctx = buildRequestContext(
      { price_gt: 1, price_gte: 2, price_lt: 100, price_lte: 99, price_ne: 50 },
      null,
      "list",
    );
    expect(ctx.query).toEqual({
      price: { gt: 1, gte: 2, lt: 100, lte: 99, ne: 50 },
    });
  });

  it("expands in/nin (set operators)", () => {
    const ctx = buildRequestContext({ status_in: "active,pending" }, null, "list");
    expect(ctx.query).toEqual({ status: { in: "active,pending" } });
  });

  it("expands exists (boolean check)", () => {
    const ctx = buildRequestContext({ deletedAt_exists: false }, null, "list");
    expect(ctx.query).toEqual({ deletedAt: { exists: false } });
  });

  it("preserves non-operator keys as-is", () => {
    const ctx = buildRequestContext(
      { category: "gadgets", price_gte: 100, page: 1, limit: 20 },
      null,
      "list",
    );
    expect(ctx.query).toEqual({
      category: "gadgets",
      price: { gte: 100 },
      page: 1,
      limit: 20,
    });
  });

  it("handles exact match + operator on same field", () => {
    // { status: 'active', status_ne: 'archived' }
    const ctx = buildRequestContext({ status: "active", status_ne: "archived" }, null, "list");
    expect(ctx.query).toEqual({
      status: { eq: "active", ne: "archived" },
    });
  });

  it("operator on field with underscores in name: created_at_gte", () => {
    // Splits at LAST underscore — created_at + gte
    const ctx = buildRequestContext({ created_at_gte: "2025-01-01" }, null, "list");
    expect(ctx.query).toEqual({ created_at: { gte: "2025-01-01" } });
  });

  it("unknown suffix is treated as a normal field", () => {
    // _foo is not in OPERATOR_SUFFIXES, treat as literal field name
    const ctx = buildRequestContext({ name_foo: "value" }, null, "list");
    expect(ctx.query).toEqual({ name_foo: "value" });
  });

  it("no expansion in create body — flat fields stay flat", () => {
    const ctx = buildRequestContext({ name: "Widget", price: 100, in_stock: true }, null, "create");
    expect(ctx.body).toEqual({ name: "Widget", price: 100, in_stock: true });
  });

  it("update extracts id, leaves rest as-is (no operator expansion)", () => {
    const ctx = buildRequestContext({ id: "abc", name: "New Name" }, null, "update");
    expect(ctx.params).toEqual({ id: "abc" });
    expect(ctx.body).toEqual({ name: "New Name" });
  });

  it("get/delete pull id only", () => {
    const getCtx = buildRequestContext({ id: "xyz" }, null, "get");
    expect(getCtx.params).toEqual({ id: "xyz" });
    expect(getCtx.body).toBeUndefined();
    expect(getCtx.query).toEqual({});

    const delCtx = buildRequestContext({ id: "xyz" }, null, "delete");
    expect(delCtx.params).toEqual({ id: "xyz" });
    expect(delCtx.body).toBeUndefined();
  });

  it("complex realistic query: filter + range + pagination + sort", () => {
    const ctx = buildRequestContext(
      {
        category: "gadgets",
        price_gte: 10,
        price_lte: 100,
        status_in: "active,pending",
        page: 1,
        limit: 20,
        sort: "-createdAt",
      },
      null,
      "list",
    );
    expect(ctx.query).toEqual({
      category: "gadgets",
      price: { gte: 10, lte: 100 },
      status: { in: "active,pending" },
      page: 1,
      limit: 20,
      sort: "-createdAt",
    });
  });
});
