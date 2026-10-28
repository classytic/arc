import { createMemoryResourceRateLimiter } from "../../permissions/resourceRateLimit.js";
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
import {
  normalizeActionsToRouterConfig,
  resolveActionTargetFence,
} from "../../core/defineResource/plugin.js";
import type { ResourceDefinition } from "../../core/defineResource.js";
import { withoutTenantInjection } from "../../permissions/tenantPreparation.js";
import type { PermissionCheck } from "../../permissions/types.js";
import { getOrgId, getUserId } from "../../scope/types.js";
import type { ResourcePermissions, RouteDefinition } from "../../types/index.js";
import { pluralize } from "../../utils/pluralize.js";
import { convertActionSchemaToZod, createActionToolHandler } from "./action-tools.js";
import { buildAggregationTools } from "./aggregation-tools.js";
import { buildScope } from "./buildRequestContext.js";
import {
  ALL_CRUD_OPS,
  CRUD_ANNOTATIONS,
  createCrudHandler,
  defaultCrudDescription,
  resolveCrudDescription,
  routeAnnotations,
} from "./crud-tools.js";
import type { FieldRuleEntry } from "./fieldRulesToZod.js";
import {
  assertMcpIdempotencyFencing,
  createToolRateLimiter,
  idempotencyStoreOf,
  rateLimitedResult,
} from "./http-parity.js";
import { buildInputSchema, deriveFieldRulesFromAdapter, getAdapterBodies } from "./input-schema.js";
import { buildRouteInputSchema } from "./route-input-schema.js";
import {
  createCustomRouteHandler,
  createMcpHandlerPassthrough,
  slugifyRoute,
} from "./route-tools.js";
import { createMcpController } from "./tool-helpers.js";
import type {
  CallToolResult,
  CrudOperation,
  McpAuthResult,
  McpExecutionWiring,
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
  /**
   * App-level execution wiring (hooks, events, audit, log, idempotency
   * store). `mcpPlugin` supplies this automatically from its Fastify
   * instance; standalone callers pass their own or omit it for
   * dispatch-only tools (no hooks/events/idempotency).
   */
  wiring?: McpExecutionWiring;
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
  // The parser's cap is the resource's answer to "how large may a page be?" —
  // the MCP schema must advertise THAT, not a second opinion.
  const maxLimit = resource.queryParser?.maxLimit;

  const hasSoftDelete = resource._appliedPresets?.includes("softDelete") ?? false;

  const tools: ToolDefinition[] = [];
  const prefix = config.toolNamePrefix;
  const wiring = config.wiring;
  assertMcpIdempotencyFencing(wiring);
  const hasIdempotencyStore = idempotencyStoreOf(wiring?.idempotencyStore) !== undefined;
  const keyRequiredOps = new Set<CrudOperation>(resource.idempotency?.required ?? []);
  const rateLimit = resource.rateLimit;
  const rateLimiter = config.wiring?.rateLimiter ?? createMemoryResourceRateLimiter();

  // ── CRUD tools ──
  if (controller) {
    let ops = ALL_CRUD_OPS.filter((op) => !resource.disabledRoutes?.includes(op));
    if (config.operations) ops = ops.filter((op) => config.operations?.includes(op));

    for (const op of ops) {
      // An ungated slot is public over HTTP only by omission; MCP never mounts it.
      if (!resource.permissions?.[op as keyof ResourcePermissions]) continue;
      const keyRequired = keyRequiredOps.has(op);
      if (keyRequired && !hasIdempotencyStore) {
        throw new Error(
          `[Arc/MCP] Resource '${resource.name}': '${op}' declares idempotency.required but no ` +
            "idempotency store is wired — register idempotencyPlugin before mcpPlugin, or the key " +
            "would be demanded and never deduplicated.",
        );
      }
      const name =
        config.names?.[op] ??
        (op === "list"
          ? `${prefix ? `${prefix}_` : ""}list_${pluralize(resource.name)}`
          : `${prefix ? `${prefix}_` : ""}${op}_${resource.name}`);

      // Render the auto-derived blurb once, then pass it into the override
      // resolver so the function-form override can extend the default
      // without re-deriving filterable/sortable lists by hand.
      const defaultDescription = defaultCrudDescription(op, resource.displayName, hasSoftDelete, {
        filterableFields,
        allowedOperators,
        sortableFields,
      });

      const inputSchema = buildInputSchema(op, fieldRules, {
        hiddenFields,
        readonlyFields,
        extraHideFields: config.hideFields,
        filterableFields,
        allowedOperators,
        maxLimit,
        adapterBodies,
      });
      // Advertise `_idempotencyKey` on mutating tools ONLY when a store is
      // wired — advertising a no-op input would mislead agents into a
      // retry-safety they don't have. The handler lifts it out of the
      // payload before dispatch, so it never reaches BodySanitizer.
      if (keyRequired) {
        inputSchema._idempotencyKey = z
          .string()
          .min(1)
          .describe("Required idempotency key — reuse it on a retry; the first result replays.");
      } else if (hasIdempotencyStore && op !== "list" && op !== "get") {
        inputSchema._idempotencyKey = z
          .string()
          .optional()
          .describe(
            "Optional idempotency key — retrying with the same key and input " +
              "replays the first successful result instead of re-executing.",
          );
      }

      tools.push({
        name,
        description: resolveCrudDescription(config.descriptions?.[op], {
          operation: op,
          displayName: resource.displayName,
          softDelete: hasSoftDelete,
          defaultDescription,
          filterableFields,
          allowedOperators,
          sortableFields,
        }),
        annotations: CRUD_ANNOTATIONS[op],
        // A read's unknown key is a dropped filter — a WIDER result. Refuse it instead of
        // letting the SDK's default z.object strip it.
        inputSchema: op === "list" || op === "get" ? z.strictObject(inputSchema) : inputSchema,
        handler: createCrudHandler(
          op,
          controller,
          resource.name,
          resource.permissions,
          resource.fields,
          {
            wiring,
            tenantMiddlewares: resource.middlewares?.[op],
            schemaOptions: resource.schemaOptions,
            idField: resource.idField,
            keyRequired,
            allow: createToolRateLimiter(rateLimit, resource.name, rateLimiter),
            toolName: name,
          },
        ),
        source: `crud:${resource.name}:${op}`,
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

    // A `rawHandler` route owns its own response, so there is no arc pipeline
    // result for MCP to bridge.
    const wrapHandler = route.rawHandler === undefined;
    if (!wrapHandler && !mcpHandler) continue;
    // 2.15.5 — GET routes are now auto-bridged to MCP via the shared
    // pipeline path (see `operationKindForRoute` in `route-tools.ts`).
    // Pre-2.15.5 every collection-style GET route forced authors to write
    // a parallel `mcpHandler` that hand-serialised the same data the HTTP
    // handler returned. The exclusion below stays only for the niche
    // case of a `rawHandler` GET route with no `mcpHandler` — for a pipeline
    // `handler` with no `mcpHandler`, the auto-bridge wraps it identically
    // to a POST.
    if (!mcpHandler && typeof route.handler === "string" && !controller) continue;

    // 2.16 — resolve `controllerMethod` (typed function-ref form) into
    // a concrete handler value here, BEFORE calling `createCustomRouteHandler`
    // which still expects the narrow `{handler}` contract. This mirrors what
    // `createCrudRouter` does for the HTTP path so MCP and HTTP route
    // resolution use the same rule. A route declared with only
    // `controllerMethod` (no `handler`) is unreachable from MCP unless we
    // resolve it here; the validator already enforces "exactly one of
    // handler / controllerMethod" so we don't need a mutual-exclusion check.
    const routeWithRef = route as typeof route & {
      controllerMethod?: (controller: unknown) => unknown;
    };
    // A `rawHandler` route only gets here WITH an `mcpHandler` (the guard
    // above skips the rest), so the resolved value is used purely to prove the
    // route has a dispatch target.
    let resolvedRouteHandler: RouteDefinition["handler"] | RouteDefinition["rawHandler"] =
      route.handler ?? route.rawHandler;
    if (typeof routeWithRef.controllerMethod === "function" && !resolvedRouteHandler) {
      if (!controller) continue; // No controller → can't resolve the ref; skip MCP tool.
      const referenced = routeWithRef.controllerMethod(controller);
      if (typeof referenced !== "function") continue;
      resolvedRouteHandler = (referenced as (...args: unknown[]) => unknown).bind(controller) as
        | RouteDefinition["handler"]
        | undefined;
    }
    // Skip routes that still have no resolvable handler — the validator
    // already catches "neither handler nor controllerMethod" at boot, so
    // this is a defensive backstop for direct `resourceToTools()` callers
    // that bypass `defineResource`'s validation.
    if (!resolvedRouteHandler) continue;

    const opName = route.operation ?? slugifyRoute(route.method, route.path);
    const hasId = route.path.includes(":id");

    const mcpConfig = typeof route.mcp === "object" && route.mcp !== null ? route.mcp : undefined;
    const toolDescription =
      mcpConfig?.description ??
      route.summary ??
      route.description ??
      `${opName} on ${resource.displayName}`;
    // Derived from the HTTP method unless the author declares their own.
    const toolAnnotations: ToolAnnotations = mcpConfig?.annotations
      ? { ...mcpConfig.annotations }
      : routeAnnotations(route.method);

    // The route's own schema is the tool's input contract — see route-input-schema.ts.
    const inputShape = buildRouteInputSchema(route, hasId);

    const toolName = prefix ? `${prefix}_${opName}_${resource.name}` : `${opName}_${resource.name}`;

    // Tag preset-emitted routes (softDelete's `restore` / `listDeleted`,
    // tree presets, etc.) distinctly from user-authored ones so the
    // collision detector in `createMcpServer` can auto-namespace the
    // preset side rather than crash the boot when a user `actions.restore`
    // legitimately shadows the preset.
    const routeSource = route._presetSource
      ? `preset:${route._presetSource}:${resource.name}:${opName}`
      : `route:${resource.name}:${route.method} ${route.path}`;

    const routePolicy = route.rateLimit !== undefined ? route.rateLimit : rateLimit;
    const allowRoute = createToolRateLimiter(
      routePolicy && typeof routePolicy === "object"
        ? {
            ...routePolicy,
            ...(route.rateLimit ? { bucket: `route:${route.method}:${route.path}` } : {}),
          }
        : routePolicy,
      resource.name,
      rateLimiter,
    );
    const passthrough = mcpHandler ? createMcpHandlerPassthrough(mcpHandler) : undefined;
    tools.push({
      name: toolName,
      description: toolDescription,
      annotations: toolAnnotations,
      inputSchema: inputShape,
      source: routeSource,
      handler: passthrough
        ? async (input, ctx) => {
            if (allowRoute && !(await allowRoute(ctx.session))) return rateLimitedResult(toolName);
            return passthrough(input, ctx);
          }
        : createCustomRouteHandler(
            // Project the route into the narrow shape `createCustomRouteHandler`
            // expects. `handler` is guaranteed defined here (we either
            // resolved `controllerMethod` above or short-circuited the loop).
            {
              handler: resolvedRouteHandler,
              operation: route.operation,
              method: route.method,
              path: route.path,
            },
            controller,
            hasId,
            {
              resourceName: resource.name,
              operationName: opName,
              allow: allowRoute,
              permissions: route.permissions,
              pipeline: resource.pipe,
              fields: resource.fields,
              wiring,
              tenantMiddlewares: route.tenantScope ? resource.middlewares?.tenantScope : undefined,
              schemaOptions: resource.schemaOptions,
              idField: resource.idField,
            },
          ),
    });
  }

  // ── Declarative actions → MCP tools (v2.8.1) ──
  if (resource.actions) {
    // The SAME derivation the HTTP action router uses — idempotency, target fence, gates.
    const actionConfig = normalizeActionsToRouterConfig(
      resource.actions,
      resource.actionPermissions as PermissionCheck | undefined,
      resource.tag,
      resource.permissions,
      resource.name,
      undefined,
    );
    const fence = resolveActionTargetFence(resource, actionConfig);
    const handlerScoped = new Set(actionConfig.handlerScopedActionNames);
    const keyRequiredActions = new Set(actionConfig.idempotentActionNames);
    const allow = createToolRateLimiter(rateLimit, resource.name, rateLimiter);
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

      // 2.15.5 — id-less actions (declared with `id: false`) mount at the
      // resource root (`POST /<prefix>/action`) and the MCP tool drops
      // the `id` input field. The handler receives `id: ""` for parity.
      const idLess = typeof def !== "function" && def.id === false;

      // Build input schema. Id-bound actions advertise an `id` field;
      // id-less actions skip it so agents don't pass a meaningless value.
      const inputShape: Record<string, z.ZodTypeAny> = idLess
        ? {}
        : { id: z.string().describe("Resource ID") };

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

      const keyRequired = keyRequiredActions.has(actionName);
      const handlerDedup = actionConfig.handlerDedupOwners[actionName] !== undefined;
      if (keyRequired && !handlerDedup && !hasIdempotencyStore) {
        throw new Error(
          `[Arc/MCP] Resource '${resource.name}': action '${actionName}' declares ` +
            "idempotency.required but no idempotency store is wired — register idempotencyPlugin " +
            "before mcpPlugin, or the key would be demanded and never deduplicated.",
        );
      }
      if (keyRequired) {
        inputShape._idempotencyKey = z
          .string()
          .min(1)
          .describe("Required idempotency key — reuse it on a retry; the first result replays.");
      }

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

      // Fail-closed: HTTP throws at boot in normalizeActionsToRouterConfig
      // when no gate resolves. That throw lives inside the resource's
      // `register()` plugin lifecycle, so a host calling `resourceToTools()`
      // directly (Level 2 MCP use) or registering `mcpPlugin` with resources
      // whose HTTP plugin is never registered would otherwise get an
      // unauthenticated mutating tool. Mirror the HTTP error shape so the
      // remediation is identical across surfaces.
      if (!actionPerms) {
        throw new Error(
          `[Arc/MCP] Resource '${resource.name}': action '${actionName}' has no permission gate ` +
            `and the resource defines no \`permissions.update\` fallback. ` +
            `Declare one of:\n` +
            `  - \`actions.${actionName}.permissions: <PermissionCheck>\` (per-action)\n` +
            `  - \`actionPermissions: <PermissionCheck>\` (resource-wide)\n` +
            `  - \`permissions.update: <PermissionCheck>\` (inherited by actions)\n` +
            `Use \`allowPublic()\` if you genuinely want the action unauthenticated.`,
        );
      }

      tools.push({
        name: toolName,
        description: String(description),
        annotations,
        inputSchema: inputShape,
        source: `action:${resource.name}:${actionName}`,
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
          // 2.15.5 — `idLess: true` drops `id` from the strict-mode allowed
          // key set and forces `id: ""` into the handler signature.
          idLess,
          // Field-read masking parity with the action's REST route.
          resource.fields,
          // Hooks/events/server parity with the action's REST route.
          {
            wiring,
            tenantMiddlewares: withoutTenantInjection(resource.middlewares?.tenantScope),
            schemaOptions: resource.schemaOptions,
            idField: resource.idField,
            parity: {
              toolName,
              keyRequired,
              handlerDedup,
              ...(fence && !idLess && !handlerScoped.has(actionName) ? { fence } : {}),
              audit: Boolean(resource.audit),
              ...(allow ? { allow } : {}),
            },
          },
        ),
      });
    }
  }

  // ── Declarative aggregations → MCP tools (v2.13) ──
  //
  // One tool per declared aggregation. Same boot-time validation,
  // permission gate, and cross-cutting middleware the REST route
  // applies — `executeAggregation` is the single source of truth.
  if (resource.aggregations && Object.keys(resource.aggregations).length > 0) {
    const repoForAgg = (resource.controller as { repository?: unknown })?.repository;
    // MCP doesn't have a Fastify request, so build the tenant options bag
    // from the session directly, projected into the same shape
    // `BaseCrudController.tenantRepoOptions(req)` produces.
    //
    // The session here is the FLAT `McpAuthResult` (userId / organizationId /
    // clientId at top level) — the shape `mcpPlugin` actually threads through
    // `ctx.session`. Pre-2.20 this read `session.scope.organizationId` /
    // `session.user.id`, a shape that never exists at runtime: both reads
    // were always undefined, so mongokit multi-tenant hosts got a 500 on
    // every MCP aggregation ("Missing 'organizationId' in context") and
    // hosts without a fail-closed tenant plugin ran aggregations
    // TENANT-UNSCOPED — a cross-tenant leak. `buildScope` is the canonical
    // McpAuthResult → RequestScope projection; reuse its accessors.
    const buildOptionsFromSession = (session: unknown): Record<string, unknown> => {
      const auth = (session ?? null) as McpAuthResult | null;
      const scope = buildScope(auth);
      const out: Record<string, unknown> = {};
      const orgId = getOrgId(scope);
      if (orgId) {
        // Default tenantField is 'organizationId' — match
        // BaseCrudController's stamping convention.
        out.organizationId = orgId;
      }
      const userId = getUserId(scope);
      if (userId) out.userId = userId;
      if (auth?.userId) {
        out.user = { id: auth.userId, roles: auth.roles ?? [], orgRoles: auth.orgRoles ?? [] };
      }
      return out;
    };

    tools.push(
      ...buildAggregationTools({
        resourceName: resource.name,
        displayName: resource.displayName ?? resource.name,
        aggregations: resource.aggregations,
        schemaOptions: resource.schemaOptions,
        repo: repoForAgg,
        buildOptionsFromSession,
        tenantMiddlewares: resource.middlewares?.aggregations,
        prefix,
        fields: resource.fields,
      }),
    );
  }

  return tools;
}
