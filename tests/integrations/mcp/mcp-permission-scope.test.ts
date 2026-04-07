/**
 * Regression: MCP tool handlers must honor PermissionResult.scope.
 *
 * Before the fix, `evaluatePermission` in resourceToTools.ts only extracted
 * `filters` from the PermissionResult and silently dropped `scope`. That
 * meant a permission check returning `{ granted: true, scope: serviceScope }`
 * would reach the controller with `metadata._scope === { kind: "public" }`,
 * and tenant isolation was silently bypassed.
 *
 * Now `evaluatePermission` returns the full normalized PermissionResult and
 * `buildRequestContext` honors the scope override (with the same non-downgrade
 * rule as `applyPermissionResult`). This test pins that contract.
 */

import { describe, expect, it, vi } from "vitest";
import type { ResourceDefinition } from "../../../src/core/defineResource.js";
import { resourceToTools } from "../../../src/integrations/mcp/resourceToTools.js";
import type {
  McpAuthResult,
  ToolContext,
  ToolDefinition,
} from "../../../src/integrations/mcp/types.js";
import type { PermissionCheck } from "../../../src/permissions/types.js";
import type { RequestScope } from "../../../src/scope/types.js";
import type { ArcInternalMetadata, IRequestContext } from "../../../src/types/index.js";

// Controller stub that records every IRequestContext it sees so we can
// assert what metadata._scope and _policyFilters looked like at call time.
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
      fieldRules: {
        title: { type: "string", required: true },
      },
      filterableFields: [],
      hiddenFields: [],
      readonlyFields: [],
    },
    permissions,
    additionalRoutes: [],
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
  return {
    session,
    log: async () => {},
    extra: {},
  };
}

function metadataOf(req: IRequestContext): ArcInternalMetadata {
  return req.metadata as ArcInternalMetadata;
}

function findTool(tools: ToolDefinition[], name: string): ToolDefinition {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`tool ${name} not found`);
  return tool;
}

const SERVICE_SCOPE: RequestScope = {
  kind: "service",
  clientId: "client-abc",
  organizationId: "org-acme",
  scopes: ["jobs:write"],
};

describe("MCP resourceToTools — PermissionResult.scope propagation", () => {
  it("installs scope from permission result when MCP session is anonymous", async () => {
    const { calls, controller } = makeRecordingController();

    const requireApiKey: PermissionCheck = async () => ({
      granted: true,
      scope: SERVICE_SCOPE,
      filters: { projectId: "proj-1" },
    });

    const resource = makeResource(
      {
        list: requireApiKey,
        get: requireApiKey,
        create: requireApiKey,
        update: requireApiKey,
        delete: requireApiKey,
      },
      controller,
    );

    const tools = resourceToTools(resource);
    const listTool = findTool(tools, "list_jobs");

    // Session is null (MCP called with auth: false) — the permission check
    // should install the service scope itself.
    const result = await listTool.handler({}, toolCtx(null));
    expect(result.isError).toBeFalsy();
    expect(calls).toHaveLength(1);

    const meta = metadataOf(calls[0]?.req);
    expect(meta._scope).toEqual(SERVICE_SCOPE);
    expect(meta._policyFilters).toEqual({ projectId: "proj-1" });
  });

  it("installs scope for get operations as well", async () => {
    const { calls, controller } = makeRecordingController();
    const check: PermissionCheck = async () => ({
      granted: true,
      scope: SERVICE_SCOPE,
    });

    const resource = makeResource(
      {
        list: check,
        get: check,
        create: check,
        update: check,
        delete: check,
      },
      controller,
    );

    const getTool = findTool(resourceToTools(resource), "get_job");
    await getTool.handler({ id: "job-1" }, toolCtx(null));

    expect(calls[0]?.op).toBe("get");
    const meta = metadataOf(calls[0]?.req);
    expect(meta._scope).toEqual(SERVICE_SCOPE);
  });

  it("does NOT downgrade an existing session scope (session wins over permission scope)", async () => {
    const { calls, controller } = makeRecordingController();

    const existingSession: McpAuthResult = {
      userId: "user-1",
      organizationId: "org-session",
      roles: ["user"],
    };

    const check: PermissionCheck = async () => ({
      granted: true,
      // This would try to install a narrower scope, but the existing
      // session-derived scope must win (it came from a more authoritative source).
      scope: {
        kind: "service",
        clientId: "client-never",
        organizationId: "org-never",
      },
    });

    const resource = makeResource(
      {
        list: check,
        get: check,
        create: check,
        update: check,
        delete: check,
      },
      controller,
    );

    const listTool = findTool(resourceToTools(resource), "list_jobs");
    await listTool.handler({}, toolCtx(existingSession));

    const meta = metadataOf(calls[0]?.req);
    // Session-derived scope = member (has orgId) — stays intact.
    expect(meta._scope?.kind).toBe("member");
    if (meta._scope?.kind === "member") {
      expect(meta._scope.organizationId).toBe("org-session");
    }
  });

  it("returns permission-denied response when check rejects", async () => {
    const { calls, controller } = makeRecordingController();
    const check: PermissionCheck = async () => ({
      granted: false,
      reason: "Invalid API key",
    });

    const resource = makeResource(
      {
        list: check,
        get: check,
        create: check,
        update: check,
        delete: check,
      },
      controller,
    );

    const listTool = findTool(resourceToTools(resource), "list_jobs");
    const result = await listTool.handler({}, toolCtx(null));

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Permission denied");
    expect(result.content[0]?.text).toContain("Invalid API key");
    expect(calls).toHaveLength(0); // Handler MUST NOT run
  });

  it("propagates filters even when no scope is provided", async () => {
    const { calls, controller } = makeRecordingController();
    const check: PermissionCheck = async () => ({
      granted: true,
      filters: { ownerId: "u1" },
    });

    const resource = makeResource(
      {
        list: check,
        get: check,
        create: check,
        update: check,
        delete: check,
      },
      controller,
    );

    const listTool = findTool(resourceToTools(resource), "list_jobs");
    await listTool.handler({}, toolCtx(null));

    const meta = metadataOf(calls[0]?.req);
    expect(meta._policyFilters).toEqual({ ownerId: "u1" });
    // No scope returned → fall back to session-derived scope (public here)
    expect(meta._scope?.kind).toBe("public");
  });
});
