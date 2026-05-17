/**
 * Tests for the GET-route MCP auto-bridge (v2.15.5, OpenAI-team report).
 *
 * Pre-2.15.5 the resource-to-tools translator excluded GET routes from MCP
 * auto-bridging — they had to ship an explicit `mcpHandler` that
 * re-serialised the same data the HTTP handler returned (~10 lines of
 * boilerplate per route). The fix removes the GET exclusion AND wires
 * input through the correct `IRequestContext` slot via the new
 * `operationKindForRoute` mapping, so a GET handler that reads `ctx.query`
 * (the natural Fastify shape for GET) keeps working unchanged on the MCP
 * surface.
 *
 * Contract this file locks in:
 *  - `GET /<collection>` (no `:id`) becomes an MCP tool. Input is routed
 *    into `ctx.query` (matches HTTP semantics).
 *  - `GET /<collection>/:id` becomes an MCP tool. `id` lands in
 *    `ctx.params`, the rest in `ctx.query`.
 *  - The handler returns its raw payload — no `mcpHandler` duplicate
 *    required. The output is serialised through the canonical
 *    `toCallToolResult` envelope (same shape the CRUD tools emit).
 *  - The route's `schema.querystring` flows into the MCP tool's
 *    `inputSchema` so agents see exactly the same input contract.
 */

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { ResourceDefinition } from "../../../src/core/defineResource.js";
import { resourceToTools } from "../../../src/integrations/mcp/resourceToTools.js";
import { operationKindForRoute } from "../../../src/integrations/mcp/route-tools.js";
import type { ToolContext } from "../../../src/integrations/mcp/types.js";
import { allowPublic } from "../../../src/permissions/index.js";
import type { IRequestContext } from "../../../src/types/index.js";

function makeResource(overrides: Partial<ResourceDefinition>): ResourceDefinition {
  return {
    name: "provider",
    displayName: "Provider",
    prefix: "/providers",
    disabledRoutes: [],
    disableDefaultRoutes: true,
    schemaOptions: {},
    permissions: {},
    routes: [],
    _appliedPresets: [],
    tag: "Providers",
    customSchemas: {},
    middlewares: {},
    events: {},
    ...overrides,
  } as ResourceDefinition;
}

function toolCtx(session: Record<string, unknown> | null = null): ToolContext {
  return {
    session: session as ToolContext["session"],
    log: vi.fn(async () => undefined),
    extra: {},
  } as ToolContext;
}

function parseSuccess(result: { content: Array<{ text: string }> }): unknown {
  return JSON.parse(result.content[0].text);
}

// ============================================================================
// operationKindForRoute — the input-routing decision table
// ============================================================================

describe("operationKindForRoute — picks the right MCP op kind", () => {
  // The mapping is the single source of truth that keeps HTTP semantics
  // and MCP synthetic-context semantics aligned. Locked as a table so a
  // single drift (e.g. accidentally routing GET into `body` again) trips
  // the test and points at the row that changed.
  const cases: Array<{ method: string; hasId: boolean; expect: string }> = [
    { method: "GET", hasId: false, expect: "list" },
    { method: "GET", hasId: true, expect: "get" },
    { method: "POST", hasId: false, expect: "create" },
    { method: "POST", hasId: true, expect: "update" },
    { method: "PUT", hasId: true, expect: "update" },
    { method: "PATCH", hasId: true, expect: "update" },
    { method: "DELETE", hasId: true, expect: "delete" },
    // Case-insensitive on the HTTP method (`get` lowercase should map the
    // same as `GET`) — hosts that build routes from lowercase strings
    // shouldn't see a silent regression on input routing.
    { method: "get", hasId: false, expect: "list" },
  ];

  it.each(cases)("$method (hasId=$hasId) → $expect", ({ method, hasId, expect: kind }) => {
    expect(operationKindForRoute(method, hasId)).toBe(kind);
  });
});

// ============================================================================
// Tool generation — GET routes now produce MCP tools
// ============================================================================

describe("resourceToTools — GET routes are auto-bridged to MCP", () => {
  it("collection GET (no :id) → MCP tool, input routed through ctx.query", async () => {
    let observed: IRequestContext | undefined;
    const handler = async (ctx: IRequestContext) => {
      observed = ctx;
      return { data: { provider: ctx.query?.provider ?? "all", supports: ["image", "video"] } };
    };

    const resource = makeResource({
      routes: [
        {
          method: "GET",
          path: "/coverage",
          operation: "coverage_provider",
          handler: handler as never,
          permissions: allowPublic(),
          schema: { querystring: z.object({ provider: z.string() }).optional() as never },
        },
      ],
    });

    const tools = resourceToTools(resource);
    const coverage = tools.find((t) => t.name.includes("coverage"));
    expect(coverage).toBeDefined();

    const result = await coverage?.handler({ provider: "openai" }, toolCtx());
    expect(result?.isError).toBeFalsy();
    // Handler saw input in `query` (NOT body) — same shape an HTTP GET produces.
    expect(observed?.query).toEqual({ provider: "openai" });
    expect(observed?.body).toBeUndefined();
    // Output is the handler's return wrapped in the canonical envelope.
    expect(parseSuccess(result as never)).toEqual({
      provider: "openai",
      supports: ["image", "video"],
    });
  });

  it("item GET (with :id) → MCP tool, id in params, rest in query", async () => {
    let observed: IRequestContext | undefined;
    const handler = async (ctx: IRequestContext) => {
      observed = ctx;
      return { data: { id: ctx.params?.id, mode: ctx.query?.mode ?? "default" } };
    };

    const resource = makeResource({
      routes: [
        {
          method: "GET",
          path: "/clips/:id",
          operation: "voice_details",
          handler: handler as never,
          permissions: allowPublic(),
        },
      ],
    });

    const tools = resourceToTools(resource);
    const tool = tools.find((t) => t.name.includes("voice_details"));
    expect(tool).toBeDefined();

    const result = await tool?.handler({ id: "clip-42", mode: "verbose" }, toolCtx());
    expect(result?.isError).toBeFalsy();
    expect(observed?.params).toEqual({ id: "clip-42" });
    // Anything other than `id` lands in query — matches `GET /clips/:id?mode=verbose`.
    expect(observed?.query).toEqual({ mode: "verbose" });
  });

  it("respects mcp:false opt-out on GET routes (parity with POST)", async () => {
    const resource = makeResource({
      routes: [
        {
          method: "GET",
          path: "/internal",
          operation: "internal_only",
          handler: (async () => ({ data: {} })) as never,
          permissions: allowPublic(),
          mcp: false,
        },
      ],
    });

    const tools = resourceToTools(resource);
    expect(tools.find((t) => t.name.includes("internal_only"))).toBeUndefined();
  });

  it("threads route.schema.querystring into the MCP tool inputSchema", async () => {
    // The schema authors declare once for REST validation also shapes the
    // MCP tool's input. Agents see the same contract HTTP callers do
    // without re-declaring it as a Zod inputSchema by hand.
    const resource = makeResource({
      routes: [
        {
          method: "GET",
          path: "/voices",
          operation: "list_voices",
          handler: (async () => ({ data: [] })) as never,
          permissions: allowPublic(),
          schema: {
            querystring: z.object({
              language: z.string(),
              limit: z.number().optional(),
            }) as never,
          },
        },
      ],
    });

    const tools = resourceToTools(resource);
    const tool = tools.find((t) => t.name.includes("list_voices"));
    expect(tool).toBeDefined();
    expect(tool?.inputSchema).toHaveProperty("language");
    expect(tool?.inputSchema).toHaveProperty("limit");
  });
});
