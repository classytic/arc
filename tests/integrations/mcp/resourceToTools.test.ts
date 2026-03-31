import { describe, expect, it, vi } from "vitest";
import { resourceToTools } from "../../../src/integrations/mcp/resourceToTools.js";
import type { ResourceDefinition } from "../../../src/core/defineResource.js";

function mockResource(overrides?: Partial<ResourceDefinition>): ResourceDefinition {
  return {
    name: "product",
    displayName: "Product",
    tag: "Product",
    prefix: "/products",
    controller: {
      list: vi.fn().mockResolvedValue({ success: true, data: [] }),
      get: vi.fn().mockResolvedValue({ success: true, data: { _id: "1" } }),
      create: vi.fn().mockResolvedValue({ success: true, data: { _id: "2" } }),
      update: vi.fn().mockResolvedValue({ success: true, data: { _id: "1" } }),
      delete: vi.fn().mockResolvedValue({ success: true }),
    },
    schemaOptions: {
      fieldRules: {
        name: { type: "string", required: true },
        price: { type: "number", required: true, min: 0 },
        category: { type: "string", enum: ["a", "b"] },
      },
      filterableFields: ["category"],
      hiddenFields: [],
      readonlyFields: [],
    },
    permissions: {},
    additionalRoutes: [],
    middlewares: {},
    disableDefaultRoutes: false,
    disabledRoutes: [],
    customSchemas: {},
    events: {},
    _appliedPresets: [],
    _pendingHooks: [],
    ...overrides,
  } as unknown as ResourceDefinition;
}

describe("resourceToTools", () => {
  it("generates 5 CRUD tools by default", () => {
    const tools = resourceToTools(mockResource());
    expect(tools).toHaveLength(5);
    expect(tools.map((t) => t.name)).toEqual([
      "list_products",
      "get_product",
      "create_product",
      "update_product",
      "delete_product",
    ]);
  });

  it("sets correct annotations", () => {
    const tools = resourceToTools(mockResource());
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));

    expect(byName.list_products.annotations).toEqual({ readOnlyHint: true });
    expect(byName.get_product.annotations).toEqual({ readOnlyHint: true });
    expect(byName.create_product.annotations).toEqual({ destructiveHint: false });
    expect(byName.update_product.annotations).toEqual({ destructiveHint: true, idempotentHint: true });
    expect(byName.delete_product.annotations).toEqual({ destructiveHint: true, idempotentHint: true });
  });

  it("skips disabled routes", () => {
    const tools = resourceToTools(mockResource({ disabledRoutes: ["delete" as any] }));
    expect(tools.map((t) => t.name)).not.toContain("delete_product");
    expect(tools).toHaveLength(4);
  });

  it("respects config.operations filter", () => {
    const tools = resourceToTools(mockResource(), { operations: ["list", "get"] });
    expect(tools.map((t) => t.name)).toEqual(["list_products", "get_product"]);
  });

  it("applies tool name prefix", () => {
    const tools = resourceToTools(mockResource(), { toolNamePrefix: "crm" });
    expect(tools[0].name).toBe("crm_list_products");
    expect(tools[1].name).toBe("crm_get_product");
  });

  it("returns empty array if no controller", () => {
    const tools = resourceToTools(mockResource({ controller: undefined }));
    expect(tools).toEqual([]);
  });

  it("mentions soft delete in delete tool description", () => {
    const tools = resourceToTools(mockResource({ _appliedPresets: ["softDelete"] } as any));
    const deleteTool = tools.find((t) => t.name === "delete_product");
    expect(deleteTool?.description).toContain("soft delete");
  });

  it("respects config.descriptions override", () => {
    const tools = resourceToTools(mockResource(), {
      descriptions: { list: "Browse all items" },
    });
    expect(tools[0].description).toBe("Browse all items");
  });

  describe("tool handlers", () => {
    it("list handler calls controller.list with IRequestContext", async () => {
      const resource = mockResource();
      const tools = resourceToTools(resource);
      const listTool = tools[0];

      const result = await listTool.handler(
        { page: 1, limit: 10 },
        { session: null, log: vi.fn().mockResolvedValue(undefined), extra: {} },
      );

      expect(result.isError).toBeFalsy();
      expect((resource.controller as any).list).toHaveBeenCalled();
    });

    it("create handler passes input as body", async () => {
      const resource = mockResource();
      const tools = resourceToTools(resource);
      const createTool = tools.find((t) => t.name === "create_product")!;

      await createTool.handler(
        { name: "Widget", price: 10 },
        { session: { userId: "u1" }, log: vi.fn().mockResolvedValue(undefined), extra: {} },
      );

      const ctrl = resource.controller as any;
      expect(ctrl.create).toHaveBeenCalled();
      const ctx = ctrl.create.mock.calls[0][0];
      expect(ctx.body).toEqual({ name: "Widget", price: 10 });
    });

    it("returns isError on controller failure", async () => {
      const resource = mockResource();
      (resource.controller as any).list.mockResolvedValue({ success: false, error: "DB error" });

      const tools = resourceToTools(resource);
      const result = await tools[0].handler(
        {},
        { session: null, log: vi.fn().mockResolvedValue(undefined), extra: {} },
      );

      expect(result.isError).toBe(true);
      expect(result.content[0]).toEqual({ type: "text", text: "DB error" });
    });

    it("catches thrown errors", async () => {
      const resource = mockResource();
      (resource.controller as any).list.mockRejectedValue(new Error("Connection lost"));

      const tools = resourceToTools(resource);
      const result = await tools[0].handler(
        {},
        { session: null, log: vi.fn().mockResolvedValue(undefined), extra: {} },
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Connection lost");
    });
  });
});
