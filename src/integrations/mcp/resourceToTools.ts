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
import { normalizePermissionResult } from "../../permissions/applyPermissionResult.js";
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
  // Use existing controller, or auto-create one from adapter for MCP.
  // Controller is required for CRUD and additionalRoute tools, but NOT for
  // actions (which carry their own handler). So we don't early-return here
  // — resources with only `actions` (no adapter/controller) still produce tools.
  const controller =
    resource.controller ?? (resource.adapter ? createMcpController(resource) : undefined);

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

  const tools: ToolDefinition[] = [];
  const prefix = config.toolNamePrefix;

  // CRUD tools require a controller — skip if unavailable (actions-only resource)
  if (!controller) {
    // Jump straight to additionalRoutes + actions (below)
  } else {
    // Determine enabled operations — only disabledRoutes matters, NOT disableDefaultRoutes
    let ops = ALL_CRUD_OPS.filter((op) => {
      if (resource.disabledRoutes?.includes(op)) return false;
      return true;
    });
    if (config.operations) ops = ops.filter((op) => config.operations?.includes(op));

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

    // Custom routes with pipeline handlers (raw: false) OR mcpHandler become tools.
    // v2.8.1: honor route-level `mcp` metadata — skip routes with `mcp: false`,
    // and use `mcp.description` / `mcp.annotations` when provided.
    for (const route of resource.additionalRoutes ?? []) {
      // mcp: false → skip MCP tool generation for this route
      if (route.mcp === false) continue;

      const mcpHandler = route.mcpHandler as
        | ((input: Record<string, unknown>) => Promise<CallToolResult>)
        | undefined;
      if (!route.wrapHandler && !mcpHandler) continue;
      if (!mcpHandler && !["POST", "PUT", "PATCH", "DELETE"].includes(route.method)) continue;

      const opName = route.operation ?? slugifyRoute(route.method, route.path);
      const hasId = route.path.includes(":id");

      // Resolve description and annotations from route-level mcp config
      const mcpConfig = typeof route.mcp === "object" && route.mcp !== null ? route.mcp : undefined;
      const toolDescription =
        mcpConfig?.description ??
        route.summary ??
        route.description ??
        `${opName} on ${resource.displayName}`;
      const toolAnnotations: ToolAnnotations = mcpConfig?.annotations
        ? { ...mcpConfig.annotations }
        : { openWorldHint: true };

      const inputShape: Record<string, z.ZodTypeAny> = {};
      if (hasId) inputShape.id = z.string().describe("Resource ID");

      if (mcpHandler) {
        tools.push({
          name: prefix ? `${prefix}_${opName}_${resource.name}` : `${opName}_${resource.name}`,
          description: toolDescription,
          annotations: toolAnnotations,
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
          description: toolDescription,
          annotations: toolAnnotations,
          inputSchema: inputShape,
          handler: createAdditionalRouteHandler(route, controller, hasId),
        });
      }
    }
  } // end: controller-gated CRUD + additionalRoutes block

  // v2.8.1 — Generate MCP tools from declarative `actions`.
  // Naming convention: `{action}_{resource}` (e.g., `approve_order`)
  // Each action becomes a tool with `id` (resource ID) + action-specific input fields.
  // Handler calls `controller.executeAction(id, actionName, data)` or falls
  // back to a direct controller method call.
  if (resource.actions) {
    for (const [actionName, entry] of Object.entries(resource.actions)) {
      const def = typeof entry === "function" ? { handler: entry } : entry;

      // Respect mcp: false on per-action definitions
      if (typeof def !== "function" && "mcp" in def && def.mcp === false) continue;

      const mcpCfg = typeof def !== "function" && typeof def.mcp === "object" ? def.mcp : undefined;
      const description =
        (mcpCfg as Record<string, unknown> | undefined)?.description ??
        (typeof def !== "function" ? def.description : undefined) ??
        `${actionName} action on ${resource.displayName}`;
      const annotations: ToolAnnotations = (mcpCfg as Record<string, unknown> | undefined)
        ?.annotations
        ? { ...((mcpCfg as Record<string, unknown>).annotations as ToolAnnotations) }
        : { destructiveHint: true };

      // Build input schema: always requires `id`, plus action-specific fields from schema
      const inputShape: Record<string, z.ZodTypeAny> = {
        id: z.string().describe("Resource ID"),
      };

      // Extract action-specific fields from the schema (if provided)
      const rawSchema = typeof def !== "function" ? def.schema : undefined;
      if (rawSchema && typeof rawSchema === "object") {
        const converted = convertActionSchemaToZod(rawSchema as Record<string, unknown>);
        for (const [key, val] of Object.entries(converted)) {
          inputShape[key] = val;
        }
      }

      const toolName = prefix
        ? `${prefix}_${actionName}_${resource.name}`
        : `${actionName}_${resource.name}`;

      const handler = typeof entry === "function" ? entry : def.handler;
      const actionPerms =
        (typeof def !== "function" ? def.permissions : undefined) ?? resource.actionPermissions;

      tools.push({
        name: toolName,
        description: String(description),
        annotations,
        inputSchema: inputShape,
        handler: createActionToolHandler(
          actionName,
          handler as (id: string, data: Record<string, unknown>, req: unknown) => Promise<unknown>,
          actionPerms as PermissionCheck | undefined,
          resource.name,
          resource.permissions,
        ),
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

      // Evaluate permission check → extract the full normalized result so
      // BOTH filters and scope are honored (same contract as CRUD/action routes).
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
 * Returns the full normalized `PermissionResult` so the caller can honor
 * ALL side-effects (filters + scope) consistently with CRUD/action routes.
 * Returns `null` when no permission is defined (= allow, no side effects).
 *
 * Promoting booleans to `PermissionResult` via the shared `normalizePermissionResult`
 * helper keeps the contract aligned with the rest of Arc — there is a single
 * normalization path for every call site.
 */
async function evaluatePermission(
  check: PermissionCheck | undefined,
  session: McpAuthResult | null,
  resource: string,
  action: string,
  input: Record<string, unknown>,
): Promise<PermissionResult | null> {
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

  return normalizePermissionResult(result);
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

// ============================================================================
// Action → MCP Tool helpers (v2.8.1)
// ============================================================================

/**
 * Convert an action schema (JSON Schema, Zod, or legacy field map) to a Zod
 * shape for MCP tool input. This mirrors `normalizeActionSchema` in
 * `createActionRouter.ts` but produces Zod types for the MCP SDK.
 */
function convertActionSchemaToZod(raw: Record<string, unknown>): Record<string, z.ZodTypeAny> {
  // Check if it's a Zod schema directly (has `_zod` marker)
  if ("_zod" in raw && typeof (raw as Record<string, unknown>).shape === "object") {
    const shape = (raw as Record<string, unknown>).shape as Record<string, z.ZodTypeAny>;
    return { ...shape };
  }

  // Full JSON Schema with `type: 'object'` + `properties`
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

  // Legacy field map: each top-level key is a property
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
  // Handle enum before type switch — enum is a constraint, not a type
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
 * Create an MCP tool handler for a declarative action.
 *
 * Uses the SAME `evaluatePermission()` and `buildRequestContext()` as
 * CRUD tools — single code path for permission side effects, scope
 * construction, and request context assembly. This eliminates the
 * DRY/drift risk flagged in the review: REST and MCP action tools now
 * share identical context-building machinery.
 */
function createActionToolHandler(
  actionName: string,
  handler: (id: string, data: Record<string, unknown>, req: unknown) => Promise<unknown>,
  permissions: PermissionCheck | undefined,
  resourceName: string,
  _resourcePermissions: ResourcePermissions | undefined,
): ToolDefinition["handler"] {
  return async (input, ctx) => {
    const session = ctx.session;

    // Same evaluatePermission() as CRUD tools — honors scope, filters,
    // all PermissionResult side effects identically in MCP and REST.
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

    // Use the shared context builder — same factory as CRUD tools.
    // The `action` operation type puts id in params, everything else in body,
    // with correct `kind`-discriminated scope from session + permission override.
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
      // Pass the full IRequestContext as the `req` argument so action
      // handlers see user, scope, metadata, and filters in the same
      // shape as when called from the HTTP router.
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
