/**
 * MCP tools enforce what the HTTP routes of the same resource enforce: an action's
 * `idempotency.required`, its target fence (404 for a row the caller cannot read), its audit
 * record and the resource rate limit; a CRUD write declared key-required needs the key; an
 * ungated CRUD slot generates no tool. `mcpPlugin` mounts a curated `resources: []` surface.
 */

import { QueryParser, Repository } from "@classytic/mongokit";
import { createMongooseAdapter } from "@classytic/mongokit/adapter";
import Fastify from "fastify";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import { z } from "zod";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { BaseController } from "../../../src/core/BaseController.js";
import { defineResource } from "../../../src/core/defineResource.js";
import { MemoryIdempotencyStore } from "../../../src/idempotency/stores/index.js";
import { defineTool } from "../../../src/integrations/mcp/defineTool.js";
import { mcpPlugin } from "../../../src/integrations/mcp/mcpPlugin.js";
import { resourceToTools } from "../../../src/integrations/mcp/resourceToTools.js";
import type {
  CallToolResult,
  McpAuthResult,
  McpExecutionWiring,
  ToolDefinition,
} from "../../../src/integrations/mcp/types.js";
import { allowPublic } from "../../../src/permissions/index.js";

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
    await mongoose.connection.collections[key]?.deleteMany({});
  }
});

const InvoiceModel =
  mongoose.models.ParityInvoice ||
  mongoose.model(
    "ParityInvoice",
    new mongoose.Schema({ number: String, organizationId: String, status: String }),
  );

const actionRuns: string[] = [];

type ResourceShape = Parameters<typeof defineResource>[0];

function invoiceResource(overrides: Partial<ResourceShape> = {}) {
  const repo = new Repository(InvoiceModel);
  const parser = new QueryParser({});
  return defineResource({
    name: "invoice",
    adapter: createMongooseAdapter({ model: InvoiceModel, repository: repo }),
    controller: new BaseController(repo, {
      resourceName: "invoice",
      queryParser: parser,
      tenantField: "organizationId",
    }),
    queryParser: parser,
    tenantField: "organizationId",
    permissions: {
      list: allowPublic(),
      get: allowPublic(),
      create: allowPublic(),
      update: allowPublic(),
    },
    actions: {
      approve: {
        handler: async (id: string) => {
          actionRuns.push(`approve:${id}`);
          return { id, status: "approved" };
        },
        permissions: allowPublic(),
      },
      pay: {
        handler: async (id: string) => {
          actionRuns.push(`pay:${id}`);
          return { id, paid: true };
        },
        permissions: allowPublic(),
        idempotency: { required: true },
      },
    },
    ...overrides,
  });
}

const orgA = (): McpAuthResult => ({ userId: "u1", organizationId: "org-a", orgRoles: ["admin"] });

function tool(tools: ToolDefinition[], name: string): ToolDefinition {
  const found = tools.find((t) => t.name === name);
  if (!found) throw new Error(`tool ${name} not generated (have: ${tools.map((t) => t.name)})`);
  return found;
}

async function call(
  tools: ToolDefinition[],
  name: string,
  input: Record<string, unknown>,
): Promise<CallToolResult> {
  return tool(tools, name).handler(input, { session: orgA(), log: async () => {}, extra: {} });
}

function errorCode(result: CallToolResult): string | undefined {
  if (result.isError !== true) return undefined;
  const text = (result.content[0] as { text: string }).text;
  return (JSON.parse(text) as { code?: string }).code;
}

function wiring(extra: Partial<McpExecutionWiring> = {}): McpExecutionWiring {
  return { idempotencyStore: new MemoryIdempotencyStore(), ...extra };
}

async function seed(): Promise<{ mine: string; theirs: string }> {
  const [mine, theirs] = await InvoiceModel.create([
    { number: "INV-1", organizationId: "org-a", status: "draft" },
    { number: "INV-2", organizationId: "org-b", status: "draft" },
  ]);
  return { mine: String(mine?._id), theirs: String(theirs?._id) };
}

describe("MCP action tools — HTTP action parity", () => {
  afterEach(() => {
    actionRuns.length = 0;
  });

  it("an id the caller cannot read is 404, and the handler never runs", async () => {
    const { mine, theirs } = await seed();
    const tools = resourceToTools(invoiceResource(), { wiring: wiring() });
    expect(errorCode(await call(tools, "approve_invoice", { id: theirs }))).toBe("arc.not_found");
    expect(actionRuns).toEqual([]);
    expect((await call(tools, "approve_invoice", { id: mine })).isError).not.toBe(true);
    expect(actionRuns).toEqual([`approve:${mine}`]);
  });

  it("an action declaring idempotency.required refuses a keyless call and replays a keyed one", async () => {
    const { mine } = await seed();
    const tools = resourceToTools(invoiceResource(), { wiring: wiring() });
    expect(tool(tools, "pay_invoice").inputSchema?._idempotencyKey).toBeDefined();
    expect(errorCode(await call(tools, "pay_invoice", { id: mine }))).toBe(
      "arc.idempotency_key_required",
    );
    const key = "pay-inv-1-attempt-0001";
    const first = await call(tools, "pay_invoice", { id: mine, _idempotencyKey: key });
    const second = await call(tools, "pay_invoice", { id: mine, _idempotencyKey: key });
    expect(first.isError).not.toBe(true);
    expect(second).toEqual(first);
    expect(actionRuns).toEqual([`pay:${mine}`]);
  });

  it("a key-required action with no idempotency store refuses to generate", () => {
    expect(() => resourceToTools(invoiceResource(), { wiring: {} })).toThrow(/idempotency/);
  });

  it("writes the action audit record when the resource is audited", async () => {
    const { mine } = await seed();
    const custom = vi.fn(async () => {});
    const tools = resourceToTools(invoiceResource({ audit: true }), {
      wiring: wiring({ audit: { custom } }),
    });
    await call(tools, "approve_invoice", { id: mine });
    expect(custom).toHaveBeenCalledTimes(1);
    expect(custom.mock.calls[0]?.slice(0, 3)).toEqual(["invoice", mine, "approve"]);
    expect(custom.mock.calls[0]?.[4]).toMatchObject({ actorId: "u1", organizationId: "org-a" });
  });

  it("applies the resource rate limit per caller", async () => {
    const { mine } = await seed();
    const tools = resourceToTools(
      invoiceResource({ rateLimit: { max: 2, timeWindow: "1 minute" } }),
      { wiring: wiring() },
    );
    await call(tools, "approve_invoice", { id: mine });
    await call(tools, "approve_invoice", { id: mine });
    expect(errorCode(await call(tools, "approve_invoice", { id: mine }))).toBe("arc.rate_limited");
    expect(actionRuns).toHaveLength(2);
  });
});

describe("MCP CRUD tools — HTTP CRUD parity", () => {
  it("a write the resource declares key-required needs the key", async () => {
    const tools = resourceToTools(invoiceResource({ idempotency: { required: ["create"] } }), {
      wiring: wiring(),
    });
    expect(errorCode(await call(tools, "create_invoice", { number: "INV-9" }))).toBe(
      "arc.idempotency_key_required",
    );
    const keyed = await call(tools, "create_invoice", {
      number: "INV-9",
      _idempotencyKey: "create-inv-9-attempt-01",
    });
    expect(keyed.isError).not.toBe(true);
  });

  it("an ungated CRUD slot generates no tool instead of allowing everyone", () => {
    const tools = resourceToTools(invoiceResource(), { wiring: wiring() });
    const names = tools.map((t) => t.name);
    expect(names).toContain("update_invoice");
    expect(names).not.toContain("delete_invoice");
  });
});

describe("mcpPlugin — a curated surface", () => {
  it("accepts resources: [] and mounts only the extra tools", async () => {
    const app = Fastify({ logger: false });
    const ping = defineTool("ping_ledger", {
      description: "Read-only probe",
      inputSchema: { echo: z.string() },
      annotations: { readOnlyHint: true },
      handler: async (input) => ({ content: [{ type: "text", text: String(input.echo) }] }),
    });
    await app.register(mcpPlugin, { resources: [], extraTools: [ping], auth: false });
    await app.ready();
    const health = await app.inject({ method: "GET", url: "/mcp/health" });
    expect(health.json()).toMatchObject({ tools: 1, resources: 0, toolNames: ["ping_ledger"] });
    await app.close();
  });
});
