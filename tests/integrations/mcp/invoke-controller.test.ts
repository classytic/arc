/**
 * Tests for the non-HTTP controller invocation surface (v2.15.5).
 *
 * Covers the gaps closed by the {@link invokeController} / {@link mcpHandlerAdapter}
 * pair that the mentora review flagged:
 *
 *  - "buildCtx synthetic-context hack" — `invokeController` owns the
 *    permission-eval + IRequestContext build + envelope/error conversion
 *    so MCP tool authors don't fabricate `params/body/headers` themselves.
 *  - "callController wrapper boilerplate" — `mcpHandlerAdapter` is the
 *    single try/catch → `CallToolResult` wrapper.
 *  - "inconsistent error shape" — denied permissions and thrown errors
 *    both emit the canonical `ErrorContract` JSON payload (`arc.forbidden`,
 *    `arc.unauthorized`, `arc.internal_error`, …) instead of ad-hoc
 *    `"Error: …"` strings.
 *
 * The tests deliberately stay at the unit layer — no Fastify, no MongoDB,
 * just a stub controller — because the contract being locked in is the
 * helper's behavior, not the full plugin wiring (which is exercised in
 * `tests/integrations/mcp/mcp-permissions.test.ts` and friends).
 */

import { describe, expect, it, vi } from "vitest";
import {
  invokeController,
  mcpHandlerAdapter,
} from "../../../src/integrations/mcp/invokeController.js";
import { filterResourcesForMcp } from "../../../src/integrations/mcp/mcpPlugin.js";
import type {
  CallToolResult,
  McpAuthResult,
  ToolContext,
} from "../../../src/integrations/mcp/types.js";
import type {
  IControllerResponse,
  PermissionCheck,
  PermissionContext,
} from "../../../src/types/index.js";
import { ArcError } from "../../../src/utils/errors.js";

// ============================================================================
// Helpers
// ============================================================================

const SESSION: McpAuthResult = { userId: "u-1", organizationId: "org-1" };

/** Decode the canonical `ErrorContract` JSON the MCP error helpers emit. */
function parseError(result: CallToolResult): { code: string; status?: number; message: string } {
  const entry = result.content[0] as { type: string; text: string };
  return JSON.parse(entry.text);
}

/** Decode a success payload as JSON — `invokeController` serialises via `toCallToolResult`. */
function parseSuccess(result: CallToolResult): unknown {
  const entry = result.content[0] as { type: string; text: string };
  return JSON.parse(entry.text);
}

function buildToolCtx(session: McpAuthResult | null = SESSION): ToolContext {
  return {
    session,
    log: vi.fn(async () => undefined),
    extra: {},
  };
}

/** Stub a controller method (`get`, `create`, …) that records its IRequestContext. */
function stubController(method: string, response: IControllerResponse) {
  const ctrl = {
    [method]: vi.fn(async (ctx: unknown) => response),
  };
  return ctrl as Record<string, unknown> & {
    [k: string]: ReturnType<typeof vi.fn>;
  };
}

// ============================================================================
// invokeController — happy path
// ============================================================================

describe("invokeController — dispatch", () => {
  it("calls the matching controller method with the synthetic IRequestContext", async () => {
    const controller = stubController("get", { data: { _id: "1", title: "Hello" } });

    const result = await invokeController(
      controller,
      "get",
      { id: "1" },
      { session: SESSION, resourceName: "post" },
    );

    expect(result.isError).toBeFalsy();
    expect(parseSuccess(result)).toEqual({ _id: "1", title: "Hello" });
    // Ctrl.get was called exactly once with a context carrying the session-derived scope.
    expect(controller.get).toHaveBeenCalledOnce();
    const ctx = (controller.get.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect(ctx.params).toEqual({ id: "1" });
    expect(ctx.body).toBeUndefined();
    expect((ctx.metadata as Record<string, unknown>)._scope).toMatchObject({
      kind: "member",
      organizationId: "org-1",
    });
  });

  it("routes update input through params/body (id in params, rest in body)", async () => {
    const controller = stubController("update", { data: { _id: "1", title: "Renamed" } });

    await invokeController(
      controller,
      "update",
      { id: "1", title: "Renamed" },
      { session: SESSION, resourceName: "post" },
    );

    const ctx = (controller.update.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect(ctx.params).toEqual({ id: "1" });
    expect(ctx.body).toEqual({ title: "Renamed" });
  });

  it("honors methodName override (custom-route dispatch by method name)", async () => {
    const controller = {
      archive: vi.fn(async () => ({ data: { archived: true } }) satisfies IControllerResponse),
    };

    const result = await invokeController(
      controller,
      "update",
      { id: "1" },
      { session: SESSION, resourceName: "post", methodName: "archive" },
    );

    expect(result.isError).toBeFalsy();
    expect(controller.archive).toHaveBeenCalledOnce();
  });
});

// ============================================================================
// invokeController — fail-closed paths
// ============================================================================

describe("invokeController — error shapes", () => {
  it("returns arc.not_implemented when the controller lacks the method", async () => {
    const controller = {};

    const result = await invokeController(
      controller,
      "get",
      { id: "1" },
      {
        session: SESSION,
        resourceName: "post",
      },
    );

    expect(result.isError).toBe(true);
    expect(parseError(result)).toMatchObject({
      code: "arc.not_implemented",
      status: 501,
    });
  });

  it("returns arc.forbidden when permission denies an authenticated caller", async () => {
    const denyAdmin: PermissionCheck = (_ctx: PermissionContext) => false;
    const controller = stubController("delete", { data: { ok: true } });

    const result = await invokeController(
      controller,
      "delete",
      { id: "1" },
      { session: SESSION, resourceName: "post", permissions: denyAdmin },
    );

    expect(result.isError).toBe(true);
    expect(parseError(result)).toMatchObject({ code: "arc.forbidden", status: 403 });
    // Controller never called when the gate fails closed.
    expect(controller.delete).not.toHaveBeenCalled();
  });

  it("returns arc.unauthorized when no session is present and permission denies", async () => {
    const deny: PermissionCheck = () => false;
    const controller = stubController("list", { data: [] });

    const result = await invokeController(
      controller,
      "list",
      {},
      {
        session: null,
        resourceName: "post",
        permissions: deny,
      },
    );

    expect(result.isError).toBe(true);
    expect(parseError(result)).toMatchObject({ code: "arc.unauthorized", status: 401 });
  });

  it("routes thrown ArcError through the canonical ErrorContract shape", async () => {
    const notFound = new ArcError("Post not found", {
      code: "arc.not_found",
      statusCode: 404,
    });
    const controller = {
      get: vi.fn(async () => {
        throw notFound;
      }),
    };

    const result = await invokeController(
      controller,
      "get",
      { id: "x" },
      {
        session: SESSION,
        resourceName: "post",
      },
    );

    expect(result.isError).toBe(true);
    expect(parseError(result)).toMatchObject({
      code: "arc.not_found",
      status: 404,
      message: "Post not found",
    });
  });

  it("collapses unknown errors to arc.internal_error 500", async () => {
    const controller = {
      get: vi.fn(async () => {
        throw new Error("boom");
      }),
    };

    const result = await invokeController(
      controller,
      "get",
      { id: "x" },
      {
        session: SESSION,
        resourceName: "post",
      },
    );

    expect(result.isError).toBe(true);
    expect(parseError(result)).toMatchObject({
      code: "arc.internal_error",
      status: 500,
    });
  });
});

// ============================================================================
// mcpHandlerAdapter
// ============================================================================

describe("mcpHandlerAdapter — wraps any async function as a tool handler", () => {
  it("passes a CallToolResult straight through", async () => {
    const sentinel: CallToolResult = {
      content: [{ type: "text", text: "from-fn" }],
    };
    const handler = mcpHandlerAdapter(async () => sentinel);

    const result = await handler({}, buildToolCtx());

    expect(result).toBe(sentinel);
  });

  it("wraps a raw value as a JSON success payload", async () => {
    const handler = mcpHandlerAdapter(async () => ({ ok: true, id: 1 }));

    const result = await handler({}, buildToolCtx());

    expect(result.isError).toBeFalsy();
    expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual({
      ok: true,
      id: 1,
    });
  });

  it("unwraps an IControllerResponse envelope via toCallToolResult", async () => {
    const handler = mcpHandlerAdapter(
      async () =>
        ({
          data: [{ _id: "1" }],
          meta: { total: 1, page: 1, limit: 20 },
        }) satisfies IControllerResponse,
    );

    const result = await handler({}, buildToolCtx());

    expect(result.isError).toBeFalsy();
    // `toCallToolResult` carries `meta` into the serialized payload — agents
    // see pagination totals without parsing a separate envelope shape.
    const payload = JSON.parse((result.content[0] as { text: string }).text);
    expect(payload).toEqual({ data: [{ _id: "1" }], total: 1, page: 1, limit: 20 });
  });

  it("catches thrown ArcError and emits the canonical error shape", async () => {
    const handler = mcpHandlerAdapter(async () => {
      throw new ArcError("Missing field", { code: "arc.bad_request", statusCode: 400 });
    });

    const result = await handler({}, buildToolCtx());

    expect(result.isError).toBe(true);
    expect(parseError(result)).toMatchObject({
      code: "arc.bad_request",
      status: 400,
      message: "Missing field",
    });
  });
});

// ============================================================================
// filterResourcesForMcp — `expose` default-deny precedence
// ============================================================================

describe("filterResourcesForMcp — expose / include / exclude precedence", () => {
  const resources = [{ name: "post" }, { name: "tag" }, { name: "comment" }];

  it("expose acts as default-deny — only listed resources survive", () => {
    const allowed = filterResourcesForMcp(resources, { expose: ["post"] });
    expect(allowed).toEqual([{ name: "post" }]);
  });

  it("expose with no match returns an empty list (default-deny — auto-deny new resources)", () => {
    const allowed = filterResourcesForMcp(resources, { expose: ["nope"] });
    expect(allowed).toEqual([]);
  });

  it("include behaves identically to expose (legacy alias)", () => {
    const allowed = filterResourcesForMcp(resources, { include: ["post", "tag"] });
    expect(allowed.map((r) => r.name)).toEqual(["post", "tag"]);
  });

  it("exclude filters out the listed names (default-allow)", () => {
    const allowed = filterResourcesForMcp(resources, { exclude: ["tag"] });
    expect(allowed.map((r) => r.name)).toEqual(["post", "comment"]);
  });

  it("no inputs surfaces every resource (default-allow)", () => {
    const allowed = filterResourcesForMcp(resources, {});
    expect(allowed).toEqual(resources);
  });

  it("throws when both `expose` and `include` are passed (conflict)", () => {
    expect(() => filterResourcesForMcp(resources, { expose: ["post"], include: ["tag"] })).toThrow(
      /expose.*include/i,
    );
  });

  it("throws when `expose` is combined with `exclude` (default-deny + opt-out is incoherent)", () => {
    expect(() => filterResourcesForMcp(resources, { expose: ["post"], exclude: ["tag"] })).toThrow(
      /redundant|expose/i,
    );
  });
});

// ============================================================================
// Custom session typing — generic ToolContext / ToolDefinition
// ============================================================================

describe("ToolContext<TSession> — host-shaped session typing", () => {
  it("compiles with a host-extended session shape and surfaces typed fields", async () => {
    interface MySession extends McpAuthResult {
      userId: string;
      organizationId: string;
      tenantPlan: "free" | "pro";
    }

    const handler = mcpHandlerAdapter<MySession>(async (_input, ctx) => {
      // The whole point of this test: `tenantPlan` is typed as a literal
      // union, not `unknown`. If this line ever requires `as any` to read
      // a custom field, the generic regressed and the test must fail at
      // compile time (which it does in CI via `tsc --noEmit`).
      return { plan: ctx.session?.tenantPlan ?? "anon" };
    });

    const session: MySession = {
      userId: "u-1",
      organizationId: "org-1",
      tenantPlan: "pro",
    };
    const result = await handler(
      {},
      {
        session,
        log: vi.fn(async () => undefined),
        extra: {},
      },
    );

    expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual({ plan: "pro" });
  });
});
