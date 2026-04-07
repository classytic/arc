/**
 * @classytic/arc — Resource → MCP Tools Generator
 *
 * Converts a ResourceDefinition into an array of ToolDefinitions.
 * Core auto-generation logic that powers Level 1 (mcpPlugin).
 *
 * All tool handlers call BaseController methods — same pipeline as REST.
 */

import { z } from "zod";
import { BaseController } from "../../core/BaseController.js";
import type { ResourceDefinition } from "../../core/defineResource.js";
import type { PermissionCheck, PermissionResult } from "../../permissions/types.js";
import type {
  IControllerResponse,
  IRequestContext,
  ResourcePermissions,
} from "../../types/index.js";
import { pluralize } from "../../utils/pluralize.js";
import { buildRequestContext, type McpOperation } from "./buildRequestContext.js";
import { type FieldRuleEntry, fieldRulesToZod } from "./fieldRulesToZod.js";
import { jsonSchemaToZodShape } from "./jsonSchemaToZod.js";
import type {
  CallToolResult,
  CrudOperation,
  McpAuthResult,
  McpResourceConfig,
  ToolAnnotations,
  ToolDefinition,
} from "./types.js";

// ============================================================================
// Types
// ============================================================================

export interface ResourceToToolsConfig extends McpResourceConfig {
  toolNamePrefix?: string;
  /** Per-operation tool name overrides: `{ get: 'get_job_by_id' }` */
  names?: Partial<Record<CrudOperation, string>>;
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
 * MCP tools call BaseController directly — they bypass HTTP routes entirely.
 * Therefore `disableDefaultRoutes` does NOT affect MCP tool generation;
 * only `disabledRoutes` (the per-operation array) controls which ops are skipped.
 *
 * If the resource has an adapter but no controller (e.g. `disableDefaultRoutes: true`),
 * a lightweight BaseController is auto-created from the adapter for MCP use.
 *
 * @param resource - Arc resource definition
 * @param config - Optional overrides (operations, descriptions, hideFields, prefix, names)
 */
export function resourceToTools(
  resource: ResourceDefinition,
  config: ResourceToToolsConfig = {},
): ToolDefinition[] {
  // Use existing controller, or auto-create one from adapter for MCP
  const controller =
    resource.controller ?? (resource.adapter ? createMcpController(resource) : undefined);
  if (!controller) return [];

  const explicitFieldRules = resource.schemaOptions?.fieldRules as
    | Record<string, FieldRuleEntry>
    | undefined;
  const hiddenFields = resource.schemaOptions?.hiddenFields;
  const readonlyFields = resource.schemaOptions?.readonlyFields;

  // DX fallback chain when the user didn't supply explicit fieldRules:
  //
  //   1. Pull the adapter's generated body schemas (createBody/updateBody)
  //      once and reuse them in two ways:
  //      a) `jsonSchemaToZodShape` for create/update — preserves nested
  //         objects, arrays, refs, composition (the high-fidelity path)
  //      b) `deriveFieldRulesFromAdapter` for the list/filter path which
  //         still uses the flat FieldRuleEntry shape
  //   2. If the user DID supply fieldRules, those win — they may intentionally
  //      hide fields or provide tighter constraints than the adapter knows.
  const adapterBodies = explicitFieldRules ? undefined : getAdapterBodies(resource);
  const fieldRules = explicitFieldRules ?? deriveFieldRulesFromAdapter(resource);

  // Auto-derive from QueryParser when schemaOptions doesn't have the fields
  const filterableFields =
    resource.schemaOptions?.filterableFields ?? resource.queryParser?.allowedFilterFields;
  const sortableFields = resource.queryParser?.allowedSortFields;
  const allowedOperators = resource.queryParser?.allowedOperators;

  const hasSoftDelete = resource._appliedPresets?.includes("softDelete") ?? false;

  // Determine enabled operations — only disabledRoutes matters, NOT disableDefaultRoutes
  let ops = ALL_CRUD_OPS.filter((op) => {
    if (resource.disabledRoutes?.includes(op)) return false;
    return true;
  });
  if (config.operations) ops = ops.filter((op) => config.operations?.includes(op));

  const tools: ToolDefinition[] = [];
  const prefix = config.toolNamePrefix;

  for (const op of ops) {
    // Support per-operation name overrides: names: { get: 'get_job_by_id' }
    const name =
      config.names?.[op] ??
      (op === "list"
        ? `${prefix ? `${prefix}_` : ""}list_${pluralize(resource.name)}`
        : `${prefix ? `${prefix}_` : ""}${op}_${resource.name}`);

    tools.push({
      name,
      description:
        config.descriptions?.[op] ??
        defaultDescription(op, resource.displayName, hasSoftDelete, {
          filterableFields,
          allowedOperators,
          sortableFields,
        }),
      annotations: ANNOTATIONS[op],
      inputSchema: buildInputSchema(op, fieldRules, {
        hiddenFields,
        readonlyFields,
        extraHideFields: config.hideFields,
        filterableFields,
        allowedOperators,
        adapterBodies,
      }),
      handler: createHandler(op, controller, resource.name, resource.permissions),
    });
  }

  // Additional routes with wrapHandler: true OR mcpHandler become extra tools
  for (const route of resource.additionalRoutes ?? []) {
    const mcpHandler = route.mcpHandler as
      | ((input: Record<string, unknown>) => Promise<CallToolResult>)
      | undefined;
    if (!route.wrapHandler && !mcpHandler) continue;
    if (!mcpHandler && !["POST", "PUT", "PATCH", "DELETE"].includes(route.method)) continue;

    const opName = route.operation ?? slugifyRoute(route.method, route.path);
    const hasId = route.path.includes(":id");

    const inputShape: Record<string, z.ZodTypeAny> = {};
    if (hasId) inputShape.id = z.string().describe("Resource ID");

    if (mcpHandler) {
      // Direct MCP handler — no controller wrapping needed
      tools.push({
        name: prefix ? `${prefix}_${opName}_${resource.name}` : `${opName}_${resource.name}`,
        description: route.summary ?? route.description ?? `${opName} on ${resource.displayName}`,
        annotations: { openWorldHint: true },
        inputSchema: inputShape,
        handler: async (input, _ctx) => {
          try {
            return await mcpHandler(input);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
          }
        },
      });
    } else {
      tools.push({
        name: prefix ? `${prefix}_${opName}_${resource.name}` : `${opName}_${resource.name}`,
        description: route.summary ?? route.description ?? `${opName} on ${resource.displayName}`,
        annotations: { openWorldHint: true },
        inputSchema: inputShape,
        handler: createAdditionalRouteHandler(route, controller, hasId),
      });
    }
  }

  return tools;
}

// ============================================================================
// Input Schema Generation
// ============================================================================

interface AdapterBodies {
  createBody?: Record<string, unknown>;
  updateBody?: Record<string, unknown>;
}

function buildInputSchema(
  op: CrudOperation,
  fieldRules: Record<string, FieldRuleEntry> | undefined,
  opts: {
    hiddenFields?: string[];
    readonlyFields?: string[];
    extraHideFields?: string[];
    filterableFields?: readonly string[];
    allowedOperators?: readonly string[];
    /**
     * Raw JSON Schema body shapes from the adapter, used as a high-fidelity
     * source for create/update tool input schemas when no explicit fieldRules
     * are present. Bypassing the flat FieldRuleEntry intermediate layer
     * preserves nested objects, arrays, refs, and composition.
     */
    adapterBodies?: AdapterBodies;
  },
): Record<string, z.ZodTypeAny> {
  switch (op) {
    case "list":
      return fieldRulesToZod(fieldRules, { mode: "list", ...opts });
    case "get":
      return { id: z.string().describe("Resource ID") };
    case "create": {
      // Prefer rich JSON Schema → Zod when no explicit user fieldRules.
      if (!fieldRules && opts.adapterBodies?.createBody) {
        const shape = jsonSchemaToZodShape(
          opts.adapterBodies.createBody as Parameters<typeof jsonSchemaToZodShape>[0],
          "create",
        );
        if (shape) return shape;
      }
      return fieldRulesToZod(fieldRules, { mode: "create", ...opts });
    }
    case "update": {
      const idShape = { id: z.string().describe("Resource ID") };
      if (!fieldRules && opts.adapterBodies?.updateBody) {
        const shape = jsonSchemaToZodShape(
          opts.adapterBodies.updateBody as Parameters<typeof jsonSchemaToZodShape>[0],
          "update",
        );
        if (shape) return { ...idShape, ...shape };
      }
      return {
        ...idShape,
        ...fieldRulesToZod(fieldRules, { mode: "update", ...opts }),
      };
    }
    case "delete":
      return { id: z.string().describe("Resource ID") };
  }
}

/**
 * Pull the adapter's `createBody` / `updateBody` schemas, if any.
 * Returns `undefined` when the adapter doesn't generate schemas or throws.
 */
function getAdapterBodies(resource: ResourceDefinition): AdapterBodies | undefined {
  const adapter = resource.adapter;
  if (!adapter || typeof adapter.generateSchemas !== "function") return undefined;
  try {
    const generated = adapter.generateSchemas(resource.schemaOptions, {
      idField: resource.idField,
      resourceName: resource.name,
    });
    if (!generated || typeof generated !== "object") return undefined;
    const schemas = generated as Record<string, unknown>;
    return {
      createBody: schemas.createBody as Record<string, unknown> | undefined,
      updateBody: schemas.updateBody as Record<string, unknown> | undefined,
    };
  } catch {
    return undefined;
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

      // Evaluate permission check → extract policy filters
      const policyFilters = await evaluatePermission(
        permissions?.[op as keyof ResourcePermissions],
        ctx.session,
        resourceName,
        op,
        input,
      );
      if (policyFilters === false) {
        return {
          content: [{ type: "text", text: `Permission denied: ${op} on ${resourceName}` }],
          isError: true,
        };
      }

      const reqCtx = buildRequestContext(
        input,
        ctx.session,
        op as McpOperation,
        policyFilters || undefined,
      );
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

/**
 * Evaluate a resource's permission check in MCP context.
 *
 * Returns:
 * - `false` if permission denied
 * - `Record<string, unknown>` if granted with filters (ownership patterns)
 * - `null` if granted without filters (or no permission check defined)
 */
async function evaluatePermission(
  check: PermissionCheck | undefined,
  session: McpAuthResult | null,
  resource: string,
  action: string,
  input: Record<string, unknown>,
): Promise<Record<string, unknown> | false | null> {
  if (!check) return null; // no permission defined = allow

  // Build PermissionContext for MCP — spread full session so permission
  // functions can access orgId, branchId, roles, etc. from the auth result
  const user = session ? { id: session.userId, _id: session.userId, ...session } : null;
  const fakeRequest = {
    user,
    headers: {},
    params: {},
    query: {},
    body: input,
  } as unknown as import("fastify").FastifyRequest;

  const result = await check({
    user,
    request: fakeRequest,
    resource,
    action,
    resourceId: typeof input.id === "string" ? input.id : undefined,
    params: {},
    data: input,
  });

  // Boolean result
  if (typeof result === "boolean") return result ? null : false;

  // PermissionResult
  const permResult = result as PermissionResult;
  if (!permResult.granted) return false;
  return permResult.filters ?? null;
}

/**
 * Derive a fieldRules-shaped object from the adapter's auto-generated body
 * schemas. Used as a fallback when the resource doesn't supply explicit
 * fieldRules — this lets MCP create/update tools accept the same body fields
 * that the REST routes already accept.
 *
 * Returns `undefined` if no usable schema can be extracted, in which case
 * `fieldRulesToZod` falls back to its own behavior (empty shape).
 */
function deriveFieldRulesFromAdapter(
  resource: ResourceDefinition,
): Record<string, FieldRuleEntry> | undefined {
  const adapter = resource.adapter;
  if (!adapter || typeof adapter.generateSchemas !== "function") return undefined;

  let generated: unknown;
  try {
    generated = adapter.generateSchemas(resource.schemaOptions, {
      idField: resource.idField,
      resourceName: resource.name,
    });
  } catch {
    return undefined;
  }
  if (!generated || typeof generated !== "object") return undefined;

  const schemas = generated as Record<string, unknown>;
  // Prefer createBody (it has required fields), fall back to updateBody.
  const createBody = schemas.createBody as
    | { properties?: Record<string, unknown>; required?: string[] }
    | undefined;
  const updateBody = schemas.updateBody as
    | { properties?: Record<string, unknown>; required?: string[] }
    | undefined;

  const properties = createBody?.properties ?? updateBody?.properties;
  if (!properties || typeof properties !== "object") return undefined;

  const requiredSet = new Set<string>(createBody?.required ?? []);
  const rules: Record<string, FieldRuleEntry> = {};

  for (const [name, propSchema] of Object.entries(properties)) {
    if (!propSchema || typeof propSchema !== "object") continue;
    const prop = propSchema as Record<string, unknown>;
    const rawType = prop.type;
    // JSON Schema "type" can be a string or an array (e.g. ["string","null"]).
    // Pick the first string variant we can map.
    const candidateTypes: string[] = Array.isArray(rawType)
      ? rawType.filter((t): t is string => typeof t === "string")
      : typeof rawType === "string"
        ? [rawType]
        : [];
    const arcType = mapJsonSchemaTypeToArcType(candidateTypes[0]);

    const rule: FieldRuleEntry = { type: arcType };
    if (requiredSet.has(name)) rule.required = true;
    if (typeof prop.description === "string") rule.description = prop.description;
    if (Array.isArray(prop.enum)) rule.enum = prop.enum.filter((v) => typeof v === "string");
    if (typeof prop.minLength === "number") rule.minLength = prop.minLength;
    if (typeof prop.maxLength === "number") rule.maxLength = prop.maxLength;
    if (typeof prop.minimum === "number") rule.min = prop.minimum;
    if (typeof prop.maximum === "number") rule.max = prop.maximum;
    if (typeof prop.pattern === "string") rule.pattern = prop.pattern;

    rules[name] = rule;
  }

  return Object.keys(rules).length > 0 ? rules : undefined;
}

function mapJsonSchemaTypeToArcType(jsonType: string | undefined): string {
  switch (jsonType) {
    case "string":
      return "string";
    case "number":
    case "integer":
      return "number";
    case "boolean":
      return "boolean";
    case "array":
      return "array";
    case "object":
      return "object";
    default:
      return "string";
  }
}

function toCallToolResult(result: IControllerResponse): CallToolResult {
  if (!result.success) {
    return { content: [{ type: "text", text: result.error ?? "Operation failed" }], isError: true };
  }
  const output = result.meta ? { data: result.data, ...result.meta } : result.data;
  return { content: [{ type: "text", text: JSON.stringify(output, null, 2) }] };
}

function defaultDescription(
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

function slugifyRoute(method: string, path: string): string {
  const clean = path
    .replace(/:[^/]+/g, "")
    .replace(/^\/+|\/+$/g, "")
    .replace(/\//g, "_");
  return clean ? `${method.toLowerCase()}_${clean}` : method.toLowerCase();
}

/**
 * Auto-create a BaseController from the resource's adapter for MCP use.
 * Called when the resource has an adapter but no controller
 * (e.g. `disableDefaultRoutes: true` skips controller creation in defineResource).
 */
function createMcpController(resource: ResourceDefinition): unknown {
  const repository = resource.adapter?.repository;
  if (!repository) return undefined;

  return new BaseController(repository, {
    resourceName: resource.name,
    schemaOptions: resource.schemaOptions,
    tenantField: resource.tenantField,
    idField: resource.idField,
    matchesFilter: resource.adapter?.matchesFilter,
  });
}
