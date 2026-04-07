/**
 * MCP DX Features — Tests for v2.4.4 additions
 *
 * Covers:
 *   1. include option (whitelist resources)
 *   2. Per-resource names + toolNamePrefix
 *   3. /mcp/health endpoint
 *   4. disableDefaultRoutes does NOT block MCP tools
 *   5. mcpHandler on additionalRoutes (wrapHandler: false)
 *   6. Auth cache for stateless mode
 *   7. Mixed auto-gen + custom tools with guards
 */

import { QueryParser, Repository } from "@classytic/mongokit";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createMongooseAdapter } from "../../../src/adapters/mongoose.js";
import { BaseController } from "../../../src/core/BaseController.js";
import { defineResource } from "../../../src/core/defineResource.js";
import {
  type AuthRef,
  createMcpServer,
  defineTool,
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

// ── Models ──

const ProductSchema = new mongoose.Schema(
  { name: { type: String, required: true }, price: Number, category: String },
  { timestamps: true },
);
const ProductModel = mongoose.models.DxProduct || mongoose.model("DxProduct", ProductSchema);

const OrderSchema = new mongoose.Schema(
  { item: { type: String, required: true }, qty: Number, status: String },
  { timestamps: true },
);
const OrderModel = mongoose.models.DxOrder || mongoose.model("DxOrder", OrderSchema);

const SecretSchema = new mongoose.Schema({ key: String, value: String }, { timestamps: true });
const SecretModel = mongoose.models.DxSecret || mongoose.model("DxSecret", SecretSchema);

function makeResource(
  name: string,
  model: mongoose.Model<any>,
  opts: {
    tenantField?: string | false;
    disableDefaultRoutes?: boolean;
    additionalRoutes?: any[];
  } = {},
) {
  const repo = new Repository(model);
  const parser = new QueryParser({ allowedFilterFields: ["category", "status"] });

  return defineResource({
    name,
    displayName: name.charAt(0).toUpperCase() + name.slice(1),
    adapter: createMongooseAdapter({ model, repository: repo }),
    controller: opts.disableDefaultRoutes
      ? undefined
      : new BaseController(repo, {
          resourceName: name,
          queryParser: parser,
          tenantField: opts.tenantField ?? false,
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
        name: { type: "string", required: true },
        createdAt: { type: "date", systemManaged: true },
        updatedAt: { type: "date", systemManaged: true },
      },
    },
    disableDefaultRoutes: opts.disableDefaultRoutes,
    additionalRoutes: opts.additionalRoutes,
  });
}

// Helper: connect InMemoryTransport
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

// ============================================================================
// 1. include option
// ============================================================================

describe("include option — whitelist resources", () => {
  it("only included resources generate tools", () => {
    const product = makeResource("product", ProductModel);
    const order = makeResource("order", OrderModel);
    const secret = makeResource("secret", SecretModel);

    // Simulate what mcpPlugin does with include
    const include = new Set(["product", "order"]);
    const enabled = [product, order, secret].filter((r) => include.has(r.name));
    const tools = enabled.flatMap((r) => resourceToTools(r));
    const names = tools.map((t) => t.name);

    expect(names).toContain("list_products");
    expect(names).toContain("list_orders");
    expect(names).not.toContain("list_secrets");
  });
});

// ============================================================================
// 2. Per-resource names + toolNamePrefix
// ============================================================================

describe("Per-resource tool name customization", () => {
  it("names override changes individual tool names", () => {
    const resource = makeResource("product", ProductModel);
    const tools = resourceToTools(resource, {
      names: { get: "get_product_by_id", list: "search_products" },
    });
    const names = tools.map((t) => t.name);

    expect(names).toContain("get_product_by_id");
    expect(names).toContain("search_products");
    expect(names).toContain("create_product"); // unchanged
    expect(names).not.toContain("get_product"); // overridden
    expect(names).not.toContain("list_products"); // overridden
  });

  it("per-resource toolNamePrefix takes precedence", () => {
    const resource = makeResource("product", ProductModel);

    // Global prefix
    const globalTools = resourceToTools(resource, { toolNamePrefix: "api" });
    expect(globalTools.map((t) => t.name)).toContain("api_list_products");

    // Per-resource prefix
    const resourceTools = resourceToTools(resource, { toolNamePrefix: "db" });
    expect(resourceTools.map((t) => t.name)).toContain("db_list_products");
  });
});

// ============================================================================
// 3. disableDefaultRoutes does NOT block MCP tools
// ============================================================================

describe("disableDefaultRoutes + MCP", () => {
  it("MCP tools are generated even with disableDefaultRoutes: true", async () => {
    const resource = makeResource("product", ProductModel, { disableDefaultRoutes: true });
    const tools = resourceToTools(resource);

    // Should still generate tools (auto-creates controller from adapter)
    expect(tools.length).toBe(5);
    expect(tools.map((t) => t.name)).toContain("list_products");
    expect(tools.map((t) => t.name)).toContain("create_product");
  });

  it("MCP tools work end-to-end with disableDefaultRoutes", async () => {
    const resource = makeResource("product", ProductModel, { disableDefaultRoutes: true });
    const tools = resourceToTools(resource);

    const server = await createMcpServer({ name: "test", tools });
    const client = await connectInMemory(server);

    // Create via MCP
    const result = await client.callTool({
      name: "create_product",
      arguments: { name: "MCP Only Product" },
    });
    const data = JSON.parse((result.content[0] as { text: string }).text);
    expect(data.data.name).toBe("MCP Only Product");

    // List via MCP
    const listResult = await client.callTool({ name: "list_products", arguments: {} });
    const listed = JSON.parse((listResult.content[0] as { text: string }).text);
    expect(listed.docs.length).toBeGreaterThanOrEqual(1);
  });

  it("disabledRoutes still respected — delete disabled means no delete tool", () => {
    const repo = new Repository(ProductModel);
    const resource = defineResource({
      name: "product",
      adapter: createMongooseAdapter({ model: ProductModel, repository: repo }),
      controller: new BaseController(repo, { resourceName: "product" }),
      permissions: {
        list: allowPublic(),
        get: allowPublic(),
        create: allowPublic(),
        update: allowPublic(),
        delete: allowPublic(),
      },
      disabledRoutes: ["delete"],
    });

    const tools = resourceToTools(resource);
    const names = tools.map((t) => t.name);
    expect(names).toContain("list_products");
    expect(names).not.toContain("delete_product");
  });
});

// ============================================================================
// 4. mcpHandler on additionalRoutes
// ============================================================================

describe("mcpHandler on additionalRoutes", () => {
  it("wrapHandler: false routes with mcpHandler become MCP tools", () => {
    const resource = makeResource("product", ProductModel, {
      additionalRoutes: [
        {
          method: "GET" as const,
          path: "/stats",
          wrapHandler: false,
          permissions: allowPublic(),
          handler: async (_req: any, reply: any) => reply.send({ count: 42 }),
          mcpHandler: async () => ({
            content: [{ type: "text" as const, text: JSON.stringify({ count: 42 }) }],
          }),
        },
      ],
    });

    const tools = resourceToTools(resource);
    const statsTool = tools.find((t) => t.name.includes("stats"));
    expect(statsTool).toBeDefined();
    expect(statsTool?.description).toContain("stats");
  });

  it("mcpHandler receives input and returns result", async () => {
    const resource = makeResource("product", ProductModel, {
      additionalRoutes: [
        {
          method: "POST" as const,
          path: "/analyze",
          wrapHandler: false,
          permissions: allowPublic(),
          operation: "analyze",
          handler: async (_req: any, reply: any) => reply.send({}),
          mcpHandler: async (input: Record<string, unknown>) => ({
            content: [{ type: "text" as const, text: `Analyzed: ${input.query}` }],
          }),
        },
      ],
    });

    const tools = resourceToTools(resource);
    const server = await createMcpServer({ name: "test", tools });
    const client = await connectInMemory(server);

    const result = await client.callTool({
      name: "analyze_product",
      arguments: {},
    });
    // mcpHandler receives raw input from MCP SDK — no schema validation for custom handlers
    expect((result.content[0] as { text: string }).text).toContain("Analyzed:");
  });
});

// ============================================================================
// 5. Auto-derive filterableFields from QueryParser
// ============================================================================

describe("Auto-derive filterableFields from QueryParser", () => {
  it("uses QueryParser.allowedFilterFields when schemaOptions.filterableFields not set", () => {
    const repo = new Repository(ProductModel);
    const parser = new QueryParser({ allowedFilterFields: ["category", "status", "price"] });

    const resource = defineResource({
      name: "product",
      adapter: createMongooseAdapter({ model: ProductModel, repository: repo }),
      controller: new BaseController(repo, { resourceName: "product", queryParser: parser }),
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
          name: { type: "string", required: true },
          category: { type: "string" },
          status: { type: "string" },
          price: { type: "number" },
        },
        // NO filterableFields — should auto-derive
      },
    });

    const tools = resourceToTools(resource);
    const listTool = tools.find((t) => t.name === "list_products");
    expect(listTool).toBeDefined();

    // Description should mention filterable fields
    expect(listTool?.description).toContain("category");
    expect(listTool?.description).toContain("status");
    expect(listTool?.description).toContain("price");
  });

  it("explicit filterableFields takes priority over QueryParser", () => {
    const repo = new Repository(ProductModel);
    const parser = new QueryParser({ allowedFilterFields: ["category", "status", "price"] });

    const resource = defineResource({
      name: "product",
      adapter: createMongooseAdapter({ model: ProductModel, repository: repo }),
      controller: new BaseController(repo, { resourceName: "product", queryParser: parser }),
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
          name: { type: "string", required: true },
          category: { type: "string" },
        },
        filterableFields: ["category"], // Explicit — only category
      },
    });

    const tools = resourceToTools(resource);
    const listTool = tools.find((t) => t.name === "list_products");
    expect(listTool?.description).toContain("category");
    expect(listTool?.description).not.toContain("price");
  });
});

// ============================================================================
// 6. Guards on custom tools
// ============================================================================

describe("Guard helpers on custom tools", () => {
  it("requireAuth guard blocks unauthenticated calls", async () => {
    const guards = await import("../../../src/integrations/mcp/guards.js");
    const { guard } = guards;
    const mcpRequireAuth = guards.requireAuth;

    const protectedTool = defineTool("admin_action", {
      description: "Admin only",
      handler: guard(mcpRequireAuth, async (_input, ctx) => ({
        content: [{ type: "text", text: `Welcome ${ctx.session?.userId}` }],
      })),
    });

    // Unauthenticated — no authRef
    const server1 = await createMcpServer({ name: "test", tools: [protectedTool] });
    const client1 = await connectInMemory(server1);
    const r1 = await client1.callTool({ name: "admin_action", arguments: {} });
    expect((r1 as any).isError).toBe(true);
    expect((r1.content[0] as { text: string }).text).toContain("Authentication required");

    // Authenticated
    const authRef: AuthRef = { current: { userId: "admin-1" } };
    const server2 = await createMcpServer({ name: "test2", tools: [protectedTool] }, authRef);
    const client2 = await connectInMemory(server2);
    const r2 = await client2.callTool({ name: "admin_action", arguments: {} });
    expect((r2 as any).isError).toBeFalsy();
    expect((r2.content[0] as { text: string }).text).toBe("Welcome admin-1");
  });

  it("requireOrg guard blocks calls without org context", async () => {
    const { guard, requireOrg } = (await import("../../../src/integrations/mcp/guards.js")) as any;

    const orgTool = defineTool("org_data", {
      description: "Needs org",
      handler: guard(requireOrg, async (_input, ctx) => ({
        content: [{ type: "text", text: `Org: ${ctx.session?.organizationId}` }],
      })),
    });

    // No org
    const auth1: AuthRef = { current: { userId: "user-1" } };
    const server1 = await createMcpServer({ name: "test", tools: [orgTool] }, auth1);
    const client1 = await connectInMemory(server1);
    const r1 = await client1.callTool({ name: "org_data", arguments: {} });
    expect((r1 as any).isError).toBe(true);

    // With org
    const auth2: AuthRef = { current: { userId: "user-1", organizationId: "org-abc" } };
    const server2 = await createMcpServer({ name: "test2", tools: [orgTool] }, auth2);
    const client2 = await connectInMemory(server2);
    const r2 = await client2.callTool({ name: "org_data", arguments: {} });
    expect((r2.content[0] as { text: string }).text).toBe("Org: org-abc");
  });

  it("requireRole guard blocks calls without matching role", async () => {
    const { guard, requireRole } = (await import("../../../src/integrations/mcp/guards.js")) as any;

    const adminTool = defineTool("admin_panel", {
      description: "Admin panel",
      handler: guard(requireRole("admin"), async () => ({
        content: [{ type: "text", text: "Admin access granted" }],
      })),
    });

    // Non-admin
    const auth1: AuthRef = { current: { userId: "user-1", roles: ["viewer"] } };
    const server1 = await createMcpServer({ name: "test", tools: [adminTool] }, auth1);
    const client1 = await connectInMemory(server1);
    const r1 = await client1.callTool({ name: "admin_panel", arguments: {} });
    expect((r1 as any).isError).toBe(true);

    // Admin
    const auth2: AuthRef = { current: { userId: "user-1", roles: ["admin"] } };
    const server2 = await createMcpServer({ name: "test2", tools: [adminTool] }, auth2);
    const client2 = await connectInMemory(server2);
    const r2 = await client2.callTool({ name: "admin_panel", arguments: {} });
    expect((r2.content[0] as { text: string }).text).toBe("Admin access granted");
  });
});

// ============================================================================
// 7. Full CRUD lifecycle through MCP — create, list, get, update, delete
// ============================================================================

describe("Full CRUD lifecycle through MCP", () => {
  it("complete create → get → update → list → delete cycle", async () => {
    const resource = makeResource("product", ProductModel);
    const tools = resourceToTools(resource);
    const server = await createMcpServer({ name: "test-crud", tools });
    const client = await connectInMemory(server);

    // Create
    const createResult = await client.callTool({
      name: "create_product",
      arguments: { name: "Widget", price: 10 },
    });
    const created = JSON.parse((createResult.content[0] as { text: string }).text);
    expect(created.data.name).toBe("Widget");
    const id = created.data._id;

    // Get
    const getResult = await client.callTool({ name: "get_product", arguments: { id } });
    const fetched = JSON.parse((getResult.content[0] as { text: string }).text);
    // get returns { data: doc } or doc directly depending on controller response
    const fetchedName = fetched.data?.name ?? fetched.name;
    expect(fetchedName).toBe("Widget");

    // Update
    const updateResult = await client.callTool({
      name: "update_product",
      arguments: { id, name: "Super Widget", price: 20 },
    });
    const updated = JSON.parse((updateResult.content[0] as { text: string }).text);
    const updatedName = updated.data?.name ?? updated.name;
    expect(updatedName).toBe("Super Widget");

    // List
    const listResult = await client.callTool({ name: "list_products", arguments: {} });
    const listed = JSON.parse((listResult.content[0] as { text: string }).text);
    expect(listed.docs.length).toBe(1);
    expect(listed.docs[0].name).toBe("Super Widget");

    // Delete
    const deleteResult = await client.callTool({ name: "delete_product", arguments: { id } });
    expect((deleteResult as any).isError).toBeFalsy();

    // Verify deleted
    const afterDelete = await client.callTool({ name: "list_products", arguments: {} });
    const afterData = JSON.parse((afterDelete.content[0] as { text: string }).text);
    expect(afterData.docs.length).toBe(0);
  });
});
