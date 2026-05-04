/**
 * Aggregation → MCP tool translation.
 *
 * One MCP tool per declared aggregation. AI agents call these tools
 * to fetch dashboard data without having to assemble the AggRequest
 * IR themselves — the host already pinned `groupBy`, `measures`,
 * `lookups`, `having`, `sort`, `limit` at `defineResource()` time.
 *
 * Tool input is restricted to FILTER NARROWS — the same query-string
 * surface the REST route accepts. Agents can pass:
 *   - Top-level field filters (`{ status: 'pending' }`)
 *   - Operator objects (`{ createdAt: { gte: '2026-04-01' } }`)
 *   - Joined-alias paths when the aggregation declares lookups
 *     (`{ 'department.active': true }`)
 *
 * The actual aggregation execution reuses the same
 * `executeAggregation()` core the REST route uses — so safety guards
 * (`requireFilters`, `requireDateRange`, `maxGroups`), the
 * materialized hook, timeouts, and adapter feature-detection all
 * apply identically.
 *
 * Permission enforcement runs HERE (before `executeAggregation`)
 * because MCP sessions don't go through the Fastify preHandler chain.
 * Same fail-closed semantics: missing `permissions` is a boot error;
 * a denied check returns a structured tool-call error.
 */

import type { ErrorContract } from "@classytic/repo-core/errors";
import { z } from "zod";
import { executeAggregation } from "../../core/aggregation/buildHandler.js";
import type { AggregationConfig, AggregationsMap } from "../../core/aggregation/types.js";
import type { NormalizedAggregation } from "../../core/aggregation/validate.js";
import { validateAggregations } from "../../core/aggregation/validate.js";
import type { PermissionCheck } from "../../permissions/types.js";
import type { AnyRecord, RouteSchemaOptions } from "../../types/index.js";
import {
  evaluatePermission,
  permissionDeniedResult,
  toCallToolError,
  toCallToolSuccess,
} from "./tool-helpers.js";
import type { ToolAnnotations, ToolDefinition } from "./types.js";

/**
 * Build MCP tools for a resource's aggregations.
 *
 * Returns an empty array when the resource has no aggregations or
 * every aggregation opts out via `mcp: false`.
 */
export function buildAggregationTools(args: {
  resourceName: string;
  displayName: string;
  /** Map keyed by aggregation name — same shape `defineResource({ aggregations })` accepts. */
  aggregations: AggregationsMap | undefined;
  /** Resource schemaOptions — needed for boot-time field-rule validation. */
  schemaOptions: RouteSchemaOptions | undefined;
  /** Repository instance — must implement `aggregate?()`. */
  repo: unknown;
  /**
   * Tenant + audit options builder. MCP sessions don't carry a Fastify
   * request, so the caller passes a synthetic-context resolver that
   * extracts orgId / userId / requestId from the MCP session.
   */
  buildOptionsFromSession: (session: unknown) => AnyRecord;
  /** Optional tool name prefix (matches `prefix` in the action-tools path). */
  prefix?: string;
}): ToolDefinition[] {
  const {
    resourceName,
    displayName,
    aggregations,
    schemaOptions,
    repo,
    buildOptionsFromSession,
    prefix,
  } = args;

  if (!aggregations || Object.keys(aggregations).length === 0) return [];

  // Reuse the same boot-time validator the route registration uses.
  // Misconfigs (missing permissions, hidden fields in groupBy, etc.)
  // throw the same `ArcAggregationConfigError` here so MCP boot stays
  // consistent with REST boot.
  const normalized = validateAggregations(resourceName, aggregations, schemaOptions);

  const tools: ToolDefinition[] = [];

  for (const norm of normalized) {
    const config = norm.base;

    // Opt-out: `mcp: false` skips tool generation but the REST route
    // still works — same convention `actions[name].mcp` follows.
    if (config.mcp === false) continue;

    const mcpCfg = typeof config.mcp === "object" ? config.mcp : undefined;
    const description = buildAggregationToolDescription(norm, mcpCfg?.description);
    const annotations: ToolAnnotations = mcpCfg?.annotations
      ? { ...(mcpCfg.annotations as ToolAnnotations) }
      : {
          // Aggregations are read-shape — no destructive hint.
          readOnlyHint: true,
          idempotentHint: true,
        };

    const toolName = prefix
      ? `${prefix}_aggregation_${norm.name}_${resourceName}`
      : `aggregation_${norm.name}_${resourceName}`;

    tools.push({
      name: toolName,
      description,
      annotations,
      inputSchema: buildAggregationInputSchema(norm),
      handler: createAggregationToolHandler({
        normalized: norm,
        permissions: config.permissions,
        resourceName,
        repo,
        buildOptionsFromSession,
      }),
    });
  }

  // Pin display name in scope so it's visible to TS readers and we
  // don't get an unused-arg warning on the destructure.
  void displayName;

  return tools;
}

// ──────────────────────────────────────────────────────────────────────
// Tool description + input schema (declarative, derived from config)
// ──────────────────────────────────────────────────────────────────────

function buildAggregationToolDescription(
  norm: NormalizedAggregation,
  override: string | undefined,
): string {
  if (override) return override;
  const config = norm.base;
  const parts: string[] = [];
  if (config.summary) parts.push(config.summary);
  if (config.description && config.description !== config.summary) {
    parts.push(config.description);
  }
  const groupSummary = describeGroupBy(config.groupBy);
  const measureSummary = Object.keys(norm.compiled.measures).join(", ");
  if (groupSummary) {
    parts.push(`Groups by ${groupSummary}; measures: ${measureSummary}.`);
  } else {
    parts.push(`Scalar aggregate. Measures: ${measureSummary}.`);
  }
  if (config.requireDateRange) {
    parts.push(
      `Requires a bounded date range on \`${config.requireDateRange.field}\`.` +
        (config.requireDateRange.maxRangeDays
          ? ` Max range: ${config.requireDateRange.maxRangeDays} days.`
          : ""),
    );
  }
  if (config.requireFilters?.length) {
    parts.push(`Requires filters on: ${config.requireFilters.join(", ")}.`);
  }
  return parts.join(" ");
}

function describeGroupBy(groupBy: AggregationConfig["groupBy"]): string {
  if (!groupBy) return "";
  if (typeof groupBy === "string") return `\`${groupBy}\``;
  if (groupBy.length === 0) return "";
  return groupBy.map((g) => `\`${g}\``).join(", ");
}

/**
 * Build the MCP tool input schema.
 *
 * Aggregation tools accept a single `filter` object mapping field
 * name → value or operator object. Open-shape so agents can pass any
 * caller-side narrows; safety guards inside `executeAggregation`
 * enforce required fields.
 */
function buildAggregationInputSchema(norm: NormalizedAggregation): Record<string, z.ZodTypeAny> {
  const config = norm.base;

  // We expose `filter` as `z.record(z.unknown())` — the runtime
  // executor handles operator objects, dotted-paths, and tenant-scope
  // composition. Tighter typing here would force agents to assemble
  // a typed object that runtime-converts back to the same shape.
  const filter = z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      "Caller-supplied filter narrowing. Keys are field names (or " +
        "`'<alias>.<field>'` joined-alias paths when the aggregation " +
        "declares lookups). Values are literals or operator objects " +
        "(`{ gte, lte, in, ... }`).",
    );

  const shape: Record<string, z.ZodTypeAny> = { filter };

  // Surface required filters explicitly so agents see them in the
  // input schema instead of discovering them via runtime 400s.
  if (config.requireFilters?.length) {
    shape.requireFiltersHint = z
      .literal(config.requireFilters.join(", "))
      .optional()
      .describe(
        `REQUIRED FILTERS — supply ${config.requireFilters
          .map((f) => `\`filter.${f}\``)
          .join(" + ")} for this aggregation to run. Missing fields → 400.`,
      );
  }

  if (config.requireDateRange) {
    shape.requireDateRangeHint = z
      .literal(config.requireDateRange.field)
      .optional()
      .describe(
        `REQUIRED DATE RANGE — supply \`filter['${config.requireDateRange.field}'] = ` +
          `{ gte: '<lower>', lte: '<upper>' }\`.` +
          (config.requireDateRange.maxRangeDays
            ? ` Range capped at ${config.requireDateRange.maxRangeDays} days.`
            : ""),
      );
  }

  return shape;
}

// ──────────────────────────────────────────────────────────────────────
// Handler — permission check + executeAggregation
// ──────────────────────────────────────────────────────────────────────

interface CreateHandlerArgs {
  normalized: NormalizedAggregation;
  permissions: PermissionCheck;
  resourceName: string;
  repo: unknown;
  buildOptionsFromSession: (session: unknown) => AnyRecord;
}

function createAggregationToolHandler(args: CreateHandlerArgs): ToolDefinition["handler"] {
  const { normalized, permissions, resourceName, repo, buildOptionsFromSession } = args;

  return async (input, ctx) => {
    // Permission check first — same gate the Fastify route runs.
    const permResult = await evaluatePermission(
      permissions,
      ctx.session,
      resourceName,
      `aggregation:${normalized.name}`,
      input,
    );
    if (permResult && !permResult.granted) {
      return permissionDeniedResult({
        resource: resourceName,
        operation: `aggregation:${normalized.name}`,
        reason: permResult.reason,
        session: ctx.session,
      });
    }

    // Build a synthetic query record from the input filter map.
    // `executeAggregation` strips reserved keys and merges the
    // remainder into the AggRequest filter via shallow merge with
    // host base + tenant scope.
    const filterInput = (input.filter as Record<string, unknown> | undefined) ?? {};
    const tenantOptions = buildOptionsFromSession(ctx.session);

    // Permission filters ride along on the tenant options bag — kit
    // plugins (multi-tenant, audit) read them on the options side.
    if (permResult?.filters) {
      // Don't overwrite tenant scope; permission filters narrow further.
      Object.assign(tenantOptions, { _policyFilters: permResult.filters });
    }

    const result = await executeAggregation(
      normalized,
      { repo, buildOptions: () => tenantOptions },
      {
        query: filterInput,
        tenantOptions,
      },
    );

    // No-envelope contract: status discriminates. On 200 the body is
    // `{ rows }`; on 4xx/5xx it's the canonical `ErrorContract`. MCP
    // wraps via the shared helpers so the same JSON shape an HTTP
    // client would see ends up inside the tool-call result.
    if (result.status === 200) {
      return toCallToolSuccess(result.body);
    }
    return toCallToolError(result.body as ErrorContract);
  };
}
