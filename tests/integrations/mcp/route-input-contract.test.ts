/**
 * A custom route's MCP tool refuses exactly what its REST twin refuses — through the
 * real SDK validation path, not by calling the handler directly. Pins
 * `route-input-schema.ts`: a union querystring flattened to `{}` let the SDK strip
 * every key, so a period-narrowed read silently ran unnarrowed.
 */

import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { ResourceDefinition } from "../../../src/core/defineResource.js";
import { createMcpServer } from "../../../src/integrations/mcp/createMcpServer.js";
import { dispatchRealtimeToolCall } from "../../../src/integrations/mcp/realtimeBridge.js";
import { resourceToTools } from "../../../src/integrations/mcp/resourceToTools.js";
import {
  isZodTypeSchema,
  toolInputShape,
} from "../../../src/integrations/mcp/route-input-schema.js";
import {
  type ConnectedMcpTestClient,
  connectMcpTestClient,
} from "../../../src/integrations/mcp/testing.js";
import { allowPublic } from "../../../src/permissions/index.js";
import type { IRequestContext, RouteDefinition } from "../../../src/types/index.js";

const PUBLIC_CRUD = {
  list: allowPublic(),
  get: allowPublic(),
  create: allowPublic(),
  update: allowPublic(),
  delete: allowPublic(),
};

const PERIOD = z.union([
  z.strictObject({ dateOption: z.literal("month"), month: z.string().regex(/^\d{4}-\d{2}$/) }),
  z.strictObject({ dateOption: z.literal("year"), year: z.string().regex(/^\d{4}$/) }),
  z.strictObject({}),
]);

function makeResource(routes: RouteDefinition[]): ResourceDefinition {
  return {
    name: "report",
    displayName: "Report",
    prefix: "/reports",
    disabledRoutes: [],
    disableDefaultRoutes: true,
    schemaOptions: {},
    // Every slot gated: MCP mounts no tool for an ungated one.
    permissions: PUBLIC_CRUD,
    routes,
    _appliedPresets: [],
    tag: "Reports",
    customSchemas: {},
    middlewares: {},
    events: {},
  } as unknown as ResourceDefinition;
}

const seen: unknown[] = [];
const echo = async (ctx: IRequestContext) => {
  seen.push(ctx.query);
  return { data: { query: ctx.query } };
};

let conn: ConnectedMcpTestClient | undefined;
afterEach(async () => {
  seen.length = 0;
  await conn?.close();
  conn = undefined;
});

async function connect(routes: RouteDefinition[]) {
  const server = await createMcpServer({ name: "t", tools: resourceToTools(makeResource(routes)) });
  conn = await connectMcpTestClient(server);
  return conn.client;
}

function isError(result: unknown): boolean {
  return (result as { isError?: boolean }).isError === true;
}

describe("route tool input = the route's own schema", () => {
  const unionRoute: RouteDefinition = {
    method: "GET",
    path: "/summary",
    operation: "summary",
    permissions: allowPublic(),
    schema: { querystring: PERIOD },
    handler: echo,
  };

  it("a complete union arm reaches ctx.query unchanged", async () => {
    const client = await connect([unionRoute]);
    const result = await client.callTool({
      name: "summary_report",
      arguments: { dateOption: "month", month: "2026-09" },
    });
    expect(isError(result)).toBe(false);
    expect(seen).toEqual([{ dateOption: "month", month: "2026-09" }]);
  });

  it("an incomplete arm is refused before the handler runs", async () => {
    const client = await connect([unionRoute]);
    const result = await client.callTool({
      name: "summary_report",
      arguments: { dateOption: "month" },
    });
    expect(isError(result)).toBe(true);
    expect(seen).toEqual([]);
  });

  it("an unknown key is refused, never stripped into the no-period arm", async () => {
    const client = await connect([unionRoute]);
    const result = await client.callTool({
      name: "summary_report",
      arguments: { period: "2026-Q3" },
    });
    expect(isError(result)).toBe(true);
    expect(seen).toEqual([]);
  });

  it("advertises the union arms in tools/list and a GET as read-only", async () => {
    const client = await connect([unionRoute]);
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === "summary_report");
    expect(tool?.inputSchema.type).toBe("object");
    expect(JSON.stringify(tool?.inputSchema)).toContain('"month"');
    expect(tool?.annotations?.readOnlyHint).toBe(true);
  });

  it("a strict flat querystring refuses an unknown key", async () => {
    const client = await connect([
      {
        method: "GET",
        path: "/aging",
        operation: "aging",
        permissions: allowPublic(),
        schema: { querystring: z.strictObject({ asOfDate: z.string().optional() }) },
        handler: echo,
      },
    ]);
    const bad = await client.callTool({ name: "aging_report", arguments: { asOf: "2026-09-30" } });
    expect(isError(bad)).toBe(true);
    const good = await client.callTool({
      name: "aging_report",
      arguments: { asOfDate: "2026-09-30" },
    });
    expect(isError(good)).toBe(false);
    expect(seen).toEqual([{ asOfDate: "2026-09-30" }]);
  });

  it("a route with no schema refuses any key instead of stripping it", async () => {
    const client = await connect([
      {
        method: "GET",
        path: "/bare",
        operation: "bare",
        permissions: allowPublic(),
        handler: echo,
      },
    ]);
    const bad = await client.callTool({ name: "bare_report", arguments: { month: "2026-09" } });
    expect(isError(bad)).toBe(true);
    const good = await client.callTool({ name: "bare_report", arguments: {} });
    expect(isError(good)).toBe(false);
    expect(seen).toHaveLength(1);
  });

  it("CRUD read tools refuse an unknown key (a dropped filter widens the read)", () => {
    const resource = {
      ...makeResource([]),
      controller: { list: async () => ({ data: [] }), get: async () => ({ data: null }) },
    } as unknown as ResourceDefinition;
    const tools = resourceToTools(resource);
    for (const op of ["list_reports", "get_report"]) {
      const schema = tools.find((t) => t.name === op)?.inputSchema;
      expect(isZodTypeSchema(schema)).toBe(true);
      if (!isZodTypeSchema(schema)) continue;
      expect(schema.safeParse({ id: "x", statusTypo: "open" }).success).toBe(false);
    }
    const list = tools.find((t) => t.name === "list_reports")?.inputSchema;
    expect(toolInputShape(list)).toHaveProperty("page");
    if (isZodTypeSchema(list)) expect(list.safeParse({}).success).toBe(true);
  });

  it("a non-strict flat querystring keeps today's flat shape", () => {
    const [tool] = resourceToTools(
      makeResource([
        {
          method: "GET",
          path: "/loose",
          operation: "loose",
          permissions: allowPublic(),
          schema: { querystring: z.object({ q: z.string().optional() }) },
          handler: echo,
        },
      ]),
    );
    expect(tool?.inputSchema).toHaveProperty("q");
  });

  it("a union beside :id cannot be bridged losslessly and throws at build", () => {
    expect(() =>
      resourceToTools(
        makeResource([
          {
            method: "GET",
            path: "/:id/summary",
            operation: "summaryById",
            permissions: allowPublic(),
            schema: { querystring: PERIOD },
            handler: echo,
          },
        ]),
      ),
    ).toThrow(/arc\.mcp|mcpHandler/);
  });

  it("the realtime bridge validates a whole schema the same way", async () => {
    const tools = resourceToTools(makeResource([unionRoute]));
    const [bad] = await dispatchRealtimeToolCall(tools, [
      { id: "1", name: "summary_report", arguments: { period: "Q3" } },
    ]);
    expect(bad?.isError).toBe(true);
    const [good] = await dispatchRealtimeToolCall(tools, [
      { id: "2", name: "summary_report", arguments: { dateOption: "year", year: "2026" } },
    ]);
    expect(good?.isError).toBeFalsy();
    expect(seen).toEqual([{ dateOption: "year", year: "2026" }]);
  });
});
