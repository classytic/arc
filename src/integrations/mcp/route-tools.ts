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
import type { FieldPermissionMap } from "../../permissions/fields.js";
import type { PermissionCheck } from "../../permissions/types.js";
import { executePipeline } from "../../pipeline/pipe.js";
import type { PipelineConfig, PipelineContext } from "../../pipeline/types.js";
import type { ServerAccessor } from "../../types/handlers.js";
import type { IControllerResponse } from "../../types/index.js";
import {
  buildRequestContext,
  type McpContextExtras,
  type McpOperation,
} from "./buildRequestContext.js";
import {
  applyMcpReadMasking,
  evaluatePermission,
  permissionDeniedResult,
  toCallToolError,
  toCallToolResult,
} from "./tool-helpers.js";
import type { CallToolResult, McpExecutionWiring, ToolDefinition } from "./types.js";

type ControllerMethod = (ctx: unknown) => Promise<IControllerResponse>;

/**
 * Pick the IRequestContext shape MCP should produce when invoking a
 * custom route's handler. Mirrors the HTTP semantics of the route:
 *
 * | HTTP                           | MCP kind  | params  | body  | query |
 * |--------------------------------|-----------|---------|-------|-------|
 * | `GET /thing` (no :id)          | `list`    | -       | -     | input |
 * | `GET /thing/:id`               | `get`     | { id }  | -     | input |
 * | `POST /thing` (no :id)         | `create`  | -       | input | -     |
 * | `PUT|PATCH /thing/:id`         | `update`  | { id }  | rest  | -     |
 * | `DELETE /thing/:id`            | `delete`  | { id }  | -     | -     |
 * | `POST /thing/:id` (any other)  | `update`  | { id }  | rest  | -     |
 *
 * Pre-2.15.5 every custom route used `update`/`create` regardless of method.
 * That broke GET-route bridging the moment a handler read `ctx.query` — MCP
 * stuffed the input into `ctx.body` instead and the handler returned empty.
 * The `kind` mapping below is the single source of truth that keeps HTTP
 * and MCP invocations producing the same `IRequestContext` shape.
 */
export function operationKindForRoute(method: string, hasId: boolean): McpOperation {
  const upper = method.toUpperCase();
  if (upper === "GET") return hasId ? "get" : "list";
  if (upper === "DELETE") return "delete";
  // POST without :id → create; POST/PUT/PATCH with :id → update.
  if (hasId) return "update";
  return "create";
}

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
  /**
   * Resource field-permission map — field-level READ masking applies to
   * the tool payload exactly as the HTTP arc decorator applies it to the
   * REST response for the same route.
   */
  readonly fields?: FieldPermissionMap;
  /**
   * App-level execution wiring — threads `metadata.arc` (hooks/events) +
   * `server` accessor into the synthetic context so a route handler that
   * dispatches to controller methods (or reads `ctx.server.events`) runs
   * with full HTTP parity.
   */
  readonly wiring?: McpExecutionWiring;
  /** Resource `schemaOptions` — rides on `metadata.arc` like HTTP. */
  readonly schemaOptions?: unknown;
  /** Resource `idField` — rides on `metadata.arc` for `getEntityIdField()`. */
  readonly idField?: string;
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
  const { resourceName, operationName, permissions, pipeline, fields, wiring } = options;
  const pipelineSteps = resolvePipelineSteps(pipeline, operationName);
  // Same shape invokeController assembles — hooks/events/server parity for
  // route handlers that dispatch to controller methods.
  const contextExtras: McpContextExtras | undefined = wiring
    ? {
        arc: {
          resourceName,
          schemaOptions: options.schemaOptions,
          permissions,
          hooks: wiring.hooks,
          events: wiring.events,
          fields,
          idField: options.idField,
        },
        server: {
          events: wiring.events as ServerAccessor["events"],
          audit: wiring.audit as ServerAccessor["audit"],
          log: wiring.log as ServerAccessor["log"],
        },
      }
    : undefined;

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
      return permissionDeniedResult({
        resource: resourceName,
        operation: operationName,
        reason: permResult.reason,
        session,
      });
    }

    try {
      // 2.15.5 — pick the IRequestContext shape based on HTTP method, not just
      // presence of `:id`. GET routes route input through `query` so handlers
      // that read `ctx.query` work without an explicit `mcpHandler`. See
      // `operationKindForRoute` for the full table.
      const kind = operationKindForRoute(route.method, hasId);
      const reqCtx = buildRequestContext(
        input,
        session,
        kind,
        permResult?.filters,
        permResult?.scope,
        contextExtras,
      );

      // Field-read masking at the serialization boundary — same policy
      // step `sendControllerResponse` runs for this route's REST twin.
      const emit = (envelope: IControllerResponse): CallToolResult => {
        const data = applyMcpReadMasking(envelope.data, {
          fields,
          session,
          scopeOverride: permResult?.scope,
        });
        return toCallToolResult(data === envelope.data ? envelope : { ...envelope, data });
      };

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
              // New IControllerResponse shape: `{ data, status?, headers?, meta? }`.
              // Wrap raw return values; pass through full envelopes that already
              // carry a `data` slot.
              return raw !== null && typeof raw === "object" && "data" in raw
                ? (raw as IControllerResponse)
                : ({ data: raw } as IControllerResponse);
            },
            operationName,
          );
          return emit(response);
        }
        const out = (await fn(reqCtx)) as unknown;
        const envelope =
          out !== null && typeof out === "object" && "data" in out
            ? (out as IControllerResponse)
            : ({ data: out } as IControllerResponse);
        return emit(envelope);
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
      return emit(await method(reqCtx));
    } catch (err) {
      // Canonical error contract — same shape CRUD/action/aggregation tools
      // emit. Raw `Error: ${msg}` strings lost ArcError code/status and
      // leaked internal messages to MCP clients (routes had drifted).
      return toCallToolError(err instanceof Error ? err : new Error(String(err)));
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
      // Same canonical contract as the pipeline-backed handlers above.
      return toCallToolError(err instanceof Error ? err : new Error(String(err)));
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
