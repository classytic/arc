/**
 * Regression: MCP `evaluatePermission` must populate `request.scope` on the
 * fake request so scope-reading permission helpers see the resolved scope.
 *
 * Before the fix:
 *   - `evaluatePermission` constructed a `fakeRequest` for the permission
 *     check call with `user`, `headers`, `params`, `query`, `body` only.
 *   - Permission helpers like `requireOrgMembership()` read from
 *     `request.scope` via `getRequestScope(req) = req.scope ?? PUBLIC_SCOPE`.
 *   - With `scope` absent on the fake request, `requireOrgMembership()` saw
 *     `{ kind: "public" }` and rejected with "Organization membership required"
 *     even when the MCP session carried `organizationId`.
 *
 * After the fix:
 *   - `evaluatePermission` calls `buildScope(session)` (now exported from
 *     `buildRequestContext`) and threads the resolved scope through BOTH
 *     `request.scope` AND `request.metadata._scope`.
 *   - This matches what HTTP paths do (auth adapter sets `request.scope`;
 *     `applyAuthorizationDecision` then mirrors to `metadata._scope`).
 *
 * This file pins both bug surfaces independently.
 */
import { describe, expect, it, vi } from "vitest";
import type { ResourceDefinition } from "../../../src/core/defineResource.js";
import { resourceToTools } from "../../../src/integrations/mcp/resourceToTools.js";
import type {
  McpAuthResult,
  ToolContext,
  ToolDefinition,
} from "../../../src/integrations/mcp/types.js";
import { requireOrgMembership, requireOrgRole } from "../../../src/permissions/scope.js";
import type { IRequestContext } from "../../../src/types/index.js";

function makeRecordingController() {
  const calls: { op: string; req: IRequestContext }[] = [];
  const record = (op: string) => async (req: IRequestContext) => {
    calls.push({ op, req });
    return { success: true, data: { _id: "1", name: "stub" } };
  };
  return {
    calls,
    controller: {
      list: vi.fn(record("list")),
      get: vi.fn(record("get")),
      create: vi.fn(record("create")),
      update: vi.fn(record("update")),
      delete: vi.fn(record("delete")),
    },
  };
}

function makeResource(
  permissions: ResourceDefinition["permissions"],
  controller: ReturnType<typeof makeRecordingController>["controller"],
): ResourceDefinition {
  return {
    name: "job",
    displayName: "Job",
    tag: "Job",
    prefix: "/jobs",
    controller,
    schemaOptions: {
      fieldRules: { title: { type: "string", required: true } },
      filterableFields: [],
      hiddenFields: [],
      readonlyFields: [],
    },
    permissions,
    routes: [],
    middlewares: {},
    disableDefaultRoutes: false,
    disabledRoutes: [],
    customSchemas: {},
    events: {},
    _appliedPresets: [],
    _pendingHooks: [],
  } as unknown as ResourceDefinition;
}

function toolCtx(session: McpAuthResult | null): ToolContext {
  return { session, log: async () => {}, extra: {} };
}

function findTool(tools: ToolDefinition[], name: string): ToolDefinition {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`tool ${name} not found`);
  return tool;
}

const memberSession: McpAuthResult = {
  userId: "u-1",
  organizationId: "org-acme",
  orgRoles: ["admin"],
  roles: [],
};

describe("MCP evaluatePermission — request.scope is populated for scope-reading checks", () => {
  it("passes requireOrgMembership when the MCP session has organizationId", async () => {
    const { calls, controller } = makeRecordingController();
    const resource = makeResource(
      {
        list: requireOrgMembership(),
        get: requireOrgMembership(),
        create: requireOrgMembership(),
        update: requireOrgMembership(),
        delete: requireOrgMembership(),
      },
      controller,
    );

    const tools = resourceToTools(resource);
    const result = await findTool(tools, "list_jobs").handler({}, toolCtx(memberSession));

    // Before fix: `result.isError` was true with "Organization membership required".
    expect(result.isError).toBeFalsy();
    expect(calls).toHaveLength(1);
  });

  it("rejects requireOrgMembership when the MCP session is anonymous (no false positives)", async () => {
    const { calls, controller } = makeRecordingController();
    const resource = makeResource(
      {
        list: requireOrgMembership(),
        get: requireOrgMembership(),
        create: requireOrgMembership(),
        update: requireOrgMembership(),
        delete: requireOrgMembership(),
      },
      controller,
    );

    const tools = resourceToTools(resource);
    const result = await findTool(tools, "list_jobs").handler({}, toolCtx(null));

    // Public session → still rejected (the fix doesn't flip the gate open).
    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("passes requireOrgRole when the MCP session carries matching orgRoles", async () => {
    const { calls, controller } = makeRecordingController();
    const resource = makeResource(
      {
        list: requireOrgRole(["admin"]),
        get: requireOrgRole(["admin"]),
        create: requireOrgRole(["admin"]),
        update: requireOrgRole(["admin"]),
        delete: requireOrgRole(["admin"]),
      },
      controller,
    );

    const tools = resourceToTools(resource);
    const result = await findTool(tools, "list_jobs").handler({}, toolCtx(memberSession));

    expect(result.isError).toBeFalsy();
    expect(calls).toHaveLength(1);
  });

  it("rejects requireOrgRole when the session has no matching orgRoles", async () => {
    const { calls, controller } = makeRecordingController();
    const resource = makeResource(
      {
        list: requireOrgRole(["admin"]),
        get: requireOrgRole(["admin"]),
        create: requireOrgRole(["admin"]),
        update: requireOrgRole(["admin"]),
        delete: requireOrgRole(["admin"]),
      },
      controller,
    );

    const viewerSession: McpAuthResult = {
      userId: "u-2",
      organizationId: "org-acme",
      orgRoles: ["viewer"], // not admin
      roles: [],
    };

    const tools = resourceToTools(resource);
    const result = await findTool(tools, "list_jobs").handler({}, toolCtx(viewerSession));

    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });
});

describe("buildScope — exported for cross-module reuse", () => {
  it("is importable from `integrations/mcp/buildRequestContext`", async () => {
    // Bare import-of-named-export pin: TS compile passes only if the export exists.
    const mod = await import("../../../src/integrations/mcp/buildRequestContext.js");
    expect(typeof mod.buildScope).toBe("function");
  });

  it("returns a `member` scope for an MCP session with organizationId", async () => {
    const { buildScope } = await import("../../../src/integrations/mcp/buildRequestContext.js");
    const scope = buildScope({
      userId: "u-1",
      organizationId: "org-1",
      orgRoles: ["admin"],
      roles: [],
    });
    expect(scope.kind).toBe("member");
    if (scope.kind === "member") {
      expect(scope.organizationId).toBe("org-1");
      expect(scope.orgRoles).toEqual(["admin"]);
    }
  });

  it("returns a `public` scope for null auth", async () => {
    const { buildScope } = await import("../../../src/integrations/mcp/buildRequestContext.js");
    expect(buildScope(null)).toEqual({ kind: "public" });
  });
});
