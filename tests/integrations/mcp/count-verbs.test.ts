/**
 * MCP resource-dispatch verbs (2.22) — REST parity for `?_count=true` /
 * `?_exists=true` / `?_distinct=field` on the LIST tool.
 *
 * Pins: the list tool schema advertises the three verbs; the description
 * teaches them; leading-underscore keys survive `expandOperatorKeys`
 * (the `lastIndexOf('_') > 0` guard — `status_gte` expands, `_count`
 * must not); and the verb flows through `createCrudHandler` into the
 * controller's query — the SAME dispatch path REST uses, so permissions,
 * row filters, and tenant scoping apply identically.
 */
import { describe, expect, it } from "vitest";
import {
  createCrudHandler,
  defaultCrudDescription,
} from "../../../src/integrations/mcp/crud-tools.js";
import { buildInputSchema } from "../../../src/integrations/mcp/input-schema.js";

describe("MCP list tool — count/exists/distinct verbs", () => {
  it("advertises _count, _exists, _distinct in the list input schema", () => {
    const schema = buildInputSchema(
      "list",
      { status: { type: "string" } },
      {
        filterableFields: ["status"],
      },
    );
    const keys = Object.keys(schema as Record<string, unknown>);
    expect(keys).toEqual(expect.arrayContaining(["_count", "_exists", "_distinct", "status"]));
  });

  it("teaches the verbs in the default list description", () => {
    const desc = defaultCrudDescription("list", "Order", false, {
      filterableFields: ["status"],
    });
    expect(desc).toContain("_count: true");
    expect(desc).toContain("_exists: true");
    expect(desc).toContain("_distinct");
  });

  it("verb keys reach the controller query INTACT while operator keys expand", async () => {
    let seenQuery: Record<string, unknown> | undefined;
    const controller = {
      list: async (ctx: { query: Record<string, unknown> }) => {
        seenQuery = ctx.query;
        return { success: true, data: { count: 42 } };
      },
    };

    const handler = createCrudHandler("list", controller, "order", undefined);
    const result = await handler({ _count: true, status: "active", total_gte: 100 }, {
      session: undefined,
    } as never);

    // `_count` untouched (leading underscore), `total_gte` expanded to
    // bracket form — both behaviors from the same expandOperatorKeys pass.
    expect(seenQuery?._count).toBe(true);
    expect(seenQuery?.status).toBe("active");
    expect(seenQuery?.total).toEqual({ gte: 100 });
    expect(JSON.stringify(result)).toContain("42");
  });
});
