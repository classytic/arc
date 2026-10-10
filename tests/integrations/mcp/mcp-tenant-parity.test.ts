import { describe, expect, it, vi } from "vitest";
import { defineAggregation } from "../../../src/core/aggregation/defineAggregation.js";
import { defineResource } from "../../../src/core/defineResource.js";
import { resourceToTools } from "../../../src/integrations/mcp/resourceToTools.js";
import type { McpAuthResult, ToolContext } from "../../../src/integrations/mcp/types.js";
import { authenticated } from "../../../src/permissions/presets.js";
import { multiTenantPreset } from "../../../src/presets/multiTenant.js";
import type { ResourceConfig } from "../../../src/types/index.js";

function fixture(
  options: Parameters<typeof multiTenantPreset>[0] = {},
  config: Partial<ResourceConfig> = {},
) {
  const repo = {
    getAll: vi.fn(async () => []),
    getById: vi.fn(async () => null),
    create: vi.fn(async (data: unknown) => data),
    update: vi.fn(),
    delete: vi.fn(),
    aggregate: vi.fn(async () => ({ rows: [] })),
  };
  const resource = defineResource({
    name: "task",
    adapter: { repository: repo },
    permissions: authenticated(),
    presets: [multiTenantPreset(options)],
    ...config,
  });
  const tools = resourceToTools(resource);
  const call = (name: string, input: Record<string, unknown>, session: McpAuthResult) => {
    const tool = tools.find((candidate) => candidate.name === name);
    if (!tool) throw new Error(`Missing ${name}`);
    return tool.handler(input, { session, log: async () => {}, extra: {} } satisfies ToolContext);
  };
  return { repo, call };
}

describe("MCP tenant preset parity", () => {
  const dimensions = [
    { field: "organizationId", type: "org" as const },
    { field: "branchId", contextKey: "branchId" },
  ];
  it("enforces every tenant dimension on repository reads", async () => {
    const { repo, call } = fixture({ tenantFields: dimensions });
    await call(
      "list_tasks",
      {},
      { userId: "u1", organizationId: "org-a", context: { branchId: "branch-a" } },
    );
    expect(repo.getAll).toHaveBeenCalledWith(
      expect.objectContaining({
        filters: { organizationId: "org-a", branchId: "branch-a" },
        branchId: "branch-a",
      }),
    );
  });
  it("refuses missing dimensions before reaching the repository", async () => {
    const { repo, call } = fixture({ tenantFields: dimensions });
    const result = await call("list_tasks", {}, { userId: "u1", organizationId: "org-a" });
    expect(result.isError).toBe(true);
    expect(JSON.parse(String(result.content[0]?.text))).toMatchObject({
      status: 403,
      message: expect.stringContaining("branchId"),
    });
    expect(repo.getAll).not.toHaveBeenCalled();
  });
  it("refuses authenticated callers without an organization", async () => {
    const { repo, call } = fixture();
    const result = await call("list_tasks", {}, { userId: "u1" });
    expect(result.isError).toBe(true);
    expect(repo.getAll).not.toHaveBeenCalled();
  });
  it("honors declared cross-tenant reads", async () => {
    const { repo, call } = fixture({ crossTenant: ["list"] });
    await call("list_tasks", {}, { userId: "u1", organizationId: "org-a" });
    expect(repo.getAll).toHaveBeenCalledWith(
      expect.objectContaining({ filters: {}, bypassTenant: true }),
    );
  });
  it("restores all trusted tenant dimensions after create sanitization", async () => {
    const { repo, call } = fixture({ tenantFields: dimensions });
    await call(
      "create_task",
      { title: "new" },
      { userId: "u1", organizationId: "org-a", context: { branchId: "branch-a" } },
    );
    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: "org-a", branchId: "branch-a" }),
      expect.anything(),
    );
  });
  it("refuses missing tenant dimensions on id-less actions", async () => {
    const handler = vi.fn(async () => ({ done: true }));
    const { call } = fixture(
      { tenantFields: dimensions },
      { actions: { process: { id: false, handler } } },
    );
    const result = await call("process_task", {}, { userId: "u1", organizationId: "org-a" });
    expect(result.isError).toBe(true);
    expect(JSON.parse(String(result.content[0]?.text))).toMatchObject({ status: 403 });
    expect(handler).not.toHaveBeenCalled();
  });
  it("prepares every tenant dimension on opted-in custom routes", async () => {
    const handler = vi.fn(async (ctx: { metadata?: unknown }) => ({ data: ctx.metadata }));
    const { call } = fixture(
      { tenantFields: dimensions },
      {
        routes: [
          {
            method: "POST",
            path: "/inspect",
            operation: "inspect",
            tenantScope: true,
            permissions: authenticated().create,
            handler,
          },
        ],
      },
    );
    const result = await call(
      "inspect_task",
      {},
      { userId: "u1", organizationId: "org-a", context: { branchId: "branch-a" } },
    );
    expect(result.isError).toBeFalsy();
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          _policyFilters: { organizationId: "org-a", branchId: "branch-a" },
        }),
      }),
    );
  });
  it("enforces tenant dimensions on aggregation reads and refuses incomplete scope", async () => {
    const { repo, call } = fixture(
      { tenantFields: dimensions },
      {
        aggregations: {
          totals: defineAggregation({
            measures: { count: "count" },
            permissions: authenticated().list,
          }),
        },
      },
    );
    const missing = await call(
      "aggregation_totals_task",
      {},
      { userId: "u1", organizationId: "org-a" },
    );
    expect(missing.isError).toBe(true);
    expect(repo.aggregate).not.toHaveBeenCalled();
    const allowed = await call(
      "aggregation_totals_task",
      {},
      { userId: "u1", organizationId: "org-a", context: { branchId: "branch-a" } },
    );
    expect(allowed.isError).toBeFalsy();
    expect(repo.aggregate).toHaveBeenCalledWith(
      expect.objectContaining({ filter: expect.objectContaining({ branchId: "branch-a" }) }),
      expect.objectContaining({ organizationId: "org-a", branchId: "branch-a" }),
    );
  });
});
