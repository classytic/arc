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

import { resolvePipelineSteps } from "../../core/routerShared.js";
import type { PermissionCheck } from "../../permissions/types.js";
import { executePipeline } from "../../pipeline/pipe.js";
import type { PipelineConfig, PipelineContext } from "../../pipeline/types.js";
import type { IControllerResponse } from "../../types/index.js";
import { buildRequestContext } from "./buildRequestContext.js";
import { evaluatePermission, toCallToolResult } from "./tool-helpers.js";
import type { CallToolResult, ToolDefinition } from "./types.js";

type ControllerMethod = (ctx: unknown) => Promise<IControllerResponse>;

/**
 * Options threaded through from the orchestrator so a custom-route MCP tool
 * enforces the same contract its REST counterpart does: permissions,
 * pipeline, and resource-scoped operation name.
 *
 * HTTP-only route wiring (`routeGuards`, `preAuth`, `preHandler`, multipart)
 * deliberately doesn't apply here — those hooks operate on Fastify
 * request/reply objects that don't exist in MCP. The contract arc CAN
 * enforce (permission check + pipeline steps) now runs identically on both
 * surfaces.
 */
export interface CustomRouteToolOptions {
  /** Resource name — used as the permission context's `resource` field. */
  readonly resourceName: string;
  /** Logical op name — keys into `pipeline` and appears in `PermissionContext.action`. */
  readonly operationName: string;
  /**
   * Permission check to evaluate before running the handler. `undefined`
   * means "no gate" — same semantics as CRUD routes without a declared
   * `permissions.<op>`. Authors who want action-router-style fail-closed
   * behaviour declare `allowPublic()` / `requireRoles(...)` explicitly.
   */
  readonly permissions?: PermissionCheck;
  /**
   * Resource-level pipeline config. Steps keyed by `operationName` run
   * around the handler — same `executePipeline` call the HTTP path uses.
   */
  readonly pipeline?: PipelineConfig;
}

/**
 * Build an MCP tool handler for a custom route.
 *
 * Enforces the same contract as the REST route:
 *   1. **Permission evaluation** via the shared `evaluatePermission` — the
 *      exact path CRUD and action MCP tools use. Filters and scope from a
 *      `PermissionResult` thread through `buildRequestContext`.
 *   2. **Pipeline integration** — function handlers run inside
 *      `executePipeline` with the same steps the HTTP path resolves.
 *   3. **Controller dispatch** for string handlers.
 *
 * `hasId` signals whether the route path uses `:id`, which determines
 * whether we treat the call as an update-shaped or create-shaped request
 * when hydrating the request context.
 */
export function createCustomRouteHandler(
  route: { handler: unknown; operation?: string; method: string; path: string },
  controller: unknown,
  hasId: boolean,
  options: CustomRouteToolOptions,
): ToolDefinition["handler"] {
  const ctrl = controller as unknown as Record<string, ControllerMethod> | undefined;
  const handlerName =
    typeof route.handler === "string"
      ? route.handler
      : (route.operation ?? slugifyRoute(route.method, route.path));
  const { resourceName, operationName, permissions, pipeline } = options;
  const pipelineSteps = resolvePipelineSteps(pipeline, operationName);

  return async (input, _ctx) => {
    const session = _ctx.session;

    // Permission evaluation — SAME path as CRUD/action tools. Without this
    // a route declared with `permissions: requireRoles(['admin'])` was
    // callable via MCP with no gate, because the MCP tool bypassed the
    // Fastify preHandler chain entirely. Fixes the high-severity parity
    // hole flagged in the 2.11 review.
    const permResult = await evaluatePermission(
      permissions,
      session,
      resourceName,
      operationName,
      input,
    );
    if (permResult && !permResult.granted) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: false,
              error:
                permResult.reason ??
                (session ? `Permission denied for '${operationName}'` : "Authentication required"),
            }),
          },
        ],
        isError: true,
      };
    }

    try {
      const kind = hasId ? "update" : "create";
      const reqCtx = buildRequestContext(
        input,
        session,
        kind,
        permResult?.filters,
        permResult?.scope,
      );

      // Function-handler case — arc's pipeline-wrapped handler is the route's
      // own `handler`. No controller lookup needed.
      if (typeof route.handler === "function") {
        const fn = route.handler as (req: typeof reqCtx) => Promise<unknown>;

        // Pipeline parity: resolve steps keyed by the route's operation name
        // (same key REST uses), wrap the handler in `executePipeline`. When
        // no steps are configured the handler runs directly — identical
        // behaviour to the REST router's fast path.
        if (pipelineSteps.length > 0) {
          const pipeCtx: PipelineContext = {
            ...reqCtx,
            resource: resourceName,
            operation: operationName,
          };
          const response = await executePipeline(
            pipelineSteps,
            pipeCtx,
            async (ctx) => {
              const raw = await fn(ctx as typeof reqCtx);
              return raw !== null && typeof raw === "object" && "success" in raw
                ? (raw as IControllerResponse)
                : ({ success: true, data: raw } as IControllerResponse);
            },
            operationName,
          );
          return toCallToolResult(response);
        }
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
