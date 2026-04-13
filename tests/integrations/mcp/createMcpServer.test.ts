/**
 * MCP Integration Tests — createMcpServer + InMemoryTransport
 *
 * Tests the full round-trip: create server → connect transport → call tools.
 * Uses MCP SDK's InMemoryTransport (no HTTP, no network).
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  createMcpServer,
  definePrompt,
  defineTool,
  resourceToTools,
} from "../../../src/integrations/mcp/index.js";

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

describe("createMcpServer — InMemoryTransport integration", () => {
  it("initializes and lists tools", async () => {
    const server = await createMcpServer({
      name: "test",
      version: "1.0.0",
      tools: [
        defineTool("ping", {
          description: "Ping",
          handler: async () => ({ content: [{ type: "text", text: "pong" }] }),
        }),
      ],
    });

    const client = await connectInMemory(server);
    const { tools } = await client.listTools();

    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("ping");
    expect(tools[0].description).toBe("Ping");
  });

  it("calls a tool and returns result", async () => {
    const server = await createMcpServer({
      name: "test",
      tools: [
        defineTool("greet", {
          description: "Greet someone",
          input: { name: z.string() },
          handler: async ({ name }) => ({
            content: [{ type: "text", text: `Hello ${name}!` }],
          }),
        }),
      ],
    });

    const client = await connectInMemory(server);
    const result = await client.callTool({ name: "greet", arguments: { name: "Arc" } });

    expect(result.content).toHaveLength(1);
    expect((result.content[0] as { text: string }).text).toBe("Hello Arc!");
  });

  it("calls a tool with enum input", async () => {
    const server = await createMcpServer({
      name: "test",
      tools: [
        defineTool("set_status", {
          description: "Set status",
          input: { status: z.enum(["active", "inactive"]) },
          handler: async ({ status }) => ({
            content: [{ type: "text", text: `Status: ${status}` }],
          }),
        }),
      ],
    });

    const client = await connectInMemory(server);
    const result = await client.callTool({ name: "set_status", arguments: { status: "active" } });

    expect((result.content[0] as { text: string }).text).toBe("Status: active");
  });

  it("returns isError on tool failure", async () => {
    const server = await createMcpServer({
      name: "test",
      tools: [
        defineTool("fail", {
          description: "Always fails",
          handler: async () => ({
            content: [{ type: "text", text: "Something went wrong" }],
            isError: true,
          }),
        }),
      ],
    });

    const client = await connectInMemory(server);
    const result = await client.callTool({ name: "fail", arguments: {} });

    expect(result.isError).toBe(true);
  });

  it("registers multiple tools", async () => {
    const server = await createMcpServer({
      name: "test",
      tools: [
        defineTool("add", {
          description: "Add numbers",
          input: { a: z.number(), b: z.number() },
          handler: async ({ a, b }) => ({
            content: [{ type: "text", text: String(a + b) }],
          }),
        }),
        defineTool("multiply", {
          description: "Multiply numbers",
          input: { a: z.number(), b: z.number() },
          handler: async ({ a, b }) => ({
            content: [{ type: "text", text: String(a * b) }],
          }),
        }),
      ],
    });

    const client = await connectInMemory(server);
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(2);

    const addResult = await client.callTool({ name: "add", arguments: { a: 3, b: 4 } });
    expect((addResult.content[0] as { text: string }).text).toBe("7");

    const mulResult = await client.callTool({ name: "multiply", arguments: { a: 3, b: 4 } });
    expect((mulResult.content[0] as { text: string }).text).toBe("12");
  });

  it("registers and lists prompts", async () => {
    const server = await createMcpServer({
      name: "test",
      prompts: [
        definePrompt("summarize", {
          description: "Summarize a topic",
          args: { topic: z.string() },
          handler: ({ topic }) => ({
            messages: [{ role: "user", content: { type: "text", text: `Summarize ${topic}` } }],
          }),
        }),
      ],
    });

    const client = await connectInMemory(server);
    const { prompts } = await client.listPrompts();

    expect(prompts).toHaveLength(1);
    expect(prompts[0].name).toBe("summarize");
  });

  it("gets a prompt with arguments", async () => {
    const server = await createMcpServer({
      name: "test",
      prompts: [
        definePrompt("plan", {
          description: "Plan work",
          args: { scope: z.string() },
          handler: ({ scope }) => ({
            messages: [{ role: "user", content: { type: "text", text: `Plan ${scope}` } }],
          }),
        }),
      ],
    });

    const client = await connectInMemory(server);
    const result = await client.getPrompt({ name: "plan", arguments: { scope: "sprint" } });

    expect(result.messages).toHaveLength(1);
    expect((result.messages[0].content as { text: string }).text).toBe("Plan sprint");
  });

  it("provides instructions in server info", async () => {
    const server = await createMcpServer({
      name: "test",
      instructions: "Use ping first.",
      tools: [
        defineTool("ping", {
          description: "Ping",
          handler: async () => ({ content: [{ type: "text", text: "pong" }] }),
        }),
      ],
    });

    const client = await connectInMemory(server);
    const info = client.getServerVersion();

    expect(info?.name).toBe("test");
  });
});

describe("resourceToTools → createMcpServer integration", () => {
  const mockController = {
    list: async () => ({
      success: true,
      data: [{ _id: "1", name: "Item" }],
      meta: { total: 1, page: 1 },
    }),
    get: async () => ({ success: true, data: { _id: "1", name: "Item" } }),
    create: async () => ({ success: true, data: { _id: "2", name: "New" } }),
    update: async () => ({ success: true, data: { _id: "1", name: "Updated" } }),
    delete: async () => ({ success: true }),
  };

  const mockResource = {
    name: "item",
    displayName: "Item",
    controller: mockController,
    schemaOptions: {
      fieldRules: {
        name: { type: "string", required: true, maxLength: 100 },
        price: { type: "number", min: 0 },
        status: { type: "string", enum: ["active", "archived"] },
      },
      filterableFields: ["status"],
      hiddenFields: [],
      readonlyFields: [],
    },
    permissions: {},
    routes: [],
    disabledRoutes: [],
    disableDefaultRoutes: false,
    _appliedPresets: [],
    _pendingHooks: [],
  } as any;

  it("generates tools from resource and registers on server", async () => {
    const tools = resourceToTools(mockResource);
    const server = await createMcpServer({ name: "test", tools });
    const client = await connectInMemory(server);

    const { tools: listed } = await client.listTools();
    expect(listed.map((t: { name: string }) => t.name)).toEqual([
      "list_items",
      "get_item",
      "create_item",
      "update_item",
      "delete_item",
    ]);
  });

  it("list tool returns data from controller", async () => {
    const tools = resourceToTools(mockResource);
    const server = await createMcpServer({ name: "test", tools });
    const client = await connectInMemory(server);

    const result = await client.callTool({ name: "list_items", arguments: {} });
    const text = (result.content[0] as { text: string }).text;
    const parsed = JSON.parse(text);

    expect(parsed.data).toHaveLength(1);
    expect(parsed.data[0].name).toBe("Item");
    expect(parsed.total).toBe(1);
  });

  it("create tool passes input to controller", async () => {
    const tools = resourceToTools(mockResource);
    const server = await createMcpServer({ name: "test", tools });
    const client = await connectInMemory(server);

    const result = await client.callTool({
      name: "create_item",
      arguments: { name: "New Item", price: 25 },
    });
    const text = (result.content[0] as { text: string }).text;
    const parsed = JSON.parse(text);

    // Controller returns { _id, name } — toCallToolResult wraps as-is
    expect(parsed._id).toBe("2");
    expect(parsed.name).toBe("New");
  });

  it("tool input schemas have correct required fields", async () => {
    const tools = resourceToTools(mockResource);
    const server = await createMcpServer({ name: "test", tools });
    const client = await connectInMemory(server);

    const { tools: listed } = await client.listTools();
    const createTool = listed.find((t: { name: string }) => t.name === "create_item");

    expect(createTool?.inputSchema?.required).toContain("name");
    expect(createTool?.inputSchema?.properties?.status?.enum).toEqual(["active", "archived"]);
  });

  it("list tool input schema has filterable fields", async () => {
    const tools = resourceToTools(mockResource);
    const server = await createMcpServer({ name: "test", tools });
    const client = await connectInMemory(server);

    const { tools: listed } = await client.listTools();
    const listTool = listed.find((t: { name: string }) => t.name === "list_items");

    expect(listTool?.inputSchema?.properties).toHaveProperty("status");
    expect(listTool?.inputSchema?.properties).toHaveProperty("page");
    expect(listTool?.inputSchema?.properties).toHaveProperty("limit");
  });
});
