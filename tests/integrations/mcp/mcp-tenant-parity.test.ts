import { describe, expect, it, vi } from "vitest";
import { defineResource } from "../../../src/core/defineResource.js";
import { resourceToTools } from "../../../src/integrations/mcp/resourceToTools.js";
import type { McpAuthResult, ToolContext } from "../../../src/integrations/mcp/types.js";
import { authenticated } from "../../../src/permissions/presets.js";
import { multiTenantPreset } from "../../../src/presets/multiTenant.js";

function fixture(options: Parameters<typeof multiTenantPreset>[0] = {}) {
  const repo = {
    getAll: vi.fn(async () => []),
    getById: vi.fn(async () => null),
    create: vi.fn(async (data: unknown) => data),
    update: vi.fn(),
    delete: vi.fn(),
  };
  const resource = defineResource({
    name: "task",
    adapter: { repository: repo },
    permissions: authenticated(),
    presets: [multiTenantPreset(options)],
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
});
