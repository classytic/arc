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
import {
  normalizeSchemaIR,
  schemaIRToZodShape,
  shouldRejectAdditionalProperties,
} from "../../core/schemaIR.js";
import type { PermissionCheck } from "../../permissions/types.js";
import type { ResourcePermissions } from "../../types/index.js";
import { buildRequestContext } from "./buildRequestContext.js";
import { evaluatePermission } from "./tool-helpers.js";
import type { ToolDefinition } from "./types.js";

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
): ToolDefinition["handler"] {
  const ir = rawSchema ? normalizeSchemaIR(rawSchema) : undefined;
  const strict = ir ? shouldRejectAdditionalProperties(ir) : false;
  // Pre-compute the allowed key set ONCE — every action call re-reads it to
  // reject unknown keys, matching HTTP AJV strict-mode semantics. The MCP
  // SDK's flat `inputSchema` can't express z.object().strict() on its own,
  // so strict enforcement lives here at the handler boundary.
  const allowedKeys = strict && ir ? new Set(["id", ...Object.keys(ir.properties)]) : undefined;

  return async (input, ctx) => {
    const session = ctx.session;

    if (allowedKeys) {
      const extras = Object.keys(input).filter((k) => !allowedKeys.has(k));
      if (extras.length > 0) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: false,
                error: `Unknown properties not allowed: ${extras.join(", ")}`,
                details: { action: actionName, unexpected: extras },
              }),
            },
          ],
          isError: true,
        };
      }
    }

    const permResult = await evaluatePermission(
      permissions,
      session,
      resourceName,
      actionName,
      input,
    );
    if (permResult && !permResult.granted) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: false,
              error: permResult.reason ?? `Permission denied for action '${actionName}'`,
            }),
          },
        ],
        isError: true,
      };
    }

    // The "action" operation kind puts id in params, everything else in body,
    // with correct kind-discriminated scope from session + permission override.
    const inputWithAction = { ...input, action: actionName };
    const reqCtx = buildRequestContext(
      inputWithAction,
      session,
      "action",
      permResult?.filters,
      permResult?.scope,
    );

    const id = typeof input.id === "string" ? input.id : "";
    const { id: _discardId, ...data } = input;

    try {
      // Pass the full IRequestContext as `req` so action handlers see user,
      // scope, metadata, and filters in the same shape as the HTTP path.
      const result = await handler(id, data, reqCtx);
      return {
        content: [{ type: "text", text: JSON.stringify({ success: true, data: result }) }],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
    }
  };
}
