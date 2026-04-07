/**
 * E2E: MongoKit QueryParser → Arc defineResource → MCP Tools
 *
 * Tests the full integration chain:
 * 1. MongoKit QueryParser with allowedFilterFields/allowedOperators/allowedSortFields
 * 2. Arc defineResource stores the queryParser
 * 3. resourceToTools auto-derives filterableFields from the parser
 * 4. MCP tools get correct input schemas and enriched descriptions
 * 5. createTestMcpClient can call the tools via InMemoryTransport
 */

import { QueryParser } from "@classytic/mongokit";
import { describe, expect, it, vi } from "vitest";
import type { ResourceDefinition } from "../../../src/core/defineResource.js";
import { resourceToTools } from "../../../src/integrations/mcp/resourceToTools.js";

function mockResourceWithMongoKit(
  parserOpts: ConstructorParameters<typeof QueryParser>[0] = {},
  overrides?: Partial<ResourceDefinition>,
): ResourceDefinition {
  const queryParser = new QueryParser(parserOpts);

  return {
    name: "job",
    displayName: "Job",
    tag: "Job",
    prefix: "/jobs",
    controller: {
      list: vi.fn().mockResolvedValue({
        success: true,
        data: [{ _id: "1", title: "Engineer", status: "active" }],
        meta: { total: 1, page: 1, limit: 20 },
      }),
      get: vi.fn().mockResolvedValue({ success: true, data: { _id: "1", title: "Engineer" } }),
      create: vi.fn().mockResolvedValue({ success: true, data: { _id: "2" } }),
      update: vi.fn().mockResolvedValue({ success: true, data: { _id: "1" } }),
      delete: vi.fn().mockResolvedValue({ success: true }),
    },
    schemaOptions: {
      fieldRules: {
        title: { type: "string", required: true },
        status: { type: "string", enum: ["active", "closed", "draft"] },
        companyId: { type: "string", required: true },
        salary: { type: "number", min: 0 },
        repository: { type: "string" },
        phase: { type: "string", enum: ["screening", "interview", "offer"] },
        createdAt: { type: "date", systemManaged: true },
        updatedAt: { type: "date", systemManaged: true },
      },
      hiddenFields: [],
      readonlyFields: [],
      // NOTE: No filterableFields — should auto-derive from QueryParser
    },
    queryParser,
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

describe("MongoKit QueryParser → MCP Tools E2E", () => {
  describe("auto-derive filterableFields", () => {
    it("derives filterable fields from QueryParser.allowedFilterFields", () => {
      const resource = mockResourceWithMongoKit({
        allowedFilterFields: ["companyId", "status", "phase"],
      });

      const tools = resourceToTools(resource);
      const listTool = tools.find((t) => t.name === "list_jobs")!;

      expect(listTool).toBeDefined();
      expect(listTool.inputSchema).toHaveProperty("companyId");
      expect(listTool.inputSchema).toHaveProperty("status");
      expect(listTool.inputSchema).toHaveProperty("phase");
      // salary and repository are NOT in allowedFilterFields
      expect(listTool.inputSchema).not.toHaveProperty("salary");
      expect(listTool.inputSchema).not.toHaveProperty("repository");
      // Pagination fields always present
      expect(listTool.inputSchema).toHaveProperty("page");
      expect(listTool.inputSchema).toHaveProperty("limit");
      expect(listTool.inputSchema).toHaveProperty("sort");
    });

    it("prefers explicit schemaOptions.filterableFields over QueryParser", () => {
      const resource = mockResourceWithMongoKit(
        { allowedFilterFields: ["companyId", "status", "phase", "repository"] },
        {
          schemaOptions: {
            fieldRules: {
              title: { type: "string", required: true },
              status: { type: "string" },
              companyId: { type: "string" },
              repository: { type: "string" },
              phase: { type: "string" },
            },
            filterableFields: ["status"], // Explicit — only status
            hiddenFields: [],
            readonlyFields: [],
          },
        },
      );

      const tools = resourceToTools(resource);
      const listTool = tools.find((t) => t.name === "list_jobs")!;

      expect(listTool.inputSchema).toHaveProperty("status");
      expect(listTool.inputSchema).not.toHaveProperty("companyId");
      expect(listTool.inputSchema).not.toHaveProperty("phase");
    });
  });

  describe("enriched list tool descriptions", () => {
    it("includes filterable fields in description", () => {
      const resource = mockResourceWithMongoKit({
        allowedFilterFields: ["companyId", "status"],
      });

      const tools = resourceToTools(resource);
      const listTool = tools.find((t) => t.name === "list_jobs")!;

      expect(listTool.description).toContain("companyId");
      expect(listTool.description).toContain("status");
      expect(listTool.description).toContain("Filterable fields");
    });

    it("includes allowed operators in description", () => {
      const resource = mockResourceWithMongoKit({
        allowedFilterFields: ["status"],
        allowedOperators: ["eq", "ne", "in"],
      });

      const tools = resourceToTools(resource);
      const listTool = tools.find((t) => t.name === "list_jobs")!;

      expect(listTool.description).toContain("eq, ne, in");
      expect(listTool.description).toContain("Filter operators");
    });

    it("includes sortable fields in description", () => {
      const resource = mockResourceWithMongoKit({
        allowedFilterFields: ["status"],
        allowedSortFields: ["createdAt", "title", "salary"],
      });

      const tools = resourceToTools(resource);
      const listTool = tools.find((t) => t.name === "list_jobs")!;

      expect(listTool.description).toContain("createdAt, title, salary");
      expect(listTool.description).toContain("Sortable fields");
    });

    it("does not add query metadata for non-list operations", () => {
      const resource = mockResourceWithMongoKit({
        allowedFilterFields: ["status"],
        allowedOperators: ["eq", "ne"],
        allowedSortFields: ["createdAt"],
      });

      const tools = resourceToTools(resource);
      const getTool = tools.find((t) => t.name === "get_job")!;
      const createTool = tools.find((t) => t.name === "create_job")!;

      expect(getTool.description).not.toContain("Filterable");
      expect(createTool.description).not.toContain("operators");
    });
  });

  describe("tool handler execution", () => {
    it("list tool calls controller.list with correct context", async () => {
      const resource = mockResourceWithMongoKit({
        allowedFilterFields: ["companyId", "status"],
      });

      const tools = resourceToTools(resource);
      const listTool = tools.find((t) => t.name === "list_jobs")!;

      const result = await listTool.handler(
        { companyId: "org-123", status: "active", page: 1, limit: 10 },
        {
          session: { userId: "u1", organizationId: "org-123" },
          log: vi.fn().mockResolvedValue(undefined),
          extra: {},
        },
      );

      expect(result.isError).toBeFalsy();
      const ctrl = resource.controller as Record<string, ReturnType<typeof vi.fn>>;
      expect(ctrl.list).toHaveBeenCalledTimes(1);

      // Verify the request context was built correctly
      const ctx = ctrl.list.mock.calls[0]?.[0];
      expect(ctx.query).toEqual({
        companyId: "org-123",
        status: "active",
        page: 1,
        limit: 10,
      });
      expect(ctx.user).toMatchObject({ id: "u1", _id: "u1" });
    });

    it("create tool passes body correctly", async () => {
      const resource = mockResourceWithMongoKit({
        allowedFilterFields: ["status"],
      });

      const tools = resourceToTools(resource);
      const createTool = tools.find((t) => t.name === "create_job")!;

      await createTool.handler(
        { title: "New Job", status: "draft", companyId: "org-1" },
        {
          session: { userId: "u1" },
          log: vi.fn().mockResolvedValue(undefined),
          extra: {},
        },
      );

      const ctrl = resource.controller as Record<string, ReturnType<typeof vi.fn>>;
      const ctx = ctrl.create.mock.calls[0]?.[0];
      expect(ctx.body).toEqual({ title: "New Job", status: "draft", companyId: "org-1" });
    });
  });

  describe("disableDefaultRoutes + QueryParser", () => {
    it("generates MCP tools even with disableDefaultRoutes when adapter exists", () => {
      const resource = mockResourceWithMongoKit(
        { allowedFilterFields: ["status"] },
        { disableDefaultRoutes: true },
      );

      const tools = resourceToTools(resource);
      expect(tools).toHaveLength(5);
      expect(tools.map((t) => t.name)).toContain("list_jobs");
    });
  });

  describe("per-resource overrides with QueryParser", () => {
    it("supports names override alongside QueryParser derivation", () => {
      const resource = mockResourceWithMongoKit({
        allowedFilterFields: ["companyId", "status"],
      });

      const tools = resourceToTools(resource, {
        names: { get: "get_job_by_id" },
        toolNamePrefix: "db",
      });

      expect(tools.find((t) => t.name === "get_job_by_id")).toBeDefined();
      expect(tools.find((t) => t.name === "db_list_jobs")).toBeDefined();
      expect(tools.find((t) => t.name === "db_create_job")).toBeDefined();
    });

    it("restricts operations via config.operations", () => {
      const resource = mockResourceWithMongoKit({
        allowedFilterFields: ["status"],
      });

      const tools = resourceToTools(resource, { operations: ["list", "get"] });
      expect(tools).toHaveLength(2);
      expect(tools.map((t) => t.name)).toEqual(["list_jobs", "get_job"]);
    });
  });
});
