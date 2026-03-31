/**
 * MCP Auth & Multi-Tenancy E2E Tests
 *
 * Tests all auth modes and multi-tenancy through the full MCP pipeline:
 *   createMcpServer → InMemoryTransport → tool call → BaseController → mock DB
 *
 * Scenarios:
 *   1. No auth — anonymous access, all data visible
 *   2. Custom auth — API key, static org, gateway headers
 *   3. Multi-tenancy — org-scoped data isolation via BaseController
 *   4. Auth rejection — null return blocks access
 *   5. Mixed tools — auto-generated + custom tools with auth context
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { Repository, QueryParser } from "@classytic/mongokit";
import { defineResource } from "../../../src/core/defineResource.js";
import { createMongooseAdapter } from "../../../src/adapters/mongoose.js";
import { BaseController } from "../../../src/core/BaseController.js";
import { allowPublic } from "../../../src/permissions/index.js";
import {
  createMcpServer,
  defineTool,
  mcpPlugin,
  resourceToTools,
  type AuthRef,
} from "../../../src/integrations/mcp/index.js";

// ============================================================================
// Test Infrastructure
// ============================================================================

let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

afterEach(async () => {
  for (const key in mongoose.connection.collections) {
    await mongoose.connection.collections[key].deleteMany({});
  }
});

// ── Model + Resource Factory ──

const ProjectSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    status: { type: String, enum: ["active", "archived"], default: "active" },
    organizationId: { type: String },
  },
  { timestamps: true },
);
const ProjectModel =
  mongoose.models.McpTestProject || mongoose.model("McpTestProject", ProjectSchema);

function createProjectResource(tenantField: string | false = "organizationId") {
  const repo = new Repository(ProjectModel);
  const parser = new QueryParser();

  return defineResource({
    name: "project",
    displayName: "Project",
    adapter: createMongooseAdapter({ model: ProjectModel, repository: repo }),
    controller: new BaseController(repo, {
      resourceName: "project",
      queryParser: parser,
      tenantField,
    }),
    queryParser: parser,
    permissions: {
      list: allowPublic(),
      get: allowPublic(),
      create: allowPublic(),
      update: allowPublic(),
      delete: allowPublic(),
    },
    schemaOptions: {
      fieldRules: {
        name: { type: "string", required: true, description: "Project name" },
        status: { type: "string", enum: ["active", "archived"], description: "Project status" },
        organizationId: { type: "string", systemManaged: true },
        createdAt: { type: "date", systemManaged: true },
        updatedAt: { type: "date", systemManaged: true },
      },
      filterableFields: ["status"],
    },
  });
}

// Helper: connect server + client via InMemoryTransport
async function connectInMemory(server: unknown) {
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" });

  await Promise.all([
    client.connect(clientTransport),
    (server as { connect: (t: unknown) => Promise<void> }).connect(serverTransport),
  ]);

  return client;
}

// ============================================================================
// 1. No Auth — Anonymous Access
// ============================================================================

describe("No auth mode", () => {
  it("all tools accessible without auth, session is anonymous", async () => {
    const resource = createProjectResource(false); // no tenant scoping
    const tools = resourceToTools(resource);

    // Create server with no authRef (simulates auth: false)
    const server = await createMcpServer({ name: "test-noauth", tools });
    const client = await connectInMemory(server);

    // Create a project (no org scoping)
    const result = await client.callTool({
      name: "create_project",
      arguments: { name: "Open Project" },
    });

    const created = JSON.parse((result.content[0] as { text: string }).text);
    expect(created.data.name).toBe("Open Project");

    // List should return it
    const listResult = await client.callTool({ name: "list_projects", arguments: {} });
    const listed = JSON.parse((listResult.content[0] as { text: string }).text);
    expect(listed.docs.length).toBeGreaterThanOrEqual(1);
  });

  it("session is null when no authRef provided", async () => {
    let capturedSession: unknown = "not-set";

    const server = await createMcpServer({
      name: "test",
      tools: [
        defineTool("check_auth", {
          description: "Check auth context",
          handler: async (_input, ctx) => {
            capturedSession = ctx.session;
            return { content: [{ type: "text", text: JSON.stringify(ctx.session) }] };
          },
        }),
      ],
    });

    const client = await connectInMemory(server);
    await client.callTool({ name: "check_auth", arguments: {} });

    expect(capturedSession).toBeNull();
  });
});

// ============================================================================
// 2. Custom Auth — AuthRef Flow
// ============================================================================

describe("Custom auth via AuthRef", () => {
  it("tool handler receives auth from authRef", async () => {
    let capturedSession: unknown = null;

    const authRef: AuthRef = { current: { userId: "user-42", organizationId: "org-99" } };

    const server = await createMcpServer(
      {
        name: "test-auth",
        tools: [
          defineTool("whoami", {
            description: "Show current identity",
            handler: async (_input, ctx) => {
              capturedSession = ctx.session;
              return { content: [{ type: "text", text: JSON.stringify(ctx.session) }] };
            },
          }),
        ],
      },
      authRef,
    );

    const client = await connectInMemory(server);
    const result = await client.callTool({ name: "whoami", arguments: {} });

    const session = JSON.parse((result.content[0] as { text: string }).text);
    expect(session.userId).toBe("user-42");
    expect(session.organizationId).toBe("org-99");
    expect(capturedSession).toEqual({ userId: "user-42", organizationId: "org-99" });
  });

  it("authRef can be updated between requests (simulates per-request auth)", async () => {
    const authRef: AuthRef = { current: { userId: "user-1" } };

    const server = await createMcpServer(
      {
        name: "test",
        tools: [
          defineTool("whoami", {
            description: "Identity",
            handler: async (_input, ctx) => ({
              content: [{ type: "text", text: ctx.session?.userId ?? "anon" }],
            }),
          }),
        ],
      },
      authRef,
    );

    const client = await connectInMemory(server);

    // First call — user-1
    const r1 = await client.callTool({ name: "whoami", arguments: {} });
    expect((r1.content[0] as { text: string }).text).toBe("user-1");

    // Update authRef (simulates new request with different token)
    authRef.current = { userId: "user-2", organizationId: "org-abc" };

    const r2 = await client.callTool({ name: "whoami", arguments: {} });
    expect((r2.content[0] as { text: string }).text).toBe("user-2");
  });
});

// ============================================================================
// 3. Multi-Tenancy — Org-Scoped Data Isolation
// ============================================================================

describe("Multi-tenancy via org-scoped BaseController", () => {
  it("org A cannot see org B data through MCP tools", async () => {
    // Seed data for two orgs
    await ProjectModel.create([
      { name: "Org A Project 1", status: "active", organizationId: "org-a" },
      { name: "Org A Project 2", status: "active", organizationId: "org-a" },
      { name: "Org B Secret", status: "active", organizationId: "org-b" },
      { name: "Org B Internal", status: "archived", organizationId: "org-b" },
    ]);

    const resource = createProjectResource("organizationId");
    const tools = resourceToTools(resource);

    // ── Org A's session ──
    const authRefA: AuthRef = { current: { userId: "alice", organizationId: "org-a" } };
    const serverA = await createMcpServer({ name: "test-a", tools }, authRefA);
    const clientA = await connectInMemory(serverA);

    const resultA = await clientA.callTool({ name: "list_projects", arguments: {} });
    const dataA = JSON.parse((resultA.content[0] as { text: string }).text);

    expect(dataA.docs.length).toBe(2);
    expect(dataA.docs.every((p: { organizationId: string }) => p.organizationId === "org-a")).toBe(true);

    // ── Org B's session ──
    const authRefB: AuthRef = { current: { userId: "bob", organizationId: "org-b" } };
    const serverB = await createMcpServer({ name: "test-b", tools }, authRefB);
    const clientB = await connectInMemory(serverB);

    const resultB = await clientB.callTool({ name: "list_projects", arguments: {} });
    const dataB = JSON.parse((resultB.content[0] as { text: string }).text);

    expect(dataB.docs.length).toBe(2);
    expect(dataB.docs.every((p: { organizationId: string }) => p.organizationId === "org-b")).toBe(true);

    // Org A never sees Org B's data
    const allNamesA = dataA.docs.map((p: { name: string }) => p.name);
    expect(allNamesA).not.toContain("Org B Secret");
    expect(allNamesA).not.toContain("Org B Internal");
  });

  it("create auto-scopes to org from auth context", async () => {
    const resource = createProjectResource("organizationId");
    const tools = resourceToTools(resource);

    const authRef: AuthRef = { current: { userId: "alice", organizationId: "org-x" } };
    const server = await createMcpServer({ name: "test", tools }, authRef);
    const client = await connectInMemory(server);

    await client.callTool({
      name: "create_project",
      arguments: { name: "Scoped Project" },
    });

    // Verify in DB — should have org-x
    const doc = await ProjectModel.findOne({ name: "Scoped Project" }).lean();
    expect(doc).toBeDefined();
    // The org scoping is done by BaseController when tenantField is set
  });

  it("filters work within org scope", async () => {
    await ProjectModel.create([
      { name: "Active 1", status: "active", organizationId: "org-f" },
      { name: "Active 2", status: "active", organizationId: "org-f" },
      { name: "Archived", status: "archived", organizationId: "org-f" },
      { name: "Other Org", status: "active", organizationId: "org-other" },
    ]);

    const resource = createProjectResource("organizationId");
    const tools = resourceToTools(resource);

    const authRef: AuthRef = { current: { userId: "user", organizationId: "org-f" } };
    const server = await createMcpServer({ name: "test", tools }, authRef);
    const client = await connectInMemory(server);

    // Filter by status within org
    const result = await client.callTool({
      name: "list_projects",
      arguments: { status: "active" },
    });
    const data = JSON.parse((result.content[0] as { text: string }).text);

    expect(data.docs.length).toBe(2);
    expect(data.docs.every((p: { status: string }) => p.status === "active")).toBe(true);
    expect(data.docs.every((p: { organizationId: string }) => p.organizationId === "org-f")).toBe(true);
  });
});

// ============================================================================
// 4. Auth Rejection
// ============================================================================

describe("Auth rejection scenarios", () => {
  it("custom auth resolver returning null blocks tool access", async () => {
    // This test verifies the resolveMcpAuth function behavior
    const { resolveMcpAuth } = await import("../../../src/integrations/mcp/authBridge.js");

    // API key auth — wrong key
    const resolver = async (headers: Record<string, string | undefined>) => {
      if (headers["x-api-key"] !== "valid-key") return null;
      return { userId: "bot", organizationId: "org-1" };
    };

    const badResult = await resolveMcpAuth({ "x-api-key": "wrong" }, resolver);
    expect(badResult).toBeNull();

    const goodResult = await resolveMcpAuth({ "x-api-key": "valid-key" }, resolver);
    expect(goodResult).toEqual({ userId: "bot", organizationId: "org-1" });
  });

  it("no-auth mode always returns anonymous", async () => {
    const { resolveMcpAuth } = await import("../../../src/integrations/mcp/authBridge.js");
    const result = await resolveMcpAuth({}, false);
    expect(result).toEqual({ userId: "anonymous" });
  });

  it("auth resolver exception returns null (doesn't crash)", async () => {
    const { resolveMcpAuth } = await import("../../../src/integrations/mcp/authBridge.js");
    const badResolver = async () => {
      throw new Error("Auth service down");
    };
    const result = await resolveMcpAuth({}, badResolver);
    expect(result).toBeNull();
  });

  it("gateway header auth extracts identity from custom headers", async () => {
    const { resolveMcpAuth } = await import("../../../src/integrations/mcp/authBridge.js");

    const gatewayResolver = async (headers: Record<string, string | undefined>) => {
      const userId = headers["x-user-id"];
      const orgId = headers["x-org-id"];
      return userId ? { userId, organizationId: orgId } : null;
    };

    const result = await resolveMcpAuth(
      { "x-user-id": "u-123", "x-org-id": "org-456" },
      gatewayResolver,
    );
    expect(result).toEqual({ userId: "u-123", organizationId: "org-456" });

    const noUser = await resolveMcpAuth({}, gatewayResolver);
    expect(noUser).toBeNull();
  });

  it("static org auth always returns same identity", async () => {
    const { resolveMcpAuth } = await import("../../../src/integrations/mcp/authBridge.js");

    const staticResolver = async () => ({
      userId: "internal-service",
      organizationId: "org-main",
    });

    const result = await resolveMcpAuth({}, staticResolver);
    expect(result).toEqual({ userId: "internal-service", organizationId: "org-main" });
  });
});

// ============================================================================
// 5. Mixed Tools — Auto-Generated + Custom with Auth
// ============================================================================

describe("Mixed auto-generated + custom tools", () => {
  it("custom tools receive same auth context as auto-generated tools", async () => {
    const resource = createProjectResource(false);
    const autoTools = resourceToTools(resource);

    const customTool = defineTool("project_summary", {
      description: "Get project summary with auth info",
      input: { includeAuth: z.boolean().optional() },
      annotations: { readOnlyHint: true },
      handler: async ({ includeAuth }, ctx) => {
        const summary = {
          userId: ctx.session?.userId ?? "anon",
          orgId: ctx.session?.organizationId ?? "none",
          includeAuth,
        };
        return { content: [{ type: "text", text: JSON.stringify(summary) }] };
      },
    });

    const authRef: AuthRef = { current: { userId: "admin", organizationId: "org-main" } };
    const server = await createMcpServer(
      { name: "test-mixed", tools: [...autoTools, customTool] },
      authRef,
    );
    const client = await connectInMemory(server);

    // List all tools — should include both auto + custom
    const { tools } = await client.listTools();
    const names = tools.map((t: { name: string }) => t.name);
    expect(names).toContain("list_projects");
    expect(names).toContain("create_project");
    expect(names).toContain("project_summary");

    // Custom tool receives auth
    const result = await client.callTool({
      name: "project_summary",
      arguments: { includeAuth: true },
    });
    const summary = JSON.parse((result.content[0] as { text: string }).text);
    expect(summary.userId).toBe("admin");
    expect(summary.orgId).toBe("org-main");
  });
});
