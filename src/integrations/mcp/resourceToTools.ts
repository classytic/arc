/**
 * @classytic/arc — Resource → MCP Tools Generator
 *
 * Converts a ResourceDefinition into an array of ToolDefinitions.
 * Core auto-generation logic that powers Level 1 (mcpPlugin).
 *
 * All tool handlers call BaseController methods — same pipeline as REST.
 */

import { z } from "zod";
import { pluralize } from "../../cli/utils/pluralize.js";
import type { ResourceDefinition } from "../../core/defineResource.js";
import type { IControllerResponse, IRequestContext } from "../../types/index.js";
import { buildRequestContext, type McpOperation } from "./buildRequestContext.js";
import { type FieldRuleEntry, fieldRulesToZod } from "./fieldRulesToZod.js";
import type {
  CallToolResult,
  CrudOperation,
  McpResourceConfig,
  ToolAnnotations,
  ToolDefinition,
} from "./types.js";

// ============================================================================
// Types
// ============================================================================

export interface ResourceToToolsConfig extends McpResourceConfig {
  toolNamePrefix?: string;
}

// ============================================================================
// Constants
// ============================================================================

const ALL_CRUD_OPS: CrudOperation[] = ["list", "get", "create", "update", "delete"];

const ANNOTATIONS: Record<CrudOperation, ToolAnnotations> = {
  list: { readOnlyHint: true },
  get: { readOnlyHint: true },
  create: { destructiveHint: false },
  update: { destructiveHint: true, idempotentHint: true },
  delete: { destructiveHint: true, idempotentHint: true },
};

// ============================================================================
// Main
// ============================================================================

/**
 * Convert a ResourceDefinition into MCP ToolDefinitions.
 *
 * @param resource - Arc resource definition
 * @param config - Optional overrides (operations, descriptions, hideFields, prefix)
 */
export function resourceToTools(
  resource: ResourceDefinition,
  config: ResourceToToolsConfig = {},
): ToolDefinition[] {
  const controller = resource.controller;
  if (!controller) return [];

  const fieldRules = resource.schemaOptions?.fieldRules as
    | Record<string, FieldRuleEntry>
    | undefined;
  const hiddenFields = resource.schemaOptions?.hiddenFields;
  const readonlyFields = resource.schemaOptions?.readonlyFields;
  const filterableFields = (resource.schemaOptions as Record<string, unknown>)?.filterableFields as
    | string[]
    | undefined;
  const hasSoftDelete = resource._appliedPresets?.includes("softDelete") ?? false;

  // Determine enabled operations
  let ops = ALL_CRUD_OPS.filter((op) => {
    if (resource.disableDefaultRoutes) return false;
    if (resource.disabledRoutes?.includes(op)) return false;
    return true;
  });
  if (config.operations) ops = ops.filter((op) => config.operations?.includes(op));

  const tools: ToolDefinition[] = [];
  const prefix = config.toolNamePrefix;

  for (const op of ops) {
    const name =
      op === "list"
        ? `${prefix ? `${prefix}_` : ""}list_${pluralize(resource.name)}`
        : `${prefix ? `${prefix}_` : ""}${op}_${resource.name}`;

    tools.push({
      name,
      description:
        config.descriptions?.[op] ?? defaultDescription(op, resource.displayName, hasSoftDelete),
      annotations: ANNOTATIONS[op],
      inputSchema: buildInputSchema(op, fieldRules, {
        hiddenFields,
        readonlyFields,
        extraHideFields: config.hideFields,
        filterableFields,
      }),
      handler: createHandler(op, controller, resource.name),
    });
  }

  // Additional routes with wrapHandler: true become extra tools
  for (const route of resource.additionalRoutes ?? []) {
    if (!route.wrapHandler) continue;
    if (!["POST", "PUT", "PATCH", "DELETE"].includes(route.method)) continue;

    const opName = route.operation ?? slugifyRoute(route.method, route.path);
    const hasId = route.path.includes(":id");

    const inputShape: Record<string, z.ZodTypeAny> = {};
    if (hasId) inputShape.id = z.string().describe("Resource ID");

    tools.push({
      name: prefix ? `${prefix}_${opName}_${resource.name}` : `${opName}_${resource.name}`,
      description: route.summary ?? route.description ?? `${opName} on ${resource.displayName}`,
      annotations: { openWorldHint: true },
      inputSchema: inputShape,
      handler: createAdditionalRouteHandler(route, controller, hasId),
    });
  }

  return tools;
}

// ============================================================================
// Input Schema Generation
// ============================================================================

function buildInputSchema(
  op: CrudOperation,
  fieldRules: Record<string, FieldRuleEntry> | undefined,
  opts: {
    hiddenFields?: string[];
    readonlyFields?: string[];
    extraHideFields?: string[];
    filterableFields?: string[];
  },
): Record<string, z.ZodTypeAny> {
  switch (op) {
    case "list":
      return fieldRulesToZod(fieldRules, { mode: "list", ...opts });
    case "get":
      return { id: z.string().describe("Resource ID") };
    case "create":
      return fieldRulesToZod(fieldRules, { mode: "create", ...opts });
    case "update":
      return {
        id: z.string().describe("Resource ID"),
        ...fieldRulesToZod(fieldRules, { mode: "update", ...opts }),
      };
    case "delete":
      return { id: z.string().describe("Resource ID") };
  }
}

// ============================================================================
// Handlers
// ============================================================================

type ControllerMethod = (ctx: IRequestContext) => Promise<IControllerResponse>;

function createHandler(
  op: CrudOperation,
  controller: unknown,
  resourceName: string,
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
      const reqCtx = buildRequestContext(input, ctx.session, op as McpOperation);
      return toCallToolResult(await method(reqCtx));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.log("error", `${resourceName}.${op}: ${msg}`).catch(() => {});
      return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
    }
  };
}

function createAdditionalRouteHandler(
  route: { handler: unknown; operation?: string; method: string; path: string },
  controller: unknown,
  hasId: boolean,
): ToolDefinition["handler"] {
  const ctrl = controller as unknown as Record<string, ControllerMethod>;
  const handlerName =
    typeof route.handler === "string"
      ? route.handler
      : (route.operation ?? slugifyRoute(route.method, route.path));

  return async (input, ctx) => {
    try {
      const method = ctrl[handlerName];
      if (typeof method !== "function") {
        return {
          content: [{ type: "text", text: `Handler "${handlerName}" not found on controller` }],
          isError: true,
        };
      }
      const reqCtx = buildRequestContext(input, ctx.session, hasId ? "update" : "create");
      return toCallToolResult(await method(reqCtx));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
    }
  };
}

// ============================================================================
// Helpers
// ============================================================================

function toCallToolResult(result: IControllerResponse): CallToolResult {
  if (!result.success) {
    return { content: [{ type: "text", text: result.error ?? "Operation failed" }], isError: true };
  }
  const output = result.meta ? { data: result.data, ...result.meta } : result.data;
  return { content: [{ type: "text", text: JSON.stringify(output, null, 2) }] };
}

function defaultDescription(op: CrudOperation, displayName: string, softDelete: boolean): string {
  const name = displayName.toLowerCase();
  switch (op) {
    case "list":
      return `List ${pluralize(name)} with optional filters and pagination`;
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

function slugifyRoute(method: string, path: string): string {
  const clean = path
    .replace(/:[^/]+/g, "")
    .replace(/^\/+|\/+$/g, "")
    .replace(/\//g, "_");
  return clean ? `${method.toLowerCase()}_${clean}` : method.toLowerCase();
}
