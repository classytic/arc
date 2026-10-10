/**
 * @classytic/arc — Non-HTTP controller invocation for MCP / jobs / workflows.
 *
 * Internal callers (MCP tools, scheduled jobs, workflow steps) need to invoke
 * controller methods without going through Fastify's preHandler chain.
 * Before this module landed, every call site reinvented the same shim:
 * fabricate `params` / `body` / `headers`, project the session into a
 * `RequestScope`, run the permission check by hand, translate thrown errors
 * to the MCP `CallToolResult` shape. The drift across those copies is what
 * the mentora review flagged as the "buildCtx synthetic-context hack."
 *
 * Two public surfaces, layered so callers reach for the smallest piece that
 * does the job:
 *
 *   - {@link invokeController}    full pipeline: permission → context →
 *                                 dispatch → canonical envelope/error
 *                                 conversion. Returns `CallToolResult`.
 *   - {@link mcpHandlerAdapter}   thin try/catch wrapper that turns any
 *                                 async function into a `ToolDefinition`
 *                                 handler with canonical error shape. Use
 *                                 when you want to compose multiple
 *                                 controller calls or weave in custom logic
 *                                 between them.
 *
 * Both honor the same {@link buildRequestContext} primitive — re-exported
 * from this module so authors who want the synthetic context as data (e.g.
 * to pass into `executePipeline`) can grab it without depending on an
 * internal subpath.
 */

import type { FieldPermissionMap } from "../../permissions/fields.js";
import type { PermissionCheck } from "../../permissions/types.js";
import type { RequestScope } from "../../scope/types.js";
import type { ServerAccessor } from "../../types/handlers.js";
import type { ArcInternalMetadata, IControllerResponse } from "../../types/index.js";
import {
  buildRequestContext as buildRequestContextInternal,
  type McpContextExtras,
  type McpOperation,
} from "./buildRequestContext.js";
import {
  idempotencyStoreOf,
  rateLimitedResult,
  runIdempotentTool,
  type ToolAdmission,
} from "./http-parity.js";
import {
  applyMcpReadMasking,
  evaluatePermission,
  permissionDeniedResult,
  toCallToolError,
  toCallToolResult,
} from "./tool-helpers.js";
import type {
  CallToolResult,
  McpAuthResult,
  McpExecutionWiring,
  ToolContext,
  ToolDefinition,
} from "./types.js";

export {
  buildRequestContext,
  type McpOperation,
} from "./buildRequestContext.js";

/** Controller method shape accepted by {@link invokeController}. */
type ControllerMethod = (ctx: unknown) => Promise<IControllerResponse>;

/**
 * Options threaded into {@link invokeController}. `session` is required so
 * permission checks and scope resolution can both honor the caller's
 * identity; everything else is optional and falls back to sensible defaults.
 */
export interface InvokeControllerOptions {
  readonly allow?: ToolAdmission;
  /** Resolved identity for this invocation — `null` runs as public scope. */
  readonly session: McpAuthResult | null;
  readonly tenantMiddlewares?: readonly unknown[];
  /** Resource name surfaced into the permission context (`PermissionContext.resource`). */
  readonly resourceName: string;
  /**
   * Logical action name surfaced into the permission context
   * (`PermissionContext.action`). Defaults to `op` — pass a distinct name
   * for custom routes / declarative actions to keep audit logs readable.
   */
  readonly actionName?: string;
  /**
   * Permission to evaluate before invoking the controller. `undefined` means
   * "no gate" — same semantics as CRUD without a declared `permissions.<op>`.
   * Authors that want fail-closed behavior should pass `requireAuth()` or a
   * concrete role gate; `allowPublic()` documents an intentional opt-out.
   */
  readonly permissions?: PermissionCheck;
  /**
   * Method name on the controller. Defaults to `op`. Override for custom-route
   * dispatch where the method name differs from the MCP operation (e.g. an
   * action handler reached through a `string` route handler).
   */
  readonly methodName?: string;
  /**
   * Resource field-permission map (`ResourceConfig.fields`). When present,
   * field-level READ permissions are applied to the response payload before
   * serialization — the same masking the HTTP wire and realtime frames get.
   * Omit only for tools whose output carries no resource documents.
   */
  readonly fields?: FieldPermissionMap;
  /**
   * App-level execution wiring (hooks system, event bus, audit, logger,
   * idempotency store). When present, the synthetic request context carries
   * `metadata.arc` + `server` exactly like HTTP's `createRequestContext` —
   * so resource hooks run, CRUD events publish, and `ctx.server.*` works.
   * `mcpPlugin` supplies this automatically; omit for dispatch-only calls.
   */
  readonly wiring?: McpExecutionWiring;
  /** Resource `schemaOptions` — rides on `metadata.arc` like HTTP. */
  readonly schemaOptions?: unknown;
  /** Resource `idField` — rides on `metadata.arc` for `getEntityIdField()`. */
  readonly idField?: string;
  /**
   * Caller-supplied idempotency key (mutations only). Requires
   * `wiring.idempotencyStore`; the executor then runs the same
   * check → lock → execute → record → replay protocol the HTTP
   * idempotency plugin runs, keyed by tool + input + caller identity.
   * A concurrent call with the same key gets a 409 `arc.idempotency_conflict`.
   */
  readonly idempotencyKey?: string;
}

/**
 * Assemble the {@link McpContextExtras} for a controller invocation from
 * resource-scoped metadata + app-level wiring. Mirrors what
 * `buildArcDecorator` (metadata.arc) and `createRequestContext` (server
 * accessor) assemble on the HTTP path.
 */
function buildContextExtras(options: InvokeControllerOptions): McpContextExtras | undefined {
  const { wiring, resourceName, permissions, fields, schemaOptions, idField } = options;
  if (!wiring) return { tenantMiddlewares: options.tenantMiddlewares };
  return {
    tenantMiddlewares: options.tenantMiddlewares,
    arc: {
      resourceName,
      schemaOptions,
      permissions,
      hooks: wiring.hooks,
      events: wiring.events,
      fields,
      idField,
    },
    server: {
      events: wiring.events as ServerAccessor["events"],
      audit: wiring.audit as ServerAccessor["audit"],
      log: wiring.log as ServerAccessor["log"],
    },
  };
}

/**
 * Invoke a controller method through the MCP synthetic-context path.
 *
 * Runs the same chain CRUD MCP tools run:
 *   1. {@link evaluatePermission} — fails with the canonical
 *      `arc.unauthorized` / `arc.forbidden` `CallToolResult` shape on denial.
 *   2. {@link buildRequestContext} — projects MCP input + session into
 *      `IRequestContext`. Permission `filters` / `scope` thread through
 *      identically to CRUD/action routes.
 *   3. `controller[methodName](ctx)` — dispatch. Errors are routed through
 *      `toCallToolError` so `ArcError` / `HttpError` throws land as the same
 *      `ErrorContract` shape an HTTP client would see.
 *
 * @example Run a controller op from a custom MCP tool.
 * ```ts
 * defineTool('promote_post', {
 *   description: 'Promote a draft to published',
 *   inputSchema: { id: z.string() },
 *   handler: (input, ctx) =>
 *     invokeController(postController, 'update', { ...input, status: 'published' }, {
 *       session: ctx.session,
 *       resourceName: 'post',
 *       permissions: requireRoles(['editor']),
 *     }),
 * });
 * ```
 *
 * Workflow / scheduled-job callers pass a synthetic `session` they
 * constructed from the job's owning identity — the shape is the same
 * `McpAuthResult` the HTTP MCP plugin produces, so the same permission
 * checks compose.
 */
export async function invokeController(
  controller: unknown,
  op: McpOperation,
  input: Record<string, unknown>,
  options: InvokeControllerOptions,
): Promise<CallToolResult> {
  const {
    session,
    resourceName,
    actionName = op,
    permissions,
    methodName = op,
    fields,
    wiring,
    idempotencyKey,
  } = options;
  const ctrl = controller as Record<string, ControllerMethod | undefined>;

  try {
    const method = ctrl[methodName];
    if (typeof method !== "function") {
      return toCallToolError({
        code: "arc.not_implemented",
        message: `Method '${methodName}' not available on '${resourceName}' controller`,
        status: 501,
      });
    }

    const permResult = await evaluatePermission(
      permissions,
      session,
      resourceName,
      actionName,
      input,
    );
    if (permResult && permResult.effect !== "allow") {
      return permissionDeniedResult({
        resource: resourceName,
        operation: actionName,
        reason: permResult.reason,
        session,
      });
    }

    const reqCtx = buildRequestContextInternal(
      input,
      session,
      op,
      permResult?.policy,
      permResult?.scope as RequestScope | undefined,
      buildContextExtras(options),
    );
    if (
      options.allow &&
      !(await options.allow(session, (reqCtx.metadata as ArcInternalMetadata)._scope))
    )
      return rateLimitedResult(actionName);
    const dispatch = async (): Promise<CallToolResult> => {
      const response = await method(reqCtx);
      // Field-read masking — same policy step the HTTP adapter runs in
      // `sendControllerResponse`. Applied AFTER dispatch so hooks/pipeline
      // see full documents, masked only at the serialization boundary.
      const data = applyMcpReadMasking(response.data, {
        fields,
        session,
        scopeOverride: permResult?.scope as RequestScope | undefined,
      });
      return toCallToolResult(data === response.data ? response : { ...response, data });
    };

    // Same protocol as the HTTP idempotency plugin; error results are never cached.
    const store = idempotencyStoreOf(wiring?.idempotencyStore);
    if (idempotencyKey && store) {
      return await runIdempotentTool({
        store,
        allowUnfencedCompletion: wiring?.allowUnfencedCompletion,
        idempotencyTtlMs: wiring?.idempotencyTtlMs,
        idempotencyLockTimeoutMs: wiring?.idempotencyLockTimeoutMs,
        key: idempotencyKey,
        resourceName,
        operation: actionName,
        input,
        session,
        scope: (reqCtx.metadata as ArcInternalMetadata)._scope,
        dispatch,
      });
    }

    return await dispatch();
  } catch (err) {
    return toCallToolError(err instanceof Error ? err : new Error(String(err)));
  }
}

/**
 * Wrap an async function as a {@link ToolDefinition} handler — handles the
 * try/catch → canonical-error translation in one place so MCP tools that
 * compose multiple internal calls don't reimplement the boilerplate.
 *
 * The wrapped function may return:
 *  - A `CallToolResult` — passed through unchanged (use this to short-circuit
 *    with `permissionDeniedResult` or a custom error shape).
 *  - An `IControllerResponse` envelope (`{ data, meta?, status?, headers? }`)
 *    — serialised via `toCallToolResult` so pagination meta etc. survive.
 *  - Any other value — serialised as JSON via `toCallToolSuccess` semantics.
 *
 * Errors raised inside the function are caught and routed through
 * `toCallToolError`, so `ArcError` / `HttpError` throws collapse to the
 * canonical `ErrorContract` shape MCP agents see for every other surface.
 *
 * @example Compose two controller calls in one tool.
 * ```ts
 * defineTool('archive_and_log', {
 *   description: '...',
 *   handler: mcpHandlerAdapter(async (input, ctx) => {
 *     await invokeController(postController, 'update', { ...input, archived: true }, opts);
 *     return invokeController(auditController, 'create', { event: 'archive', ...input }, opts);
 *   }),
 * });
 * ```
 */
export function mcpHandlerAdapter<TSession = McpAuthResult>(
  fn: (input: Record<string, unknown>, ctx: ToolContext<TSession>) => Promise<unknown>,
): ToolDefinition<TSession>["handler"] {
  return async (input, ctx) => {
    try {
      const out = await fn(input, ctx);
      if (isCallToolResult(out)) return out;
      if (isControllerResponse(out)) return toCallToolResult(out);
      return { content: [{ type: "text", text: JSON.stringify(out ?? null) }] };
    } catch (err) {
      return toCallToolError(err instanceof Error ? err : new Error(String(err)));
    }
  };
}

// ============================================================================
// Internal — discriminators
// ============================================================================

function isCallToolResult(value: unknown): value is CallToolResult {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as { content?: unknown }).content)
  );
}

function isControllerResponse(value: unknown): value is IControllerResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    "data" in (value as Record<string, unknown>) &&
    // `CallToolResult` ALSO carries a `content` key — peek for that first via
    // `isCallToolResult` (we do, upstream). Once we know it's not a tool
    // result, presence of `data` is sufficient to treat it as an envelope.
    !("content" in (value as Record<string, unknown>))
  );
}
