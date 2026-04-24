/**
 * @classytic/arc — Resource → MCP Tools orchestrator.
 *
 * Top-level entry point for generating `ToolDefinition[]` from a
 * `ResourceDefinition`. Delegates the heavy lifting to four focused
 * internal units (v2.11.0 split):
 *
 * - [input-schema.ts](./input-schema.ts)   — CRUD input-shape generation
 * - [crud-tools.ts](./crud-tools.ts)       — CRUD handler + annotations + descriptions
 * - [route-tools.ts](./route-tools.ts)     — custom-route → tool translation
 * - [action-tools.ts](./action-tools.ts)   — declarative-action → tool translation
 *
 * This file's job is purely orchestration: pick the controller, gather
 * field rules once, and loop over CRUD / routes / actions delegating
 * each tool's construction to the matching unit.
 *
 * All tool handlers call BaseController methods — same pipeline as REST.
 */

import { z } from "zod";
import { resolveActionPermission } from "../../core/actionPermissions.js";
import type { ResourceDefinition } from "../../core/defineResource.js";
import { normalizeSchemaIR, schemaIRToZodShape } from "../../core/schemaIR.js";
import type { PermissionCheck } from "../../permissions/types.js";
import type { ResourcePermissions } from "../../types/index.js";
import { pluralize } from "../../utils/pluralize.js";
import { convertActionSchemaToZod, createActionToolHandler } from "./action-tools.js";
import {
  ALL_CRUD_OPS,
  CRUD_ANNOTATIONS,
  createCrudHandler,
  defaultCrudDescription,
} from "./crud-tools.js";
import type { FieldRuleEntry } from "./fieldRulesToZod.js";
import { buildInputSchema, deriveFieldRulesFromAdapter, getAdapterBodies } from "./input-schema.js";
import {
  createCustomRouteHandler,
  createMcpHandlerPassthrough,
  slugifyRoute,
} from "./route-tools.js";
import { createMcpController } from "./tool-helpers.js";
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
  /** Per-operation tool name overrides: `{ get: 'get_job_by_id' }` */
  names?: Partial<Record<CrudOperation, string>>;
}

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
  // Controller is required for CRUD and string-handler routes, but NOT for
  // actions (which carry their own handler) or function-handler routes.
  const controller =
    resource.controller ?? (resource.adapter ? createMcpController(resource) : undefined);

  const explicitFieldRules = resource.schemaOptions?.fieldRules as
    | Record<string, FieldRuleEntry>
    | undefined;
  const hiddenFields = resource.schemaOptions?.hiddenFields;
  const readonlyFields = resource.schemaOptions?.readonlyFields;

  // DX fallback chain when the user didn't supply explicit fieldRules:
  //   1. Pull the adapter's generated body schemas once, used two ways:
  //      a) `jsonSchemaToZodShape` for create/update (high-fidelity)
  //      b) `deriveFieldRulesFromAdapter` for the list/filter path
  //   2. If the user DID supply fieldRules, those win.
  const adapterBodies = explicitFieldRules ? undefined : getAdapterBodies(resource);
  const fieldRules = explicitFieldRules ?? deriveFieldRulesFromAdapter(resource);

  const filterableFields =
    resource.schemaOptions?.filterableFields ?? resource.queryParser?.allowedFilterFields;
  const sortableFields = resource.queryParser?.allowedSortFields;
  const allowedOperators = resource.queryParser?.allowedOperators;

  const hasSoftDelete = resource._appliedPresets?.includes("softDelete") ?? false;

  const tools: ToolDefinition[] = [];
  const prefix = config.toolNamePrefix;

  // ── CRUD tools ──
  if (controller) {
    let ops = ALL_CRUD_OPS.filter((op) => !resource.disabledRoutes?.includes(op));
    if (config.operations) ops = ops.filter((op) => config.operations?.includes(op));

    for (const op of ops) {
      const name =
        config.names?.[op] ??
        (op === "list"
          ? `${prefix ? `${prefix}_` : ""}list_${pluralize(resource.name)}`
          : `${prefix ? `${prefix}_` : ""}${op}_${resource.name}`);

      tools.push({
        name,
        description:
          config.descriptions?.[op] ??
          defaultCrudDescription(op, resource.displayName, hasSoftDelete, {
            filterableFields,
            allowedOperators,
            sortableFields,
          }),
        annotations: CRUD_ANNOTATIONS[op],
        inputSchema: buildInputSchema(op, fieldRules, {
          hiddenFields,
          readonlyFields,
          extraHideFields: config.hideFields,
          filterableFields,
          allowedOperators,
          adapterBodies,
        }),
        handler: createCrudHandler(op, controller, resource.name, resource.permissions),
      });
    }
  }

  // ── Custom routes → MCP tools ──
  //
  // Runs REGARDLESS of controller presence — `mcpHandler` and function-handler
  // routes don't need one. Only string-handler routes (which dispatch by name
  // on the controller) require a controller.
  for (const route of resource.routes ?? []) {
    if (route.mcp === false) continue;

    const mcpHandler = route.mcpHandler as
      | ((input: Record<string, unknown>) => Promise<CallToolResult>)
      | undefined;

    const wrapHandler = !route.raw;
    if (!wrapHandler && !mcpHandler) continue;
    if (!mcpHandler && !["POST", "PUT", "PATCH", "DELETE"].includes(route.method)) continue;
    if (!mcpHandler && typeof route.handler === "string" && !controller) continue;

    const opName = route.operation ?? slugifyRoute(route.method, route.path);
    const hasId = route.path.includes(":id");

    const mcpConfig = typeof route.mcp === "object" && route.mcp !== null ? route.mcp : undefined;
    const toolDescription =
      mcpConfig?.description ??
      route.summary ??
      route.description ??
      `${opName} on ${resource.displayName}`;
    const toolAnnotations: ToolAnnotations = mcpConfig?.annotations
      ? { ...mcpConfig.annotations }
      : { openWorldHint: true };

    // Build input schema from route.schema (body + querystring) — mirrors
    // the REST contract so authors declare validation once. Without this,
    // MCP tools had only `id` in their input, forcing hosts to reason about
    // two parallel contracts for the same route.
    //
    // Priority:
    //   - schema.body (POST/PUT/PATCH/DELETE) — the primary input surface
    //   - schema.querystring merged IN ADDITION for routes that care about
    //     query params from MCP callers
    // The IR preserves `additionalProperties` — strict routes can be wired
    // the same way actions are.
    const inputShape: Record<string, z.ZodTypeAny> = {};
    if (hasId) inputShape.id = z.string().describe("Resource ID");

    const routeSchema = route.schema as
      | { body?: Record<string, unknown>; querystring?: Record<string, unknown> }
      | undefined;
    if (routeSchema?.body) {
      const ir = normalizeSchemaIR(routeSchema.body);
      for (const [key, val] of Object.entries(schemaIRToZodShape(ir))) {
        inputShape[key] = val;
      }
    }
    if (routeSchema?.querystring) {
      const ir = normalizeSchemaIR(routeSchema.querystring);
      for (const [key, val] of Object.entries(schemaIRToZodShape(ir))) {
        // Don't clobber body fields with querystring fields of the same
        // name — body wins (it's the primary input channel for mutations).
        if (!(key in inputShape)) inputShape[key] = val;
      }
    }

    const toolName = prefix ? `${prefix}_${opName}_${resource.name}` : `${opName}_${resource.name}`;

    tools.push({
      name: toolName,
      description: toolDescription,
      annotations: toolAnnotations,
      inputSchema: inputShape,
      handler: mcpHandler
        ? createMcpHandlerPassthrough(mcpHandler)
        : createCustomRouteHandler(route, controller, hasId, {
            resourceName: resource.name,
            operationName: opName,
            permissions: route.permissions,
            pipeline: resource.pipe,
          }),
    });
  }

  // ── Declarative actions → MCP tools (v2.8.1) ──
  if (resource.actions) {
    for (const [actionName, entry] of Object.entries(resource.actions)) {
      const def = typeof entry === "function" ? { handler: entry } : entry;
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

      // Build input schema: always requires `id`, plus action-specific fields
      const inputShape: Record<string, z.ZodTypeAny> = {
        id: z.string().describe("Resource ID"),
      };

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
      // Resolve via the shared chain so MCP honours the SAME fallback that
      // the HTTP router applies. Without this, `actions: { approve: fn }`
      // plus `permissions.update: requireAuth()` leaves the generated tool
      // with `undefined` — which `evaluatePermission()` treats as allow,
      // silently bypassing auth through the MCP surface.
      const actionPerms = resolveActionPermission({
        action: entry,
        resourcePermissions: resource.permissions as ResourcePermissions | undefined,
        resourceActionPermissions: resource.actionPermissions as PermissionCheck | undefined,
      });

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
          // Thread the raw schema through so the handler can enforce
          // `additionalProperties: false` at request time — HTTP AJV handles
          // this natively via the oneOf branches, MCP handles it here.
          rawSchema as Record<string, unknown> | undefined,
        ),
      });
    }
  }

  return tools;
}
