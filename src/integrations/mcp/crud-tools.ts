/**
 * CRUD → MCP tool generation.
 *
 * Owns: list / get / create / update / delete tool factories + their
 * default descriptions + op-level annotations. Handler calls BaseController
 * methods via the same pipeline as REST — permission check, request-context
 * builder, envelope translation.
 */

import { buildRequestContext, type McpOperation } from "./buildRequestContext.js";
import { pluralize } from "../../utils/pluralize.js";
import type { IControllerResponse, ResourcePermissions } from "../../types/index.js";
import { evaluatePermission, toCallToolResult } from "./tool-helpers.js";
import type { CrudOperation, ToolAnnotations, ToolDefinition } from "./types.js";

type ControllerMethod = (ctx: unknown) => Promise<IControllerResponse>;

export const ALL_CRUD_OPS: CrudOperation[] = ["list", "get", "create", "update", "delete"];

export const CRUD_ANNOTATIONS: Record<CrudOperation, ToolAnnotations> = {
  list: { readOnlyHint: true },
  get: { readOnlyHint: true },
  create: { destructiveHint: false },
  update: { destructiveHint: true, idempotentHint: true },
  delete: { destructiveHint: true, idempotentHint: true },
};

/**
 * Build a handler that dispatches to the controller method for `op`,
 * passing through arc's MCP → IRequestContext adapter. Permission check
 * runs first and short-circuits with a structured tool error on denial.
 */
export function createCrudHandler(
  op: CrudOperation,
  controller: unknown,
  resourceName: string,
  permissions?: ResourcePermissions,
): ToolDefinition["handler"] {
  const ctrl = controller as unknown as Record<string, ControllerMethod>;

  return async (input, ctx) => {
    try {
      const method = ctrl[op];
      if (typeof method !== "function") {
        return {
          content: [{ type: "text", text: `Operation "${op}" not available on ${resourceName}` }],
          isError: true,
        };
      }

      const permResult = await evaluatePermission(
        permissions?.[op as keyof ResourcePermissions],
        ctx.session,
        resourceName,
        op,
        input,
      );
      if (permResult && !permResult.granted) {
        return {
          content: [
            {
              type: "text",
              text: `Permission denied: ${op} on ${resourceName}${
                permResult.reason ? ` — ${permResult.reason}` : ""
              }`,
            },
          ],
          isError: true,
        };
      }

      const reqCtx = buildRequestContext(
        input,
        ctx.session,
        op as McpOperation,
        permResult?.filters,
        permResult?.scope,
      );
      return toCallToolResult(await method(reqCtx));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.log("error", `${resourceName}.${op}: ${msg}`).catch(() => {});
      return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
    }
  };
}

/**
 * Default description for a CRUD tool. Enriches list descriptions with the
 * configured filter/sort metadata so MCP clients can see what's queryable
 * without reading the resource source.
 */
export function defaultCrudDescription(
  op: CrudOperation,
  displayName: string,
  softDelete: boolean,
  queryMeta?: {
    filterableFields?: readonly string[];
    allowedOperators?: readonly string[];
    sortableFields?: readonly string[];
  },
): string {
  const name = displayName.toLowerCase();
  switch (op) {
    case "list": {
      const parts = [`List ${pluralize(name)} with optional filters and pagination.`];
      if (queryMeta?.filterableFields?.length) {
        parts.push(`Filterable fields: ${queryMeta.filterableFields.join(", ")}.`);
      }
      if (queryMeta?.allowedOperators?.length) {
        parts.push(
          `Filter operators: ${queryMeta.allowedOperators.join(", ")} (use field[op]=value syntax).`,
        );
      }
      if (queryMeta?.sortableFields?.length) {
        parts.push(`Sortable fields: ${queryMeta.sortableFields.join(", ")}.`);
      }
      return parts.join(" ");
    }
    case "get":
      return `Get a single ${name} by ID`;
    case "create":
      return `Create a new ${name}`;
    case "update":
      return `Update an existing ${name} by ID`;
    case "delete":
      return softDelete
        ? `Delete a ${name} by ID (soft delete — marks as deleted, not permanently removed)`
        : `Delete a ${name} by ID`;
  }
}
