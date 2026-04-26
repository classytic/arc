/**
 * Regression: MCP action tools must inherit the HTTP `permissions.update`
 * fallback. Without this, `actions: { approve: fn }` + `permissions.update:
 * requireAuth()` was protected via REST but bypassed via the MCP surface
 * because `resourceToTools` only looked at per-action `permissions` and
 * `resource.actionPermissions`.
 *
 * Related: `src/core/actionPermissions.ts` (shared resolver) and the HTTP
 * fallback in `normalizeActionsToRouterConfig`.
 */

import { describe, expect, it } from "vitest";
import type { ResourceDefinition } from "../../../src/core/defineResource.js";
import { resourceToTools } from "../../../src/integrations/mcp/resourceToTools.js";
import type { ToolDefinition } from "../../../src/integrations/mcp/types.js";
import { allowPublic, requireAuth } from "../../../src/permissions/index.js";

function build(
  actions: ResourceDefinition["actions"],
  permissions: ResourceDefinition["permissions"] = {},
  actionPermissions?: ResourceDefinition["actionPermissions"],
): ResourceDefinition {
  return {
    name: "order",
    displayName: "Orders",
    prefix: "/orders",
    disabledRoutes: [],
    disableDefaultRoutes: true,
    schemaOptions: {},
    permissions,
    actionPermissions,
    actions,
    routes: [],
    _appliedPresets: [],
  } as unknown as ResourceDefinition;
}

async function invoke(tool: ToolDefinition): Promise<unknown> {
  return await tool.handler({ id: "doc-1" }, {
    session: null,
    request: undefined as never,
  } as never);
}

describe("MCP: action permission fallback chain parity with HTTP", () => {
  it("function-shorthand action inherits resource.permissions.update when no per-action gate", async () => {
    // Scenario the reviewer called out: REST is protected via the update
    // fallback, MCP must be too.
    const resource = build(
      { approve: async (id: string) => ({ id, status: "approved" }) },
      { update: requireAuth() },
    );

    const tools = resourceToTools(resource);
    const tool = tools.find((t) => t.name === "approve_order");
    expect(tool).toBeDefined();

    // No session → requireAuth() denies. Before the fix, `evaluatePermission`
    // got `undefined` and treated it as allow (silent bypass).
    const result = (await invoke(tool!)) as { isError?: boolean };
    expect(result.isError).toBe(true);
  });

  it("per-action permission still wins over the update fallback", async () => {
    const resource = build(
      {
        approve: {
          handler: async (id: string) => ({ id }),
          permissions: allowPublic(),
        },
      },
      { update: requireAuth() },
    );
    const tools = resourceToTools(resource);
    const tool = tools.find((t) => t.name === "approve_order")!;
    const result = (await invoke(tool)) as { isError?: boolean };
    expect(result.isError).not.toBe(true);
  });

  it("resource.actionPermissions still wins over the update fallback", async () => {
    const resource = build(
      { approve: async (id: string) => ({ id }) },
      { update: requireAuth() },
      allowPublic(),
    );
    const tools = resourceToTools(resource);
    const tool = tools.find((t) => t.name === "approve_order")!;
    const result = (await invoke(tool)) as { isError?: boolean };
    expect(result.isError).not.toBe(true);
  });

  it("throws when no gate exists at any level (parity with HTTP boot-time throw)", () => {
    // HTTP fails closed in normalizeActionsToRouterConfig at boot. That
    // throw lives inside the resource's register() plugin lifecycle, so a
    // host calling resourceToTools() directly (or registering mcpPlugin
    // with resources whose HTTP plugin never runs) would otherwise expose
    // an unauthenticated mutating tool. MCP must mirror the HTTP error.
    const resource = build(
      { approve: async (id: string) => ({ id }) },
      {}, // no permissions.update
      undefined, // no resource.actionPermissions
    );

    expect(() => resourceToTools(resource)).toThrow(
      /action 'approve' has no permission gate.*allowPublic\(\).*genuinely want the action unauthenticated/s,
    );
  });
});
