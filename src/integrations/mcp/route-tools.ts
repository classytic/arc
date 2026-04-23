/**
 * Custom-route → MCP tool generation.
 *
 * Converts arc's `routes[]` entries (declared via `defineResource({
 * routes: [...] })`) into MCP tools. Three handler shapes are supported:
 *
 * 1. `mcpHandler` (full bypass) — caller-supplied function owns the whole
 *    tool result; pipeline is not invoked.
 * 2. Function handler with `raw: false/undefined` — arc's pipeline wrapper
 *    runs normally, and the envelope is serialized into the tool result.
 * 3. String handler — looks up a method on the controller by name.
 */

import { buildRequestContext } from "./buildRequestContext.js";
import type { IControllerResponse } from "../../types/index.js";
import { toCallToolResult } from "./tool-helpers.js";
import type { CallToolResult, ToolDefinition } from "./types.js";

type ControllerMethod = (ctx: unknown) => Promise<IControllerResponse>;

/**
 * Build an MCP tool handler for a custom route. `hasId` signals whether
 * the route path uses `:id`, which determines whether we treat the call
 * as an update-shaped or create-shaped request when hydrating the
 * request context.
 */
export function createCustomRouteHandler(
  route: { handler: unknown; operation?: string; method: string; path: string },
  controller: unknown,
  hasId: boolean,
): ToolDefinition["handler"] {
  const ctrl = controller as unknown as Record<string, ControllerMethod> | undefined;
  const handlerName =
    typeof route.handler === "string"
      ? route.handler
      : (route.operation ?? slugifyRoute(route.method, route.path));

  return async (input, _ctx) => {
    try {
      // Function-handler case — arc's pipeline-wrapped handler is the route's
      // own `handler`. No controller lookup needed.
      if (typeof route.handler === "function") {
        const reqCtx = buildRequestContext(input, _ctx.session, hasId ? "update" : "create");
        const fn = route.handler as (req: ReturnType<typeof buildRequestContext>) => Promise<unknown>;
        const out = (await fn(reqCtx)) as unknown;
        const envelope =
          out !== null && typeof out === "object" && "success" in out
            ? (out as { success: boolean; data?: unknown })
            : { success: true, data: out };
        return toCallToolResult(envelope as IControllerResponse);
      }

      // String-handler case — look up on the controller.
      if (!ctrl) {
        return {
          content: [{ type: "text", text: `Handler "${handlerName}" has no controller available` }],
          isError: true,
        };
      }
      const method = ctrl[handlerName];
      if (typeof method !== "function") {
        return {
          content: [{ type: "text", text: `Handler "${handlerName}" not found on controller` }],
          isError: true,
        };
      }
      const reqCtx = buildRequestContext(input, _ctx.session, hasId ? "update" : "create");
      return toCallToolResult(await method(reqCtx));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
    }
  };
}

/**
 * Build an MCP tool handler around a caller-supplied `mcpHandler` — no
 * pipeline, no envelope translation, the function owns the whole
 * `CallToolResult`. Only surfaces errors as tool-error results.
 */
export function createMcpHandlerPassthrough(
  mcpHandler: (input: Record<string, unknown>) => Promise<CallToolResult>,
): ToolDefinition["handler"] {
  return async (input) => {
    try {
      return await mcpHandler(input);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
    }
  };
}

/**
 * Slugify `{method, path}` into a readable tool-operation name when the
 * route definition doesn't supply an explicit `operation`.
 */
export function slugifyRoute(method: string, path: string): string {
  const clean = path
    .replace(/:[^/]+/g, "")
    .replace(/^\/+|\/+$/g, "")
    .replace(/\//g, "_");
  return clean ? `${method.toLowerCase()}_${clean}` : method.toLowerCase();
}
