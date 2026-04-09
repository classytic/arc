#!/usr/bin/env node
/**
 * MCP E2E Test — validates MCP plugin works end-to-end with a real MongoDB
 * and the MCP SDK's InMemoryTransport (no network, no Claude CLI dependency).
 *
 * Usage:
 *   node scripts/mcp-e2e.mjs               # uses localhost:27017
 *   MONGODB_URI=... node scripts/mcp-e2e.mjs  # custom URI
 *
 * Exits 0 on success, 1 on failure. Safe to run in CI.
 */

import mongoose from "mongoose";
import { Repository, QueryParser } from "@classytic/mongokit";

let failures = 0;
let server;

function assert(label, condition, detail) {
  if (condition) {
    console.log(`  [pass] ${label}`);
  } else {
    console.log(`  [FAIL] ${label}${detail ? `: ${detail}` : ""}`);
    failures++;
  }
}

async function cleanup() {
  try { await mongoose.connection.dropDatabase(); } catch {}
  try { await mongoose.disconnect(); } catch {}
}

process.on("unhandledRejection", async (err) => {
  console.error("Unhandled rejection:", err);
  await cleanup();
  process.exit(1);
});

try {
  const uri = process.env.MONGODB_URI || "mongodb://localhost:27017/arc_mcp_e2e_script";
  await mongoose.connect(uri);

  console.log("=== Arc MCP E2E Test ===\n");

  // ── Setup: Model + Resource ──
  const { createApp } = await import("../dist/factory/index.mjs");
  const { defineResource } = await import("../dist/core/index.mjs");
  const { createMongooseAdapter } = await import("../dist/adapters/index.mjs");
  const { BaseController } = await import("../dist/core/index.mjs");
  const { allowPublic } = await import("../dist/permissions/index.mjs");
  const { mcpPlugin, defineTool } = await import("../dist/integrations/mcp/index.mjs");

  const Schema = new mongoose.Schema(
    { name: { type: String, required: true }, price: Number, category: String },
    { timestamps: true },
  );
  const Model = mongoose.models.McpE2E || mongoose.model("McpE2E", Schema);
  const repo = new Repository(Model);
  const qp = new QueryParser({
    allowedFilterFields: ["category", "name"],
    allowedOperators: ["eq", "ne", "in"],
    allowedSortFields: ["name", "price"],
  });

  const resource = defineResource({
    name: "item",
    displayName: "Item",
    adapter: createMongooseAdapter({ model: Model, repository: repo }),
    controller: new BaseController(repo, { resourceName: "item", queryParser: qp, tenantField: false }),
    queryParser: qp,
    permissions: { list: allowPublic(), get: allowPublic(), create: allowPublic(), update: allowPublic(), delete: allowPublic() },
  });

  const statusTool = defineTool("server_status", {
    description: "Get server status",
    annotations: { readOnlyHint: true },
    handler: async () => ({
      content: [{ type: "text", text: JSON.stringify({ ok: true }) }],
    }),
  });

  // ── Seed ──
  await Model.deleteMany({});
  await Model.create([
    { name: "Widget", price: 10, category: "gadgets" },
    { name: "Book", price: 25, category: "reading" },
    { name: "Lamp", price: 50, category: "gadgets" },
  ]);

  // ── App ──
  const resources = [resource];
  const app = await createApp({
    preset: "testing", auth: false, logger: false,
    helmet: false, cors: false, rateLimit: false, underPressure: false,
    plugins: async (f) => {
      await f.register(resource.toPlugin());
      await f.register(mcpPlugin, {
        resources,
        auth: false,
        extraTools: [statusTool],
      });
    },
  });
  await app.ready();

  // ── 1. Health endpoint ──
  console.log("[1/6] Health endpoint...");
  const health = await app.inject({ method: "GET", url: "/mcp/health" });
  const hBody = JSON.parse(health.body);
  assert("status ok", hBody.status === "ok");
  assert("tools count", hBody.tools === 6, `got ${hBody.tools}`);
  assert("mode stateless", hBody.mode === "stateless");

  // ── 2. MCP initialize via JSON-RPC ──
  console.log("\n[2/6] MCP initialize...");
  const initResp = await app.inject({
    method: "POST", url: "/mcp",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    payload: { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1.0" } } },
  });
  assert("initialize 200", initResp.statusCode === 200, `got ${initResp.statusCode}`);

  // ── 3. InMemoryTransport tool calls ──
  console.log("\n[3/6] InMemoryTransport tool calls...");
  const { createMcpServer } = await import("../dist/integrations/mcp/index.mjs");
  const { resourceToTools } = await import("../dist/integrations/mcp/index.mjs");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");

  const tools = resourceToTools(resource);
  tools.push(statusTool);
  const authRef = { current: { userId: "test" } };
  server = await createMcpServer({ name: "e2e", version: "1.0.0", tools }, authRef);

  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0" });
  await Promise.all([client.connect(ct), server.connect(st)]);

  const toolList = await client.listTools();
  assert("tool count", toolList.tools.length === 6, `got ${toolList.tools.length}`);

  // ── 4. CRUD via MCP ──
  console.log("\n[4/6] CRUD operations...");
  const listResult = await client.callTool({ name: "list_items", arguments: {} });
  const listData = JSON.parse(listResult.content[0].text);
  assert("list returns 3", listData.docs?.length === 3, `got ${listData.docs?.length}`);

  const createResult = await client.callTool({ name: "create_item", arguments: { name: "Pen", price: 5, category: "office" } });
  const createParsed = JSON.parse(createResult.content[0].text);
  const created = createParsed.data ?? createParsed;
  assert("create succeeds", !!created._id, "no _id");

  const getResult = await client.callTool({ name: "get_item", arguments: { id: created._id } });
  const getParsed = JSON.parse(getResult.content[0].text);
  const got = getParsed.data ?? getParsed;
  assert("get by id", got.name === "Pen");

  const updateResult = await client.callTool({ name: "update_item", arguments: { id: created._id, name: "Fancy Pen" } });
  const updateParsed = JSON.parse(updateResult.content[0].text);
  const updated = updateParsed.data ?? updateParsed;
  assert("update name", updated.name === "Fancy Pen");

  const deleteResult = await client.callTool({ name: "delete_item", arguments: { id: created._id } });
  assert("delete succeeds", !deleteResult.isError);

  // ── 5. Filter via QueryParser ──
  console.log("\n[5/6] QueryParser filter integration...");
  const filterResult = await client.callTool({ name: "list_items", arguments: { category: "gadgets" } });
  const filtered = JSON.parse(filterResult.content[0].text);
  assert("filter by category", filtered.docs?.length === 2, `got ${filtered.docs?.length}`);

  // ── 6. Custom tool ──
  console.log("\n[6/6] Custom tool...");
  const statusResult = await client.callTool({ name: "server_status", arguments: {} });
  const status = JSON.parse(statusResult.content[0].text);
  assert("custom tool works", status.ok === true);

  await client.close();
  await app.close();
} catch (err) {
  console.error("\nFatal:", err);
  failures++;
} finally {
  await cleanup();
}

console.log(`\n=== MCP E2E ${failures === 0 ? "Passed" : `Failed (${failures})`} ===`);
process.exit(failures > 0 ? 1 : 0);
