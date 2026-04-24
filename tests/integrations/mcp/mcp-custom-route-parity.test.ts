/**
 * MCP custom-route parity — v2.11.x regression tests
 *
 * Before this refactor, `resource.routes` entries were exposed as MCP tools
 * WITHOUT honoring:
 *   - `route.permissions` — tools ran the handler regardless of session
 *     roles, so a route gated by `requireRoles(['admin'])` on HTTP was
 *     callable anonymously via MCP.
 *   - `resource.pipe` — function handlers ran outside arc's pipeline, so
 *     guards/transforms/interceptors that protected the REST surface had
 *     no equivalent on the MCP surface.
 *   - `route.schema` — MCP input schema had only `id`, ignoring body and
 *     querystring definitions authors wrote once for REST validation.
 *
 * These tests pin the fixed behaviour:
 *
 *   1. Permission enforcement — `requireRoles(['admin'])` tool call with
 *      a non-admin session returns `isError: true` and doesn't execute
 *      the handler.
 *   2. Pipeline parity — a guard/transform/interceptor configured on
 *      `resource.pipe` runs around the MCP call, same shape REST uses.
 *   3. Input schema parity — a route declared with
 *      `schema: { body: z.object({carrier: z.string()}) }` produces an MCP
 *      tool whose `inputSchema` has the `carrier` field.
 */

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { ResourceDefinition } from "../../../src/core/defineResource.js";
import { resourceToTools } from "../../../src/integrations/mcp/resourceToTools.js";
import type { ToolContext } from "../../../src/integrations/mcp/types.js";
import { allowPublic, requireRoles } from "../../../src/permissions/index.js";
import type { Guard, Interceptor, Transform } from "../../../src/pipeline/types.js";

// ============================================================================
// Helpers
// ============================================================================

function makeResource(overrides: Partial<ResourceDefinition>): ResourceDefinition {
  return {
    name: "order",
    displayName: "Orders",
    prefix: "/orders",
    disabledRoutes: [],
    disableDefaultRoutes: true,
    schemaOptions: {},
    permissions: {},
    routes: [],
    _appliedPresets: [],
    tag: "Orders",
    customSchemas: {},
    middlewares: {},
    events: {},
    ...overrides,
  } as ResourceDefinition;
}

function toolCtx(session: Record<string, unknown> | null): ToolContext {
  return {
    session: session as ToolContext["session"],
  } as ToolContext;
}

// ============================================================================
// 1. Permission enforcement parity
// ============================================================================

describe("MCP custom routes — route.permissions enforced", () => {
  it("requireRoles tool call with no session → isError (401-equivalent)", async () => {
    const handlerSpy = vi.fn(async () => ({ success: true, data: { exported: true } }));

    const resource = makeResource({
      name: "report",
      prefix: "/reports",
      routes: [
        {
          method: "POST",
          path: "/export",
          operation: "export_report",
          handler: handlerSpy,
          permissions: requireRoles(["admin"]),
        },
      ],
    });

    const tools = resourceToTools(resource);
    const tool = tools.find((t) => t.name.includes("export"));
    expect(tool).toBeDefined();

    // Unauthenticated call
    const result = await tool?.handler({}, toolCtx(null));
    expect(result?.isError).toBe(true);
    // Handler must NOT have run — the permission gate blocks before dispatch.
    expect(handlerSpy).not.toHaveBeenCalled();
    // The error payload echoes the permission evaluator's standard message.
    const text = result?.content?.[0]?.text as string;
    expect(text).toContain("Authentication required");
  });

  it("requireRoles tool call WITH matching role → handler runs, tool succeeds", async () => {
    const handlerSpy = vi.fn(async () => ({ success: true, data: { exported: true } }));

    const resource = makeResource({
      name: "report",
      prefix: "/reports",
      routes: [
        {
          method: "POST",
          path: "/export",
          operation: "export_report",
          handler: handlerSpy,
          permissions: requireRoles(["admin"]),
        },
      ],
    });

    const tools = resourceToTools(resource);
    const tool = tools.find((t) => t.name.includes("export"));
    expect(tool).toBeDefined();

    // Arc's permission system reads `user.role` (singular) via
    // `getUserRoles`, which normalizes string/array/CSV inputs. McpAuthResult
    // also has a `roles: string[]` slot, but the canonical field requireRoles
    // reads is `role` — the session spread into `user` must carry it there.
    const result = await tool?.handler({}, toolCtx({ userId: "u1", role: ["admin"] }));
    expect(result?.isError).not.toBe(true);
    expect(handlerSpy).toHaveBeenCalledTimes(1);
  });

  it("requireRoles tool call WITHOUT matching role → isError (403-equivalent)", async () => {
    const handlerSpy = vi.fn(async () => ({ success: true, data: { exported: true } }));

    const resource = makeResource({
      name: "report",
      prefix: "/reports",
      routes: [
        {
          method: "POST",
          path: "/export",
          operation: "export_report",
          handler: handlerSpy,
          permissions: requireRoles(["admin"]),
        },
      ],
    });

    const tools = resourceToTools(resource);
    const tool = tools.find((t) => t.name.includes("export"));

    const result = await tool?.handler({}, toolCtx({ userId: "u2", role: ["viewer"] }));
    expect(result?.isError).toBe(true);
    expect(handlerSpy).not.toHaveBeenCalled();
  });

  it("allowPublic routes skip the permission gate cleanly (no false-positive denial)", async () => {
    const handlerSpy = vi.fn(async () => ({ success: true, data: { stats: 42 } }));

    const resource = makeResource({
      name: "report",
      prefix: "/reports",
      routes: [
        {
          method: "POST",
          path: "/publish",
          operation: "publish_report",
          handler: handlerSpy,
          permissions: allowPublic(),
        },
      ],
    });

    const tools = resourceToTools(resource);
    const tool = tools.find((t) => t.name.includes("publish"));

    const result = await tool?.handler({}, toolCtx(null));
    expect(result?.isError).not.toBe(true);
    expect(handlerSpy).toHaveBeenCalledTimes(1);
  });
});

// ============================================================================
// 2. Pipeline integration parity
// ============================================================================

describe("MCP custom routes — resource.pipe runs around handler", () => {
  it("runs guard + transform + interceptor for a function-handler route", async () => {
    const callOrder: string[] = [];

    const recordingGuard: Guard = {
      _type: "guard",
      name: "recordingGuard",
      handler: () => {
        callOrder.push("guard");
        return true;
      },
    };
    const recordingTransform: Transform = {
      _type: "transform",
      name: "recordingTransform",
      handler: (ctx) => {
        callOrder.push("transform");
        return ctx;
      },
    };
    const recordingInterceptor: Interceptor = {
      _type: "interceptor",
      name: "recordingInterceptor",
      handler: async (_ctx, next) => {
        callOrder.push("interceptor:before");
        const result = await next();
        callOrder.push("interceptor:after");
        return result;
      },
    };

    const resource = makeResource({
      name: "report",
      prefix: "/reports",
      routes: [
        {
          method: "POST",
          path: "/build",
          operation: "build_report",
          handler: async () => {
            callOrder.push("handler");
            return { success: true, data: { built: true } };
          },
          permissions: allowPublic(),
        },
      ],
      pipe: { build_report: [recordingGuard, recordingTransform, recordingInterceptor] },
    });

    const tools = resourceToTools(resource);
    const tool = tools.find((t) => t.name.includes("build"));

    const result = await tool?.handler({}, toolCtx({ userId: "u1" }));
    expect(result?.isError).not.toBe(true);
    expect(callOrder).toEqual([
      "guard",
      "transform",
      "interceptor:before",
      "handler",
      "interceptor:after",
    ]);
  });

  it("routes with no matching pipeline entry run the handler directly (no wrapper cost)", async () => {
    const callOrder: string[] = [];

    const resource = makeResource({
      name: "report",
      prefix: "/reports",
      routes: [
        {
          method: "POST",
          path: "/quickstat",
          operation: "quickstat",
          handler: async () => {
            callOrder.push("handler");
            return { success: true, data: {} };
          },
          permissions: allowPublic(),
        },
      ],
      // Pipeline keyed only for 'other_op' — quickstat should skip.
      pipe: {
        other_op: [
          {
            _type: "guard",
            name: "g",
            handler: () => {
              callOrder.push("wrong-guard");
              return true;
            },
          },
        ],
      },
    });

    const tools = resourceToTools(resource);
    const tool = tools.find((t) => t.name.includes("quickstat"));

    await tool?.handler({}, toolCtx({ userId: "u1" }));
    expect(callOrder).toEqual(["handler"]);
  });
});

// ============================================================================
// 3. Input schema parity with route.schema
// ============================================================================

describe("MCP custom routes — inputSchema derived from route.schema", () => {
  it("route.schema.body (Zod) → MCP tool inputSchema has body fields", () => {
    const resource = makeResource({
      name: "report",
      prefix: "/reports",
      routes: [
        {
          method: "POST",
          path: "/export",
          operation: "export_report",
          handler: async () => ({ success: true, data: {} }),
          permissions: allowPublic(),
          schema: {
            body: z.object({
              carrier: z.string(),
              includeAttachments: z.boolean().optional(),
            }),
          } as Record<string, unknown>,
        },
      ],
    });

    const tools = resourceToTools(resource);
    const tool = tools.find((t) => t.name.includes("export"));

    expect(tool?.inputSchema).toBeDefined();
    const schema = tool?.inputSchema as Record<string, z.ZodTypeAny>;
    expect(schema).toHaveProperty("carrier");
    expect(schema).toHaveProperty("includeAttachments");
    // Required fields validate, missing required fields reject
    expect(() => schema.carrier.parse("fedex")).not.toThrow();
    expect(() => schema.carrier.parse(undefined)).toThrow();
    // Optional fields accept undefined
    expect(() => schema.includeAttachments.parse(undefined)).not.toThrow();
  });

  it("route.schema.body (JSON Schema) → MCP tool inputSchema has body fields", () => {
    const resource = makeResource({
      name: "report",
      prefix: "/reports",
      routes: [
        {
          method: "POST",
          path: "/notify",
          operation: "notify",
          handler: async () => ({ success: true, data: {} }),
          permissions: allowPublic(),
          schema: {
            body: {
              type: "object",
              properties: {
                recipient: { type: "string" },
                priority: { type: "string", enum: ["low", "normal", "high"] },
              },
              required: ["recipient"],
            },
          } as Record<string, unknown>,
        },
      ],
    });

    const tools = resourceToTools(resource);
    const tool = tools.find((t) => t.name.includes("notify"));
    const schema = tool?.inputSchema as Record<string, z.ZodTypeAny>;

    expect(schema).toHaveProperty("recipient");
    expect(schema).toHaveProperty("priority");
    expect(() => schema.priority.parse("high")).not.toThrow();
    expect(() => schema.priority.parse("urgent")).toThrow();
  });

  it("route with path :id preserves `id` in inputSchema alongside body fields", () => {
    const resource = makeResource({
      name: "order",
      prefix: "/orders",
      routes: [
        {
          method: "POST",
          path: "/:id/dispatch",
          operation: "dispatch_order",
          handler: async () => ({ success: true, data: {} }),
          permissions: allowPublic(),
          schema: {
            body: z.object({ carrier: z.string() }),
          } as Record<string, unknown>,
        },
      ],
    });

    const tools = resourceToTools(resource);
    const tool = tools.find((t) => t.name.includes("dispatch"));
    const schema = tool?.inputSchema as Record<string, z.ZodTypeAny>;

    expect(schema).toHaveProperty("id");
    expect(schema).toHaveProperty("carrier");
  });

  it("body fields take precedence over querystring fields with the same name", () => {
    // Edge case: if a route declares both body and querystring with a
    // `limit` field, body should win (primary input channel for POSTs).
    const resource = makeResource({
      name: "report",
      prefix: "/reports",
      routes: [
        {
          method: "POST",
          path: "/search",
          operation: "search",
          handler: async () => ({ success: true, data: [] }),
          permissions: allowPublic(),
          schema: {
            body: { type: "object", properties: { limit: { type: "integer" } } },
            querystring: { type: "object", properties: { limit: { type: "string" } } },
          } as Record<string, unknown>,
        },
      ],
    });

    const tools = resourceToTools(resource);
    const tool = tools.find((t) => t.name.includes("search"));
    const schema = tool?.inputSchema as Record<string, z.ZodTypeAny>;

    // Body defined limit as integer; must parse 10 as valid
    expect(() => schema.limit.parse(10)).not.toThrow();
    // Would fail if querystring's `string` type had won
    expect(() => schema.limit.parse("10")).toThrow();
  });
});
