/**
 * MCP field-read masking parity.
 *
 * The HTTP wire masks responses through `sendControllerResponse`
 * (`applyFieldReadPermissions` + elevated-scope bypass + effective-role
 * union), and the realtime plugin masks every SSE frame the same way.
 * Before this suite's feature landed, MCP tools serialized controller
 * output RAW — `fields: { salary: fields.visibleTo(['admin']) }` masked
 * salary over REST and SSE but leaked it verbatim through `get_user` /
 * `list_users` MCP tools. These tests pin REST ↔ MCP parity for the
 * read-masking policy step across all four tool families.
 */

import { describe, expect, it, vi } from "vitest";
import type { ResourceDefinition } from "../../../src/core/defineResource.js";
import { fields } from "../../../src/permissions/fields.js";
import { resourceToTools } from "../../../src/integrations/mcp/resourceToTools.js";
import { applyMcpReadMasking } from "../../../src/integrations/mcp/tool-helpers.js";
import type { CallToolResult, McpAuthResult } from "../../../src/integrations/mcp/types.js";

const FIELD_PERMS = {
  password: fields.hidden(),
  salary: fields.visibleTo(["admin"]),
  email: fields.redactFor(["viewer"]),
};

const DOC = {
  _id: "u1",
  name: "Ada",
  email: "ada@example.com",
  salary: 90_000,
  password: "hash",
};

function mockResource(overrides?: Partial<ResourceDefinition>): ResourceDefinition {
  return {
    name: "user",
    displayName: "User",
    tag: "User",
    prefix: "/users",
    controller: {
      list: vi.fn().mockResolvedValue({ data: [{ ...DOC }, { ...DOC, _id: "u2" }] }),
      get: vi.fn().mockResolvedValue({ data: { ...DOC } }),
      create: vi.fn().mockResolvedValue({ data: { ...DOC } }),
      update: vi.fn().mockResolvedValue({ data: { ...DOC } }),
      delete: vi.fn().mockResolvedValue({ data: { ok: true } }),
    },
    fields: FIELD_PERMS,
    schemaOptions: {},
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

function session(overrides?: Partial<McpAuthResult>): McpAuthResult {
  return { userId: "u1", roles: [], ...overrides } as McpAuthResult;
}

function parse(result: CallToolResult): unknown {
  const text = (result.content[0] as { text: string }).text;
  return JSON.parse(text);
}

async function callTool(
  resource: ResourceDefinition,
  toolName: string,
  input: Record<string, unknown>,
  auth: McpAuthResult | null,
): Promise<unknown> {
  const tools = resourceToTools(resource);
  const tool = tools.find((t) => t.name === toolName);
  if (!tool) throw new Error(`tool ${toolName} not generated`);
  // biome-ignore lint/suspicious/noExplicitAny: minimal ToolContext for direct handler invocation
  const result = await tool.handler(input, { session: auth } as any);
  expect(result.isError).not.toBe(true);
  return parse(result);
}

describe("MCP field-read masking — CRUD tools", () => {
  it("strips hidden and role-gated fields for a non-privileged session (get)", async () => {
    const doc = (await callTool(mockResource(), "get_user", { id: "u1" }, session())) as Record<
      string,
      unknown
    >;
    expect(doc.name).toBe("Ada");
    expect(doc).not.toHaveProperty("password");
    expect(doc).not.toHaveProperty("salary");
    expect(doc.email).toBe("ada@example.com"); // redactFor('viewer') — this session isn't a viewer
  });

  it("masks every item of a list result", async () => {
    const rows = (await callTool(mockResource(), "list_users", {}, session())) as Record<
      string,
      unknown
    >[];
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row).not.toHaveProperty("password");
      expect(row).not.toHaveProperty("salary");
    }
  });

  it("masks items inside a paginated list result ({ data, total })", async () => {
    const resource = mockResource();
    (resource.controller as { list: ReturnType<typeof vi.fn> }).list = vi.fn().mockResolvedValue({
      data: { data: [{ ...DOC }], total: 1, page: 1 },
    });
    const body = (await callTool(resource, "list_users", {}, session())) as {
      data: Record<string, unknown>[];
      total: number;
    };
    expect(body.total).toBe(1);
    expect(body.data[0]).not.toHaveProperty("password");
    expect(body.data[0]).not.toHaveProperty("salary");
  });

  it("keeps visibleTo fields for sessions carrying the required user role", async () => {
    const doc = (await callTool(
      mockResource(),
      "get_user",
      { id: "u1" },
      session({ roles: ["admin"] }),
    )) as Record<string, unknown>;
    expect(doc.salary).toBe(90_000);
    expect(doc).not.toHaveProperty("password"); // hidden strips for EVERY role
  });

  it("unions org roles into the effective role set (member scope)", async () => {
    const doc = (await callTool(
      mockResource(),
      "get_user",
      { id: "u1" },
      session({ organizationId: "org1", orgRoles: ["admin"] }),
    )) as Record<string, unknown>;
    expect(doc.salary).toBe(90_000);
  });

  it("redacts redactFor fields for sessions holding the flagged role", async () => {
    const doc = (await callTool(
      mockResource(),
      "get_user",
      { id: "u1" },
      session({ roles: ["viewer"] }),
    )) as Record<string, unknown>;
    expect(doc.email).toBe("***");
  });

  it("masks unauthenticated (null-session) calls fail-closed", async () => {
    const doc = (await callTool(mockResource(), "get_user", { id: "u1" }, null)) as Record<
      string,
      unknown
    >;
    expect(doc).not.toHaveProperty("password");
    expect(doc).not.toHaveProperty("salary");
  });

  it("leaves resources without a fields map untouched", async () => {
    const doc = (await callTool(
      mockResource({ fields: undefined }),
      "get_user",
      { id: "u1" },
      session(),
    )) as Record<string, unknown>;
    expect(doc.password).toBe("hash");
    expect(doc.salary).toBe(90_000);
  });
});

describe("MCP field-read masking — custom route tools", () => {
  it("masks function-handler route results", async () => {
    const resource = mockResource({
      routes: [
        {
          method: "GET",
          path: "/me",
          operation: "whoami",
          handler: async () => ({ data: { ...DOC } }),
        },
      ],
    } as unknown as Partial<ResourceDefinition>);
    const doc = (await callTool(resource, "whoami_user", {}, session())) as Record<string, unknown>;
    expect(doc.name).toBe("Ada");
    expect(doc).not.toHaveProperty("password");
    expect(doc).not.toHaveProperty("salary");
  });
});

describe("MCP field-read masking — action tools", () => {
  it("masks documents returned from declarative actions", async () => {
    const resource = mockResource({
      actions: {
        promote: {
          description: "Promote a user",
          permissions: () => true,
          handler: async () => ({ ...DOC, promoted: true }),
        },
      },
    } as unknown as Partial<ResourceDefinition>);
    const doc = (await callTool(resource, "promote_user", { id: "u1" }, session())) as Record<
      string,
      unknown
    >;
    expect(doc.promoted).toBe(true);
    expect(doc).not.toHaveProperty("password");
    expect(doc).not.toHaveProperty("salary");
  });

  it("passes scalar action results through untouched", async () => {
    const resource = mockResource({
      actions: {
        count: {
          description: "Count things",
          permissions: () => true,
          handler: async () => 42,
        },
      },
    } as unknown as Partial<ResourceDefinition>);
    const out = await callTool(resource, "count_user", { id: "u1" }, session());
    expect(out).toBe(42);
  });
});

describe("applyMcpReadMasking — scope semantics", () => {
  it("bypasses masking when a permission result elevates a public session", () => {
    const masked = applyMcpReadMasking(
      { ...DOC },
      {
        fields: FIELD_PERMS,
        session: null,
        scopeOverride: { kind: "elevated", elevatedBy: "platform-admin" },
      },
    );
    expect(masked.salary).toBe(90_000);
    expect(masked.password).toBe("hash");
  });

  it("does NOT let a scope override downgrade an authenticated session", () => {
    // Same non-downgrade rule as buildRequestContext: an authenticated
    // session keeps its own scope, so elevation via override is ignored.
    const masked = applyMcpReadMasking(
      { ...DOC },
      {
        fields: FIELD_PERMS,
        session: session(),
        scopeOverride: { kind: "elevated", elevatedBy: "spoof" },
      },
    );
    expect(masked).not.toHaveProperty("salary");
    expect(masked).not.toHaveProperty("password");
  });

  it("masks aggregation-shaped row arrays", () => {
    const rows = applyMcpReadMasking([{ ...DOC }, { ...DOC, _id: "u2" }], {
      fields: FIELD_PERMS,
      session: session(),
    });
    for (const row of rows) {
      expect(row).not.toHaveProperty("salary");
      expect(row).not.toHaveProperty("password");
    }
  });
});
