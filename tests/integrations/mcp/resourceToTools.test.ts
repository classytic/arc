import { describe, expect, it, vi } from "vitest";
import type { ResourceDefinition } from "../../../src/core/defineResource.js";
import { resourceToTools } from "../../../src/integrations/mcp/resourceToTools.js";

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
    routes: [],
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
    expect(byName.update_product.annotations).toEqual({
      destructiveHint: true,
      idempotentHint: true,
    });
    expect(byName.delete_product.annotations).toEqual({
      destructiveHint: true,
      idempotentHint: true,
    });
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

  it("returns empty array if no controller and no adapter", () => {
    const tools = resourceToTools(mockResource({ controller: undefined, adapter: undefined }));
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

  // ============================================================================
  // Bug fix: disableDefaultRoutes should NOT block MCP tools
  // ============================================================================

  describe("disableDefaultRoutes (bug fix)", () => {
    it("generates MCP tools even with disableDefaultRoutes: true", () => {
      const tools = resourceToTools(mockResource({ disableDefaultRoutes: true }));
      expect(tools).toHaveLength(5);
      expect(tools.map((t) => t.name)).toEqual([
        "list_products",
        "get_product",
        "create_product",
        "update_product",
        "delete_product",
      ]);
    });

    it("still respects disabledRoutes with disableDefaultRoutes: true", () => {
      const tools = resourceToTools(
        mockResource({ disableDefaultRoutes: true, disabledRoutes: ["delete" as any] }),
      );
      expect(tools).toHaveLength(4);
      expect(tools.map((t) => t.name)).not.toContain("delete_product");
    });
  });

  // ============================================================================
  // Auto-create controller from adapter
  // ============================================================================

  describe("auto-create controller from adapter", () => {
    it("creates controller from adapter when controller is missing", () => {
      const mockAdapter = {
        repository: {
          find: vi.fn(),
          findById: vi.fn(),
          create: vi.fn(),
          updateById: vi.fn(),
          deleteById: vi.fn(),
        },
        type: "mongoose" as const,
        name: "product",
      };
      const tools = resourceToTools(
        mockResource({ controller: undefined, adapter: mockAdapter as any }),
      );
      // BaseController is auto-created — tools should be generated
      expect(tools.length).toBeGreaterThan(0);
      expect(tools.map((t) => t.name)).toContain("list_products");
    });
  });

  // ============================================================================
  // Per-operation name overrides
  // ============================================================================

  describe("per-operation name overrides", () => {
    it("supports names config to override specific tool names", () => {
      const tools = resourceToTools(mockResource(), {
        names: { get: "get_product_by_id" },
      });
      expect(tools.find((t) => t.name === "get_product_by_id")).toBeDefined();
      expect(tools.find((t) => t.name === "get_product")).toBeUndefined();
    });

    it("uses default names for operations not in names config", () => {
      const tools = resourceToTools(mockResource(), {
        names: { get: "get_product_by_id" },
      });
      expect(tools.find((t) => t.name === "list_products")).toBeDefined();
      expect(tools.find((t) => t.name === "create_product")).toBeDefined();
    });

    it("combines prefix with names (names takes priority)", () => {
      const tools = resourceToTools(mockResource(), {
        toolNamePrefix: "crm",
        names: { get: "fetch_product" },
      });
      // Named op uses exact name, not prefixed
      expect(tools.find((t) => t.name === "fetch_product")).toBeDefined();
      // Other ops use prefix
      expect(tools.find((t) => t.name === "crm_list_products")).toBeDefined();
    });
  });

  // ============================================================================
  // Auto-derive filterableFields from QueryParser
  // ============================================================================

  describe("auto-derive filterableFields", () => {
    it("uses queryParser.allowedFilterFields when schemaOptions.filterableFields is not set", () => {
      const resource = mockResource({
        schemaOptions: {
          fieldRules: {
            name: { type: "string", required: true },
            status: { type: "string", enum: ["active", "inactive"] },
            companyId: { type: "string" },
          },
          hiddenFields: [],
          readonlyFields: [],
          // No filterableFields set
        },
        queryParser: {
          allowedFilterFields: ["status", "companyId"],
        },
      } as any);

      const tools = resourceToTools(resource);
      const listTool = tools.find((t) => t.name === "list_products")!;

      // Should have status and companyId from queryParser, plus pagination fields
      expect(listTool.inputSchema).toHaveProperty("status");
      expect(listTool.inputSchema).toHaveProperty("companyId");
      expect(listTool.inputSchema).toHaveProperty("page");
    });

    it("prefers explicit filterableFields over queryParser.allowedFilterFields", () => {
      const resource = mockResource({
        schemaOptions: {
          fieldRules: {
            name: { type: "string", required: true },
            status: { type: "string" },
            companyId: { type: "string" },
          },
          filterableFields: ["status"], // Explicit
          hiddenFields: [],
          readonlyFields: [],
        },
        queryParser: {
          allowedFilterFields: ["status", "companyId"], // Would add companyId
        },
      } as any);

      const tools = resourceToTools(resource);
      const listTool = tools.find((t) => t.name === "list_products")!;

      // Should only have status (from explicit filterableFields), not companyId
      expect(listTool.inputSchema).toHaveProperty("status");
      expect(listTool.inputSchema).not.toHaveProperty("companyId");
    });
  });

  // ============================================================================
  // mcpHandler on additional routes
  // ============================================================================

  describe("mcpHandler on additional routes", () => {
    it("picks up mcpHandler from raw:false routes", async () => {
      const mcpHandler = vi.fn().mockResolvedValue({
        content: [{ type: "text", text: '{"count": 42}' }],
      });

      const tools = resourceToTools(
        mockResource({
          routes: [
            {
              method: "GET",
              path: "/stats",
              handler: () => {},
              raw: true,
              permissions: () => ({ allowed: true }),
              operation: "stats",
              summary: "Get product stats",
              mcpHandler,
            } as any,
          ],
        }),
      );

      const statsTool = tools.find((t) => t.name === "stats_product");
      expect(statsTool).toBeDefined();
      expect(statsTool?.description).toBe("Get product stats");

      const result = await statsTool?.handler(
        { filter: "active" },
        { session: null, log: vi.fn().mockResolvedValue(undefined), extra: {} },
      );
      expect(result.isError).toBeFalsy();
      expect(mcpHandler).toHaveBeenCalledWith({ filter: "active" });
    });

    it("ignores raw:false routes without mcpHandler", () => {
      const tools = resourceToTools(
        mockResource({
          routes: [
            {
              method: "GET",
              path: "/stats",
              handler: () => {},
              raw: true,
              permissions: () => ({ allowed: true }),
            } as any,
          ],
        }),
      );
      // Should only have 5 CRUD tools, not the stats route
      expect(tools).toHaveLength(5);
    });
  });

  // ============================================================================
  // Tool handlers
  // ============================================================================

  // ============================================================================
  // Permission filters carried into _policyFilters (bug fix)
  // ============================================================================

  describe("permission filters → _policyFilters", () => {
    it("passes PermissionResult.filters into controller request context", async () => {
      const resource = mockResource({
        permissions: {
          list: (() => ({
            granted: true,
            filters: { projectId: "proj-123", userId: "user-456" },
          })) as any,
        },
      });
      const tools = resourceToTools(resource);
      const listTool = tools.find((t) => t.name === "list_products")!;

      await listTool.handler(
        { page: 1 },
        { session: { userId: "user-456" }, log: vi.fn().mockResolvedValue(undefined), extra: {} },
      );

      const ctrl = resource.controller as any;
      expect(ctrl.list).toHaveBeenCalled();
      const ctx = ctrl.list.mock.calls[0][0];
      expect(ctx.metadata._policyFilters).toEqual({
        projectId: "proj-123",
        userId: "user-456",
      });
    });

    // Regression pin: PermissionResult.scope must reach the controller as
    // metadata._scope. Before the fix, evaluatePermission() in resourceToTools
    // only extracted `filters` and silently dropped `scope`, breaking custom
    // API-key auth in MCP. Dedicated regression file:
    // tests/integrations/mcp/mcp-permission-scope.test.ts. This inline
    // assertion exists so anyone reading the canonical resourceToTools test
    // file sees the contract pinned beside the existing filter cases.
    it("propagates PermissionResult.scope into controller metadata._scope", async () => {
      const resource = mockResource({
        permissions: {
          list: (() => ({
            granted: true,
            scope: {
              kind: "service",
              clientId: "client-acme",
              organizationId: "org-acme",
            },
          })) as any,
        },
      });
      const tools = resourceToTools(resource);
      const listTool = tools.find((t) => t.name === "list_products")!;

      await listTool.handler(
        {},
        { session: null, log: vi.fn().mockResolvedValue(undefined), extra: {} },
      );

      const ctrl = resource.controller as any;
      const ctx = ctrl.list.mock.calls[0][0];
      expect(ctx.metadata._scope).toEqual({
        kind: "service",
        clientId: "client-acme",
        organizationId: "org-acme",
      });
    });

    it("does NOT downgrade an existing session-derived scope (session wins)", async () => {
      const resource = mockResource({
        permissions: {
          list: (() => ({
            granted: true,
            scope: {
              kind: "service",
              clientId: "should-not-apply",
              organizationId: "org-narrower",
            },
          })) as any,
        },
      });
      const tools = resourceToTools(resource);
      const listTool = tools.find((t) => t.name === "list_products")!;

      await listTool.handler(
        {},
        {
          session: { userId: "u1", organizationId: "org-session" },
          log: vi.fn().mockResolvedValue(undefined),
          extra: {},
        },
      );

      const ctrl = resource.controller as any;
      const ctx = ctrl.list.mock.calls[0][0];
      // Session scope = member (auth set orgId) → must NOT be overwritten
      expect(ctx.metadata._scope.kind).toBe("member");
      expect(ctx.metadata._scope.organizationId).toBe("org-session");
    });

    it("denies access when permission check returns granted: false", async () => {
      const resource = mockResource({
        permissions: {
          create: (() => ({
            granted: false,
            reason: "Not authorized",
          })) as any,
        },
      });
      const tools = resourceToTools(resource);
      const createTool = tools.find((t) => t.name === "create_product")!;

      const result = await createTool.handler(
        { name: "Widget" },
        { session: { userId: "u1" }, log: vi.fn().mockResolvedValue(undefined), extra: {} },
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Permission denied");
      expect((resource.controller as any).create).not.toHaveBeenCalled();
    });

    it("denies access when permission check returns false", async () => {
      const resource = mockResource({
        permissions: {
          delete: (() => false) as any,
        },
      });
      const tools = resourceToTools(resource);
      const deleteTool = tools.find((t) => t.name === "delete_product")!;

      const result = await deleteTool.handler(
        { id: "123" },
        { session: null, log: vi.fn().mockResolvedValue(undefined), extra: {} },
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Permission denied");
    });

    it("allows access with empty _policyFilters when permission returns true", async () => {
      const resource = mockResource({
        permissions: {
          get: (() => true) as any,
        },
      });
      const tools = resourceToTools(resource);
      const getTool = tools.find((t) => t.name === "get_product")!;

      await getTool.handler(
        { id: "abc" },
        { session: { userId: "u1" }, log: vi.fn().mockResolvedValue(undefined), extra: {} },
      );

      const ctx = (resource.controller as any).get.mock.calls[0][0];
      expect(ctx.metadata._policyFilters).toEqual({});
    });

    it("handles async permission checks", async () => {
      const resource = mockResource({
        permissions: {
          list: (async () => ({
            granted: true,
            filters: { ownerId: "async-user" },
          })) as any,
        },
      });
      const tools = resourceToTools(resource);
      const listTool = tools.find((t) => t.name === "list_products")!;

      await listTool.handler(
        {},
        { session: { userId: "async-user" }, log: vi.fn().mockResolvedValue(undefined), extra: {} },
      );

      const ctx = (resource.controller as any).list.mock.calls[0][0];
      expect(ctx.metadata._policyFilters).toEqual({ ownerId: "async-user" });
    });

    it("works without permissions defined (no restriction)", async () => {
      const resource = mockResource({ permissions: {} });
      const tools = resourceToTools(resource);
      const listTool = tools.find((t) => t.name === "list_products")!;

      await listTool.handler(
        {},
        { session: null, log: vi.fn().mockResolvedValue(undefined), extra: {} },
      );

      const ctx = (resource.controller as any).list.mock.calls[0][0];
      expect(ctx.metadata._policyFilters).toEqual({});
    });
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
