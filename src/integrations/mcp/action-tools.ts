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

import { z } from "zod";
import { buildRequestContext } from "./buildRequestContext.js";
import type { PermissionCheck } from "../../permissions/types.js";
import type { ResourcePermissions } from "../../types/index.js";
import { evaluatePermission } from "./tool-helpers.js";
import type { ToolDefinition } from "./types.js";

/**
 * Convert an action's `schema` field into a Zod shape for MCP input. Handles
 * three accepted shapes:
 *
 *   1. Zod schema directly (detected via `_zod` marker)
 *   2. Full JSON Schema with `type: 'object'` + `properties`
 *   3. Legacy field map — each top-level key is a property
 *
 * Mirrors `normalizeActionSchema` in `createActionRouter.ts`, but produces
 * Zod types for the MCP SDK instead of JSON Schema for Fastify.
 */
export function convertActionSchemaToZod(
  raw: Record<string, unknown>,
): Record<string, z.ZodTypeAny> {
  // Zod schema — passthrough
  if ("_zod" in raw && typeof (raw as Record<string, unknown>).shape === "object") {
    const shape = (raw as Record<string, unknown>).shape as Record<string, z.ZodTypeAny>;
    return { ...shape };
  }

  // Full JSON Schema with properties
  if (
    (raw.type === "object" || "properties" in raw) &&
    typeof raw.properties === "object" &&
    raw.properties !== null
  ) {
    const props = raw.properties as Record<string, Record<string, unknown>>;
    const requiredSet = new Set<string>(
      Array.isArray(raw.required) ? (raw.required as string[]) : [],
    );
    return jsonSchemaPropsToZod(props, requiredSet);
  }

  // Legacy field map
  const result: Record<string, z.ZodTypeAny> = {};
  for (const [fieldName, fieldSchema] of Object.entries(raw)) {
    if (fieldName === "type" || fieldName === "properties" || fieldName === "required") continue;
    if (!fieldSchema || typeof fieldSchema !== "object") continue;
    const fs = fieldSchema as Record<string, unknown>;
    const desc = typeof fs.description === "string" ? fs.description : `${fieldName} field`;
    const isOptional = fs.required === false;
    const base = jsonSchemaTypeToZod(fs);
    result[fieldName] = isOptional ? base.optional().describe(desc) : base.describe(desc);
  }
  return result;
}

function jsonSchemaPropsToZod(
  props: Record<string, Record<string, unknown>>,
  requiredSet: Set<string>,
): Record<string, z.ZodTypeAny> {
  const result: Record<string, z.ZodTypeAny> = {};
  for (const [name, schema] of Object.entries(props)) {
    const desc = typeof schema.description === "string" ? schema.description : name;
    const base = jsonSchemaTypeToZod(schema);
    result[name] = requiredSet.has(name) ? base.describe(desc) : base.optional().describe(desc);
  }
  return result;
}

function jsonSchemaTypeToZod(schema: Record<string, unknown>): z.ZodTypeAny {
  const type = typeof schema.type === "string" ? schema.type : "string";
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return z.enum(schema.enum as [string, ...string[]]);
  }
  switch (type) {
    case "number":
    case "integer":
      return z.number();
    case "boolean":
      return z.boolean();
    case "array":
      return z.array(z.unknown());
    case "object":
      return z.record(z.string(), z.unknown());
    default:
      return z.string();
  }
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
): ToolDefinition["handler"] {
  return async (input, ctx) => {
    const session = ctx.session;

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
