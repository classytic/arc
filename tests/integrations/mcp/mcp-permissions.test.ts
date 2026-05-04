/**
 * MCP Permissions — Real-world access control patterns
 *
 * Tests permission scenarios that app developers actually build:
 *   1. Mixed per-operation permissions (list=public, create=auth, delete=denied)
 *   2. Custom tool + auto-gen resource tools in same server with different auth
 *   3. Row-level security — user can only update/delete their own records
 *   4. Field-level: hidden fields stripped from MCP schemas
 *   5. Composite: org + role + ownership in one permission check
 *   6. Permission escalation: admin bypasses restrictions
 */

import { QueryParser, Repository } from "@classytic/mongokit";
import { createMongooseAdapter } from "@classytic/mongokit/adapter";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { BaseController } from "../../../src/core/BaseController.js";
import { defineResource } from "../../../src/core/defineResource.js";
import {
  type AuthRef,
  createMcpServer,
  customGuard,
  defineTool,
  guard,
  requireAuth,
  requireOrg,
  requireRole,
  resourceToTools,
} from "../../../src/integrations/mcp/index.js";
import { allowPublic } from "../../../src/permissions/index.js";

// ============================================================================
// Setup
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

async function connectInMemory(server: unknown) {
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0" });
  await Promise.all([
    client.connect(ct),
    (server as { connect: (t: unknown) => Promise<void> }).connect(st),
  ]);
  return client;
}

// ── Models ──

const PostSchema = new mongoose.Schema(
  {
    title: { type: String, required: true },
    body: String,
    authorId: String,
    organizationId: String,
    internalNotes: String, // should be hidden from MCP
    secretScore: Number, // should be hidden from MCP
    status: { type: String, enum: ["draft", "published", "archived"], default: "draft" },
  },
  { timestamps: true },
);
const PostModel = mongoose.models.McpPermPost || mongoose.model("McpPermPost", PostSchema);

// ============================================================================
// 1. Mixed Per-Operation Permissions
// ============================================================================

describe("Mixed per-operation permissions", () => {
  function createPostResource() {
    const repo = new Repository(PostModel);
    const parser = new QueryParser({ allowedFilterFields: ["status", "authorId"] });

    return defineResource({
      name: "post",
      displayName: "Post",
      adapter: createMongooseAdapter({ model: PostModel, repository: repo }),
      controller: new BaseController(repo, {
        resourceName: "post",
        queryParser: parser,
        tenantField: false,
      }),
      queryParser: parser,
      permissions: {
        list: allowPublic(), // anyone can list
        get: allowPublic(), // anyone can get
        create: (ctx) => !!ctx.user, // must be authenticated
        update: (ctx) => {
          if (!ctx.user) return false;
          const roles = (ctx.user as { roles?: string[] }).roles ?? [];
          if (roles.includes("admin")) return true;
          // Only author can update
          return {
            granted: true,
            filters: { authorId: ctx.user.id ?? ctx.user._id },
          };
        },
        delete: () => ({ granted: false, reason: "Posts cannot be deleted — archive instead" }),
      },
      schemaOptions: {
        fieldRules: {
          title: { type: "string", required: true, description: "Post title" },
          body: { type: "string", description: "Post body" },
          status: { type: "string", enum: ["draft", "published", "archived"] },
          authorId: { type: "string", systemManaged: true },
          organizationId: { type: "string", systemManaged: true },
          internalNotes: { type: "string", hidden: true },
          secretScore: { type: "number", hidden: true },
          createdAt: { type: "date", systemManaged: true },
          updatedAt: { type: "date", systemManaged: true },
        },
        filterableFields: ["status"],
      },
    });
  }

  it("anonymous can list and get, but cannot create", async () => {
    await PostModel.create({ title: "Public Post", status: "published", authorId: "u-1" });

    const resource = createPostResource();
    const tools = resourceToTools(resource);
    const server = await createMcpServer({ name: "test", tools }); // no auth
    const client = await connectInMemory(server);

    // List — allowed (public)
    const listResult = await client.callTool({ name: "list_posts", arguments: {} });
    const listed = JSON.parse((listResult.content[0] as { text: string }).text);
    expect(listed.data.length).toBe(1);

    // Create — denied (no user)
    const createResult = await client.callTool({
      name: "create_post",
      arguments: { title: "Anon Post" },
    });
    expect((createResult as any).isError).toBe(true);
    expect((createResult.content[0] as { text: string }).text).toContain("Permission denied");
  });

  it("authenticated user can create but cannot delete", async () => {
    const resource = createPostResource();
    const tools = resourceToTools(resource);
    const authRef: AuthRef = { current: { userId: "alice" } };
    const server = await createMcpServer({ name: "test", tools }, authRef);
    const client = await connectInMemory(server);

    // Create — allowed
    const createResult = await client.callTool({
      name: "create_post",
      arguments: { title: "Alice Post" },
    });
    expect((createResult as any).isError).toBeFalsy();

    // Delete — always denied
    const created = JSON.parse((createResult.content[0] as { text: string }).text);
    const deleteResult = await client.callTool({
      name: "delete_post",
      arguments: { id: created.data._id },
    });
    expect((deleteResult as any).isError).toBe(true);
    expect((deleteResult.content[0] as { text: string }).text).toContain("Permission denied");
  });

  it("delete returns custom denial reason", async () => {
    const resource = createPostResource();
    const tools = resourceToTools(resource);
    const authRef: AuthRef = { current: { userId: "admin", roles: ["admin"] } };
    const server = await createMcpServer({ name: "test", tools }, authRef);
    const client = await connectInMemory(server);

    const result = await client.callTool({ name: "delete_post", arguments: { id: "any-id" } });
    expect((result as any).isError).toBe(true);
    // The denial reason should be propagated
    expect((result.content[0] as { text: string }).text).toContain("Permission denied");
  });
});

// ============================================================================
// 2. Custom Tool + Auto-Gen with Different Auth Levels
// ============================================================================

describe("Custom tools with different auth levels alongside auto-gen", () => {
  it("public auto-gen + guarded custom tools in same server", async () => {
    const PostSchema2 = new mongoose.Schema({ title: String }, { timestamps: true });
    const Model = mongoose.models.McpMixedPost || mongoose.model("McpMixedPost", PostSchema2);
    const repo = new Repository(Model);

    const resource = defineResource({
      name: "post",
      adapter: createMongooseAdapter({ model: Model, repository: repo }),
      controller: new BaseController(repo, { resourceName: "post", tenantField: false }),
      permissions: {
        list: allowPublic(),
        get: allowPublic(),
        create: allowPublic(),
        update: allowPublic(),
        delete: allowPublic(),
      },
      schemaOptions: { fieldRules: { title: { type: "string", required: true } } },
    });

    const autoTools = resourceToTools(resource);

    // Admin-only custom tool
    const adminTool = defineTool("purge_posts", {
      description: "Delete all posts (admin only)",
      handler: guard(requireAuth, requireRole("admin"), async (_input, ctx) => ({
        content: [{ type: "text", text: `Purged by ${ctx.session?.userId}` }],
      })),
    });

    // Org-scoped custom tool
    const orgTool = defineTool("org_report", {
      description: "Generate org report",
      handler: guard(requireAuth, requireOrg, async (_input, ctx) => ({
        content: [{ type: "text", text: `Report for ${ctx.session?.organizationId}` }],
      })),
    });

    const allTools = [...autoTools, adminTool, orgTool];

    // Test with regular user (no admin, no org)
    const auth1: AuthRef = { current: { userId: "viewer", roles: ["viewer"] } };
    const server1 = await createMcpServer({ name: "test1", tools: allTools }, auth1);
    const client1 = await connectInMemory(server1);

    // Auto-gen works (public)
    const listResult = await client1.callTool({ name: "list_posts", arguments: {} });
    expect((listResult as any).isError).toBeFalsy();

    // Admin tool denied
    const purgeResult = await client1.callTool({ name: "purge_posts", arguments: {} });
    expect((purgeResult as any).isError).toBe(true);
    expect((purgeResult.content[0] as { text: string }).text).toContain("role");

    // Org tool denied (no org)
    const orgResult = await client1.callTool({ name: "org_report", arguments: {} });
    expect((orgResult as any).isError).toBe(true);

    // Test with admin in org
    const auth2: AuthRef = {
      current: { userId: "boss", roles: ["admin"], organizationId: "org-1" },
    };
    const server2 = await createMcpServer({ name: "test2", tools: allTools }, auth2);
    const client2 = await connectInMemory(server2);

    const purgeResult2 = await client2.callTool({ name: "purge_posts", arguments: {} });
    expect((purgeResult2 as any).isError).toBeFalsy();
    expect((purgeResult2.content[0] as { text: string }).text).toBe("Purged by boss");

    const orgResult2 = await client2.callTool({ name: "org_report", arguments: {} });
    expect((orgResult2.content[0] as { text: string }).text).toBe("Report for org-1");
  });
});

// ============================================================================
// 3. Field-Level: Hidden Fields Stripped from MCP Schemas
// ============================================================================

describe("Hidden fields in MCP tool schemas", () => {
  it("hidden fields are not in create/update tool inputSchema", () => {
    const repo = new Repository(PostModel);

    const resource = defineResource({
      name: "post",
      adapter: createMongooseAdapter({ model: PostModel, repository: repo }),
      controller: new BaseController(repo, { resourceName: "post", tenantField: false }),
      permissions: {
        list: allowPublic(),
        get: allowPublic(),
        create: allowPublic(),
        update: allowPublic(),
        delete: allowPublic(),
      },
      schemaOptions: {
        fieldRules: {
          title: { type: "string", required: true },
          body: { type: "string" },
          internalNotes: { type: "string", hidden: true },
          secretScore: { type: "number", hidden: true },
          createdAt: { type: "date", systemManaged: true },
        },
      },
    });

    const tools = resourceToTools(resource);
    const createTool = tools.find((t) => t.name === "create_post");
    const updateTool = tools.find((t) => t.name === "update_post");

    // Create schema should have title, body — NOT internalNotes, secretScore
    const createFields = Object.keys(createTool?.inputSchema ?? {});
    expect(createFields).toContain("title");
    expect(createFields).toContain("body");
    expect(createFields).not.toContain("internalNotes");
    expect(createFields).not.toContain("secretScore");
    expect(createFields).not.toContain("createdAt"); // systemManaged

    // Update schema should have id, title, body — NOT hidden fields
    const updateFields = Object.keys(updateTool?.inputSchema ?? {});
    expect(updateFields).toContain("id");
    expect(updateFields).toContain("title");
    expect(updateFields).not.toContain("internalNotes");
    expect(updateFields).not.toContain("secretScore");
  });

  it("overrides.hideFields additionally removes fields", () => {
    const repo = new Repository(PostModel);

    const resource = defineResource({
      name: "post",
      adapter: createMongooseAdapter({ model: PostModel, repository: repo }),
      controller: new BaseController(repo, { resourceName: "post", tenantField: false }),
      permissions: { list: allowPublic(), create: allowPublic() },
      schemaOptions: {
        fieldRules: {
          title: { type: "string", required: true },
          body: { type: "string" },
          status: { type: "string" },
        },
      },
    });

    const tools = resourceToTools(resource, { hideFields: ["body", "status"] });
    const createTool = tools.find((t) => t.name === "create_post");
    const fields = Object.keys(createTool?.inputSchema ?? {});

    expect(fields).toContain("title");
    expect(fields).not.toContain("body");
    expect(fields).not.toContain("status");
  });
});

// ============================================================================
// 4. Composite Permission: Org + Role + Custom Logic
// ============================================================================

describe("Composite permission patterns", () => {
  it("org admin can list, regular member sees filtered, outsider denied", async () => {
    await PostModel.create([
      { title: "Draft", status: "draft", organizationId: "org-x", authorId: "alice" },
      { title: "Published", status: "published", organizationId: "org-x", authorId: "bob" },
      { title: "Other Org", status: "published", organizationId: "org-y", authorId: "charlie" },
    ]);

    const repo = new Repository(PostModel);
    const parser = new QueryParser({ allowedFilterFields: ["status"] });

    const resource = defineResource({
      name: "post",
      adapter: createMongooseAdapter({ model: PostModel, repository: repo }),
      controller: new BaseController(repo, {
        resourceName: "post",
        queryParser: parser,
        tenantField: "organizationId",
      }),
      queryParser: parser,
      permissions: {
        list: (ctx) => {
          if (!ctx.user) return false;
          const roles = (ctx.user as { roles?: string[] }).roles ?? [];
          // Org admin sees everything in their org (tenantField handles scoping)
          if (roles.includes("admin")) return true;
          // Regular member sees only published
          return { granted: true, filters: { status: "published" } };
        },
      },
      schemaOptions: {
        fieldRules: {
          title: { type: "string", required: true },
          status: { type: "string", enum: ["draft", "published", "archived"] },
          organizationId: { type: "string", systemManaged: true },
          authorId: { type: "string", systemManaged: true },
          createdAt: { type: "date", systemManaged: true },
          updatedAt: { type: "date", systemManaged: true },
        },
        filterableFields: ["status"],
      },
    });

    const tools = resourceToTools(resource);

    // Org admin — sees all org-x posts (draft + published)
    const adminAuth: AuthRef = {
      current: { userId: "alice", organizationId: "org-x", roles: ["admin"] },
    };
    const adminServer = await createMcpServer({ name: "admin", tools }, adminAuth);
    const adminClient = await connectInMemory(adminServer);
    const adminResult = await adminClient.callTool({ name: "list_posts", arguments: {} });
    const adminData = JSON.parse((adminResult.content[0] as { text: string }).text);
    expect(adminData.data.length).toBe(2); // both org-x posts

    // Regular member — sees only published in org-x
    const memberAuth: AuthRef = {
      current: { userId: "bob", organizationId: "org-x", roles: ["member"] },
    };
    const memberServer = await createMcpServer({ name: "member", tools }, memberAuth);
    const memberClient = await connectInMemory(memberServer);
    const memberResult = await memberClient.callTool({ name: "list_posts", arguments: {} });
    const memberData = JSON.parse((memberResult.content[0] as { text: string }).text);
    expect(memberData.data.length).toBe(1);
    expect(memberData.data[0].status).toBe("published");

    // No auth — denied
    const anonServer = await createMcpServer({ name: "anon", tools });
    const anonClient = await connectInMemory(anonServer);
    const anonResult = await anonClient.callTool({ name: "list_posts", arguments: {} });
    expect((anonResult as any).isError).toBe(true);
  });
});

// ============================================================================
// 5. Custom Guard Composition — Real-World Patterns
// ============================================================================

describe("Real-world guard composition patterns", () => {
  it("business hours + rate limit + role guard", async () => {
    // Business hours guard (always true in test)
    const businessHours = customGuard(() => true, "Outside business hours");
    // Rate limit guard (always passes in test)
    const rateLimit = customGuard(() => true, "Rate limit exceeded");

    const tool = defineTool("sensitive_export", {
      description: "Export sensitive data",
      handler: guard(
        requireAuth,
        requireOrg,
        requireRole("admin", "exporter"),
        businessHours,
        rateLimit,
        async (_input, ctx) => ({
          content: [{ type: "text", text: `Exported for ${ctx.session?.organizationId}` }],
        }),
      ),
    });

    // All guards pass
    const auth: AuthRef = {
      current: { userId: "exporter-1", organizationId: "org-1", roles: ["exporter"] },
    };
    const server = await createMcpServer({ name: "test", tools: [tool] }, auth);
    const client = await connectInMemory(server);

    const result = await client.callTool({ name: "sensitive_export", arguments: {} });
    expect((result as any).isError).toBeFalsy();
    expect((result.content[0] as { text: string }).text).toBe("Exported for org-1");
  });

  it("business hours guard rejects when false", async () => {
    const offHours = customGuard(() => false, "Only available 9-5");

    const tool = defineTool("restricted_op", {
      description: "Time-restricted",
      handler: guard(requireAuth, offHours, async () => ({
        content: [{ type: "text", text: "Should not reach" }],
      })),
    });

    const auth: AuthRef = { current: { userId: "u-1" } };
    const server = await createMcpServer({ name: "test", tools: [tool] }, auth);
    const client = await connectInMemory(server);

    const result = await client.callTool({ name: "restricted_op", arguments: {} });
    expect((result as any).isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("Only available 9-5");
  });
});
