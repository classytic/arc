/**
 * Action → MCP tool generation.
 *
 * Arc resources can declare `actions: { approve: fn, … }` — declarative
 * operations that REST routes dispatch through `executeAction(id, name, data)`.
 * This file translates those entries into MCP tools: one tool per action,
 * named `{action}_{resource}`, with input schema built from the action's
 * own schema (if provided) plus a mandatory `id` param.
 *
 * Permission evaluation + request-context hydration share the exact same
 * code path as CRUD tools (`evaluatePermission` + `buildRequestContext`),
 * so the REST ↔ MCP parity holds for actions as well as CRUD.
 */

import type { z } from "zod";
import { normalizeSchemaIR, shouldRejectAdditionalProperties } from "../../core/schemaIR.js";
import { schemaIRToZodShape } from "../../core/schemaIRZod.js";
import type { FieldPermissionMap } from "../../permissions/fields.js";
import type { PermissionCheck } from "../../permissions/types.js";
import type { ServerAccessor } from "../../types/handlers.js";
import type { ResourcePermissions } from "../../types/index.js";
import { buildRequestContext, type McpContextExtras } from "./buildRequestContext.js";
import {
  applyMcpReadMasking,
  evaluatePermission,
  permissionDeniedResult,
  toCallToolError,
  toCallToolSuccess,
} from "./tool-helpers.js";
import type { McpExecutionWiring, ToolDefinition } from "./types.js";

/**
 * Convert an action's `schema` field into a Zod shape for MCP input.
 *
 * Delegates to the shared schema IR ([../../core/schemaIR.ts]). Same
 * normalization path AJV sees on the HTTP side via `buildActionBodySchema`,
 * so authors get one schema declaration for both surfaces. If the author
 * declares `additionalProperties: false`, the flag is preserved on the IR;
 * the MCP tool handler enforces it at request time (MCP's flat-shape input
 * format can't express strict mode natively — see [./types.ts]).
 */
export function convertActionSchemaToZod(
  raw: Record<string, unknown>,
): Record<string, z.ZodTypeAny> {
  const ir = normalizeSchemaIR(raw);
  return schemaIRToZodShape(ir);
}

/**
 * Build an MCP tool handler for a declarative action.
 *
 * Uses the SAME `evaluatePermission()` + `buildRequestContext()` as CRUD
 * tools — single code path for permission side effects, scope construction,
 * and request-context assembly. This eliminates the DRY/drift risk flagged
 * in the 2.10.8 review: REST and MCP action tools share identical
 * context-building machinery.
 */
export function createActionToolHandler(
  actionName: string,
  handler: (id: string, data: Record<string, unknown>, req: unknown) => Promise<unknown>,
  permissions: PermissionCheck | undefined,
  resourceName: string,
  _resourcePermissions: ResourcePermissions | undefined,
  /**
   * Raw schema the action was declared with (Zod or JSON Schema). Used ONLY
   * to detect `additionalProperties: false` — the IR is normalised again here
   * rather than threaded in, because the caller already converts it to a Zod
   * shape for `inputSchema` and the cost is negligible.
   */
  rawSchema?: Record<string, unknown>,
  /**
   * 2.15.5: when `true`, the action is mounted at the resource root
   * (`POST /<prefix>/action`) and the MCP tool's input MUST NOT include
   * an `id` field. The handler still receives `id: ""` for signature
   * parity. Defaults to `false` (legacy behavior — id-bound).
   */
  idLess = false,
  /**
   * Resource field-permission map — field-level READ masking applies to
   * action results carrying documents, matching the arc-decorator masking
   * the action's REST route applies.
   */
  fields?: FieldPermissionMap,
  /**
   * App-level execution wiring + resource meta — threads `metadata.arc`
   * (hooks/events) and the `server` accessor into the synthetic context,
   * matching what the HTTP action route's arc decorator provides.
   */
  extras?: {
    wiring?: McpExecutionWiring;
    schemaOptions?: unknown;
    idField?: string;
  },
): ToolDefinition["handler"] {
  const wiring = extras?.wiring;
  const contextExtras: McpContextExtras | undefined = wiring
    ? {
        arc: {
          resourceName,
          schemaOptions: extras?.schemaOptions,
          permissions,
          hooks: wiring.hooks,
          events: wiring.events,
          fields,
          idField: extras?.idField,
        },
        server: {
          events: wiring.events as ServerAccessor["events"],
          audit: wiring.audit as ServerAccessor["audit"],
          log: wiring.log as ServerAccessor["log"],
        },
      }
    : undefined;
  const ir = rawSchema ? normalizeSchemaIR(rawSchema) : undefined;
  const strict = ir ? shouldRejectAdditionalProperties(ir) : false;
  // Pre-compute the allowed key set ONCE — every action call re-reads it to
  // reject unknown keys, matching HTTP AJV strict-mode semantics. The MCP
  // SDK's flat `inputSchema` can't express z.object().strict() on its own,
  // so strict enforcement lives here at the handler boundary.
  //
  // For id-less actions, `id` is NOT a legal key — the tool's input schema
  // doesn't advertise one, so an agent passing it indicates a contract
  // mismatch worth flagging.
  const allowedBaseKeys = idLess ? [] : ["id"];
  const allowedKeys =
    strict && ir ? new Set([...allowedBaseKeys, ...Object.keys(ir.properties)]) : undefined;

  return async (input, ctx) => {
    const session = ctx.session;

    if (allowedKeys) {
      const extras = Object.keys(input).filter((k) => !allowedKeys.has(k));
      if (extras.length > 0) {
        return toCallToolError({
          code: "arc.bad_request",
          message: `Unknown properties not allowed: ${extras.join(", ")}`,
          status: 400,
          details: [
            {
              path: "input",
              code: "unknown_properties",
              message: `Unexpected fields: ${extras.join(", ")}`,
            },
          ],
        });
      }
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
        operation: `action.${actionName}`,
        reason: permResult.reason,
        session,
      });
    }

    // The "action" operation kind puts id in params, everything else in body,
    // with correct kind-discriminated scope from session + permission override.
    const inputWithAction = { ...input, action: actionName };
    const reqCtx = buildRequestContext(
      inputWithAction,
      session,
      "action",
      permResult?.policy,
      permResult?.scope,
      contextExtras,
    );

    // Id-less actions don't carry an entity handle — pass `""` to the
    // handler. Id-bound actions read `input.id` (the MCP tool advertises
    // an `id` field for those).
    const id = idLess ? "" : typeof input.id === "string" ? input.id : "";
    const { id: _discardId, ...data } = input;

    try {
      // Pass the full IRequestContext as `req` so action handlers see user,
      // scope, metadata, and filters in the same shape as the HTTP path.
      const result = await handler(id, data, reqCtx);
      // No-envelope contract: emit the action's raw return as the success
      // payload. The `isError: false` (default) on `CallToolResult`
      // discriminates success/error for MCP, mirroring HTTP status.
      // Field-read masking mirrors the REST action route's arc decorator.
      return toCallToolSuccess(
        applyMcpReadMasking(result, { fields, session, scopeOverride: permResult?.scope }),
      );
    } catch (err) {
      // Route ArcError / HttpError throws through the canonical
      // `toErrorContract` so MCP agents see the same shape HTTP clients
      // do (`arc.not_found` 404, `arc.forbidden` 403, etc.). Raw errors
      // collapse to `arc.internal_error` 500.
      return toCallToolError(err instanceof Error ? err : new Error(String(err)));
    }
  };
}
