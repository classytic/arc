/**
 * MCP parity tests — v2.8.1 action + route metadata
 *
 * Verifies:
 * 1. `resource.actions` → MCP tools (naming, input schema, permissions, handler)
 * 2. `mcp: false` on routes → route skipped in MCP tool generation
 * 3. `mcp: { description, annotations }` on routes → overrides in generated tools
 * 4. `mcp: false` on individual actions → action skipped
 * 5. Action tool handler calls the action function with correct (id, data, req)
 * 6. Action tool permission check works (denied → isError response)
 */

import { describe, expect, it, vi } from "vitest";
import type { ResourceDefinition } from "../../../src/core/defineResource.js";
import { resourceToTools } from "../../../src/integrations/mcp/resourceToTools.js";
import type { ToolDefinition } from "../../../src/integrations/mcp/types.js";
import { allowPublic } from "../../../src/permissions/index.js";
import type { PermissionCheck } from "../../../src/types/index.js";

function denied(): PermissionCheck {
  const fn = (() => ({ granted: false, reason: "nope" })) as PermissionCheck;
  return fn;
}

function makeResourceWithActions(overrides: Partial<ResourceDefinition> = {}): ResourceDefinition {
  const base: Partial<ResourceDefinition> = {
    name: "order",
    displayName: "Orders",
    prefix: "/orders",
    disabledRoutes: [],
    disableDefaultRoutes: true,
    schemaOptions: {},
    permissions: {},
    routes: [],
    _appliedPresets: [],
    actions: {
      approve: async (id: string) => ({ id, status: "approved" }),
      dispatch: {
        handler: async (id: string, data: Record<string, unknown>) => ({
          id,
          carrier: data.carrier,
        }),
        permissions: allowPublic(),
        schema: {
          type: "object",
          properties: { carrier: { type: "string" } },
        },
        description: "Dispatch the order",
      },
      hidden: {
        handler: async (id: string) => ({ id }),
        mcp: false,
      },
    },
    actionPermissions: allowPublic(),
  };
  return { ...base, ...overrides } as unknown as ResourceDefinition;
}

// ============================================================================
// 1. Actions → MCP tools
// ============================================================================

describe("MCP: actions → tool generation", () => {
  it("generates one tool per action (except mcp: false)", () => {
    const resource = makeResourceWithActions();
    const tools = resourceToTools(resource);

    const names = tools.map((t) => t.name);
    expect(names).toContain("approve_order");
    expect(names).toContain("dispatch_order");
    // mcp: false → skipped
    expect(names).not.toContain("hidden_order");
  });

  it("action tool has id in input schema", () => {
    const resource = makeResourceWithActions();
    const tools = resourceToTools(resource);
    const approveTool = tools.find((t) => t.name === "approve_order");

    expect(approveTool).toBeDefined();
    expect(approveTool?.inputSchema?.id).toBeDefined();
  });

  it("action tool with schema has action-specific fields in input", () => {
    const resource = makeResourceWithActions();
    const tools = resourceToTools(resource);
    const dispatchTool = tools.find((t) => t.name === "dispatch_order");

    expect(dispatchTool).toBeDefined();
    expect(dispatchTool?.inputSchema?.id).toBeDefined();
    expect(dispatchTool?.inputSchema?.carrier).toBeDefined();
  });

  it("action tool uses description from ActionDefinition", () => {
    const resource = makeResourceWithActions();
    const tools = resourceToTools(resource);
    const dispatchTool = tools.find((t) => t.name === "dispatch_order");

    expect(dispatchTool?.description).toBe("Dispatch the order");
  });

  it("action tool has destructiveHint by default", () => {
    const resource = makeResourceWithActions();
    const tools = resourceToTools(resource);
    const approveTool = tools.find((t) => t.name === "approve_order");

    expect(approveTool?.annotations?.destructiveHint).toBe(true);
  });

  it("action tool respects toolNamePrefix", () => {
    const resource = makeResourceWithActions();
    const tools = resourceToTools(resource, { toolNamePrefix: "myapp" });

    const names = tools.map((t) => t.name);
    expect(names).toContain("myapp_approve_order");
    expect(names).toContain("myapp_dispatch_order");
  });
});

// ============================================================================
// 2. Action tool handler — calls function with correct args
// ============================================================================

describe("MCP: action tool handler execution", () => {
  it("passes id and data to action handler", async () => {
    const handlerSpy = vi.fn(async (id: string, data: Record<string, unknown>) => ({
      id,
      ...data,
    }));

    const resource = makeResourceWithActions({
      actions: {
        process: {
          handler: handlerSpy,
          permissions: allowPublic(),
        },
      },
    });

    const tools = resourceToTools(resource);
    const tool = tools.find((t) => t.name === "process_order") as ToolDefinition;
    expect(tool).toBeDefined();

    const result = await tool.handler(
      { id: "order-123", amount: 500 },
      { session: null, log: async () => {}, extra: {} },
    );

    expect(handlerSpy).toHaveBeenCalledTimes(1);
    const [receivedId, receivedData] = handlerSpy.mock.calls[0] ?? [];
    expect(receivedId).toBe("order-123");
    expect(receivedData).toMatchObject({ amount: 500 });
    // id should NOT be in data
    expect(receivedData).not.toHaveProperty("id");

    // Result should be success
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content.find((c) => c.type === "text")?.text ?? "{}");
    expect(parsed.success).toBe(true);
  });

  it("permission denied returns isError response", async () => {
    const resource = makeResourceWithActions({
      actions: {
        secret: {
          handler: async () => ({}),
          permissions: denied(),
        },
      },
    });

    const tools = resourceToTools(resource);
    const tool = tools.find((t) => t.name === "secret_order") as ToolDefinition;

    const result = await tool.handler(
      { id: "123" },
      { session: null, log: async () => {}, extra: {} },
    );

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content.find((c) => c.type === "text")?.text ?? "{}");
    expect(parsed.success).toBe(false);
    expect(parsed.error).toBe("nope");
  });

  it("handler error returns isError response", async () => {
    const resource = makeResourceWithActions({
      actions: {
        boom: async () => {
          throw new Error("kaboom");
        },
      },
      actionPermissions: allowPublic(),
    });

    const tools = resourceToTools(resource);
    const tool = tools.find((t) => t.name === "boom_order") as ToolDefinition;

    const result = await tool.handler(
      { id: "123" },
      { session: null, log: async () => {}, extra: {} },
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("kaboom");
  });
});

// ============================================================================
// 3. Route-level mcp config
// ============================================================================

describe("MCP: route-level mcp metadata", () => {
  // Route tools require a controller — provide a minimal mock
  const mockController = { list: async () => ({}) } as unknown;

  it("mcp: false skips the route for MCP tool generation", () => {
    const resource = makeResourceWithActions({
      actions: undefined,
      controller: mockController,
      routes: [
        {
          method: "GET",
          path: "/stats",
          handler: async () => ({ stats: true }),
          permissions: allowPublic(),
          mcp: false,
        },
        {
          method: "POST",
          path: "/export",
          handler: async () => ({ exported: true }),
          permissions: allowPublic(),
        },
      ],
    });

    const tools = resourceToTools(resource);
    const names = tools.map((t) => t.name);

    expect(names).not.toContain("get_stats_order");
    expect(names.some((n) => n.includes("export"))).toBe(true);
  });

  it("mcp: { description, annotations } overrides defaults", () => {
    const resource = makeResourceWithActions({
      actions: undefined,
      controller: mockController,
      routes: [
        {
          method: "POST",
          path: "/trigger",
          handler: async () => ({ ok: true }),
          permissions: allowPublic(),
          mcp: {
            description: "Trigger the pipeline",
            annotations: { readOnlyHint: false, destructiveHint: true },
          },
        },
      ],
    });

    const tools = resourceToTools(resource);
    const tool = tools.find((t) => t.name.includes("trigger"));

    expect(tool?.description).toBe("Trigger the pipeline");
    expect(tool?.annotations?.destructiveHint).toBe(true);
    expect(tool?.annotations?.readOnlyHint).toBe(false);
  });
});

// ============================================================================
// 4. Bug fix validation — scope shape + permission side effects + OpenAPI auth fallback
// ============================================================================

describe("MCP: action tool uses buildRequestContext (shared with CRUD tools)", () => {
  it("passes IRequestContext with scope.kind = 'member' when session has org", async () => {
    let receivedReq: Record<string, unknown> | undefined;
    const resource = makeResourceWithActions({
      actions: {
        check: {
          handler: async (_id: string, _data: Record<string, unknown>, req: unknown) => {
            receivedReq = req as Record<string, unknown>;
            return { ok: true };
          },
          permissions: allowPublic(),
        },
      },
    });

    const tools = resourceToTools(resource);
    const tool = tools.find((t) => t.name === "check_order") as ToolDefinition;

    await tool.handler(
      { id: "123" },
      {
        session: { userId: "u1", organizationId: "org-A", roles: ["admin"] },
        log: async () => {},
        extra: {},
      },
    );

    expect(receivedReq).toBeDefined();
    // IRequestContext: scope is at metadata._scope (built by buildRequestContext)
    const metadata = receivedReq?.metadata as Record<string, unknown>;
    const scope = metadata?._scope as Record<string, unknown>;
    expect(scope.kind).toBe("member");
    expect(scope.organizationId).toBe("org-A");
    // Must NOT have old wrong discriminant
    expect(scope).not.toHaveProperty("type");
  });

  it("passes scope.kind = 'public' when session is null", async () => {
    let receivedReq: Record<string, unknown> | undefined;
    const resource = makeResourceWithActions({
      actions: {
        check: {
          handler: async (_id: string, _data: Record<string, unknown>, req: unknown) => {
            receivedReq = req as Record<string, unknown>;
            return {};
          },
          permissions: allowPublic(),
        },
      },
    });

    const tools = resourceToTools(resource);
    const tool = tools.find((t) => t.name === "check_order") as ToolDefinition;

    await tool.handler({ id: "123" }, { session: null, log: async () => {}, extra: {} });

    const metadata = receivedReq?.metadata as Record<string, unknown>;
    const scope = metadata?._scope as Record<string, unknown>;
    expect(scope?.kind).toBe("public");
  });

  it("has params.id, body with action field, and user from session", async () => {
    let receivedReq: Record<string, unknown> | undefined;
    const resource = makeResourceWithActions({
      actions: {
        inspect: {
          handler: async (_id: string, _data: Record<string, unknown>, req: unknown) => {
            receivedReq = req as Record<string, unknown>;
            return {};
          },
          permissions: allowPublic(),
        },
      },
    });

    const tools = resourceToTools(resource);
    const tool = tools.find((t) => t.name === "inspect_order") as ToolDefinition;

    await tool.handler(
      { id: "ord-99", extra: "value" },
      { session: { userId: "u1" }, log: async () => {}, extra: {} },
    );

    // Verify IRequestContext shape from buildRequestContext("action")
    expect((receivedReq?.params as Record<string, string>)?.id).toBe("ord-99");
    const body = receivedReq?.body as Record<string, unknown>;
    expect(body?.action).toBe("inspect");
    expect(body?.extra).toBe("value");
    // id should NOT be in body (destructured out by buildRequestContext)
    expect(body?.id).toBeUndefined();
    // User built from session
    const user = receivedReq?.user as Record<string, unknown>;
    expect(user?.id).toBe("u1");
  });
});

describe("MCP: action tool evaluatePermission honors scope + filters", () => {
  it("permission-derived scope overrides public session scope", async () => {
    let receivedReq: Record<string, unknown> | undefined;

    // Permission that returns a scope override — only applies when session
    // scope is public (same semantics as buildRequestContext scopeOverride)
    const enrichingPerm = (() => ({
      granted: true,
      scope: { kind: "member", tenantId: "tenant-X", organizationId: "org-perm" },
    })) as PermissionCheck;

    const resource = makeResourceWithActions({
      actions: {
        enrich: {
          handler: async (_id: string, _data: Record<string, unknown>, req: unknown) => {
            receivedReq = req as Record<string, unknown>;
            return {};
          },
          permissions: enrichingPerm,
        },
      },
    });

    const tools = resourceToTools(resource);
    const tool = tools.find((t) => t.name === "enrich_order") as ToolDefinition;

    // Null session → public scope → scopeOverride applies
    await tool.handler({ id: "123" }, { session: null, log: async () => {}, extra: {} });

    const metadata = receivedReq?.metadata as Record<string, unknown>;
    const scope = metadata?._scope as Record<string, unknown>;
    expect(scope?.kind).toBe("member");
    expect(scope?.tenantId).toBe("tenant-X");
  });

  it("permission-derived filters flow into metadata._policyFilters", async () => {
    let receivedReq: Record<string, unknown> | undefined;

    const filteringPerm = (() => ({
      granted: true,
      filters: { region: "EU" },
    })) as PermissionCheck;

    const resource = makeResourceWithActions({
      actions: {
        filtered: {
          handler: async (_id: string, _data: Record<string, unknown>, req: unknown) => {
            receivedReq = req as Record<string, unknown>;
            return {};
          },
          permissions: filteringPerm,
        },
      },
    });

    const tools = resourceToTools(resource);
    const tool = tools.find((t) => t.name === "filtered_order") as ToolDefinition;

    await tool.handler(
      { id: "123" },
      { session: { userId: "u1" }, log: async () => {}, extra: {} },
    );

    const metadata = receivedReq?.metadata as Record<string, unknown>;
    expect(metadata?._policyFilters).toEqual({ region: "EU" });
  });
});

describe("MCP: OpenAPI action auth respects actionPermissions fallback", () => {
  it("marks endpoint auth-required when fallback requires auth", async () => {
    const { buildOpenApiSpec } = await import("../../../src/docs/openapi.js");

    const requireAuth = (() => true) as PermissionCheck & { _isPublic: boolean };
    requireAuth._isPublic = false;

    const fakeResource = {
      name: "invoice",
      prefix: "/invoices",
      presets: [],
      permissions: {},
      routes: [],
      routes: [],
      actions: [{ name: "finalize" }],
      actionPermissions: requireAuth,
      plugin: () => {},
      disableDefaultRoutes: true,
      disabledRoutes: [],
    };

    const spec = buildOpenApiSpec([fakeResource], { title: "Test", version: "1.0.0" });
    const actionOp = spec.paths["/invoices/{id}/action"]?.post;

    expect(actionOp).toBeDefined();
    expect(actionOp?.security?.length).toBeGreaterThan(0);
  });

  it("marks endpoint public when both per-action and fallback are public", async () => {
    const { buildOpenApiSpec } = await import("../../../src/docs/openapi.js");

    const fakeResource = {
      name: "widget",
      prefix: "/widgets",
      presets: [],
      permissions: {},
      routes: [],
      routes: [],
      actions: [{ name: "toggle", permissions: allowPublic() }],
      actionPermissions: allowPublic(),
      plugin: () => {},
      disableDefaultRoutes: true,
      disabledRoutes: [],
    };

    const spec = buildOpenApiSpec([fakeResource], { title: "Test", version: "1.0.0" });
    const actionOp = spec.paths["/widgets/{id}/action"]?.post;

    expect(actionOp).toBeDefined();
    expect(actionOp?.security ?? []).toEqual([]);
  });
});
