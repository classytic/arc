/**
 * Declarative aggregation endpoint emitter — one path per aggregation,
 * `GET /:resource/aggregations/:name`.
 *
 * Response shape is `{ rows: AggResult[] }` matching repo-core's
 * `AggResult` contract — a row schema is built per-aggregation from the
 * declared groupBy fields + measure aliases (every measure resolves to
 * `number` because `count` / `sum` / `avg` / `min` / `max` /
 * `countDistinct` all yield numerics).
 *
 * Auth requirement is read from each aggregation's own `permissions`
 * function — same fallback chain runtime + MCP use.
 */

import type { PermissionCheck } from "../../permissions/types.js";
import type { RegistryEntry } from "../../types/index.js";
import { createOperation, errorResponse } from "./operations.js";
import { toOpenApiPath } from "./parameters.js";
import type { PathItem, SchemaObject } from "./types.js";

/**
 * Emit one OpenAPI path entry per declared aggregation.
 *
 * Path:     `GET /:resource/aggregations/<name>`
 * Response: `{ rows: AggregationRow[] }` where each row is keyed by
 *           the groupBy fields (nested object for joined-alias paths)
 *           plus the measure aliases.
 */
export function appendAggregationPaths(
  paths: Record<string, PathItem>,
  resource: RegistryEntry,
  basePath: string,
  additionalSecurity: Array<Record<string, string[]>>,
): void {
  if (!resource.aggregations) return;
  for (const agg of resource.aggregations) {
    const path = toOpenApiPath(`${basePath}/aggregations/${agg.name}`);
    const requiresAuth = !(agg.permissions as PermissionCheck | undefined)?._isPublic;

    const groupByFields = normalizeGroupByForOpenApi(agg.groupBy);
    const rowSchema = buildAggregationRowSchema(groupByFields, agg.measures, agg.lookupAliases);

    const querystring: Record<string, unknown> = {
      type: "object",
      properties: {} as Record<string, unknown>,
      additionalProperties: true, // callers add `?status=pending` etc.
    };
    if (agg.requireDateRange) {
      const props = querystring.properties as Record<string, unknown>;
      const f = agg.requireDateRange.field;
      props[`${f}[gte]`] = {
        type: "string",
        description: `Lower bound (inclusive) of required date range on \`${f}\`.`,
      };
      props[`${f}[lte]`] = {
        type: "string",
        description: `Upper bound (inclusive) of required date range on \`${f}\`.`,
      };
    }
    if (agg.requireFilters?.length) {
      const props = querystring.properties as Record<string, unknown>;
      for (const f of agg.requireFilters) {
        props[f] = {
          type: "string",
          description: `Required filter on \`${f}\` — request rejected (400) if missing.`,
        };
      }
    }

    const descLines: string[] = [];
    if (agg.description) descLines.push(agg.description);
    descLines.push(
      `Portable aggregation. Caller filters via query string narrow the base + tenant scope; ` +
        `response shape is \`{ rows: [...] }\` matching repo-core's \`AggResult\` contract.`,
    );
    if (Object.keys(agg.measures).length > 0) {
      const measureLines = Object.entries(agg.measures)
        .map(([alias, op]) => `- \`${alias}\` — \`${op}\``)
        .join("\n");
      descLines.push("", "**Measures:**", measureLines);
    }
    if (agg.requireDateRange) {
      descLines.push(
        "",
        `**Required date range** on \`${agg.requireDateRange.field}\` — supply ` +
          `\`?${agg.requireDateRange.field}[gte]=...&${agg.requireDateRange.field}[lte]=...\`.` +
          (agg.requireDateRange.maxRangeDays
            ? ` Range cap: ${agg.requireDateRange.maxRangeDays} days.`
            : ""),
      );
    }

    if (!paths[path]) paths[path] = {};
    paths[path].get = createOperation(
      resource,
      `aggregation.${agg.name}`,
      agg.summary ?? `Aggregation: ${agg.name}`,
      {
        description: descLines.join("\n"),
        parameters: [
          {
            name: "querystring",
            in: "query",
            required: false,
            schema: querystring as SchemaObject,
            description: "Filter narrowing — composes with base filter + tenant scope.",
          },
        ],
        responses: {
          "200": {
            description: "Aggregation result",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["rows"],
                  properties: {
                    rows: {
                      type: "array",
                      items: rowSchema as SchemaObject,
                    },
                  },
                } as SchemaObject,
              },
            },
          },
          "400": errorResponse("Missing required filter or invalid date range"),
          "422": errorResponse("Result row count exceeded `maxGroups` cap"),
          "501": errorResponse("Adapter does not implement `aggregate()`"),
          "504": errorResponse("Aggregation execution timed out"),
        },
      },
      requiresAuth,
      additionalSecurity,
    );
  }
}

/**
 * Build the JSON Schema for a single aggregation row. Combines the
 * groupBy field shape (nested for joined-alias paths) with the
 * measure-alias scalars.
 *
 * Group keys with dotted paths (e.g. `'category.code'`) emit a nested
 * `category: { code: string }` object, matching the cross-kit
 * `nestDottedKeys` output. Plain group keys are flat.
 *
 * Measure scalars are always `number` — every measure op
 * (`count` / `sum` / `avg` / `min` / `max` / `countDistinct`)
 * produces a numeric result.
 */
function buildAggregationRowSchema(
  groupByFields: readonly string[],
  measures: Readonly<Record<string, string>>,
  _lookupAliases: readonly string[],
): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const field of groupByFields) {
    setNestedSchemaProp(properties, field.split("."), { type: "string" });
  }
  for (const alias of Object.keys(measures)) {
    properties[alias] = { type: "number" };
  }
  return {
    type: "object",
    properties,
    additionalProperties: false,
  };
}

function normalizeGroupByForOpenApi(
  groupBy: string | readonly string[] | undefined,
): readonly string[] {
  if (!groupBy) return [];
  return typeof groupBy === "string" ? [groupBy] : groupBy;
}

function setNestedSchemaProp(
  target: Record<string, unknown>,
  path: readonly string[],
  leaf: Record<string, unknown>,
): void {
  if (path.length === 1) {
    target[path[0] as string] = leaf;
    return;
  }
  const head = path[0] as string;
  const rest = path.slice(1);
  let nested = target[head] as Record<string, unknown> | undefined;
  if (!nested || typeof nested !== "object") {
    nested = { type: "object", properties: {} as Record<string, unknown> };
    target[head] = nested;
  }
  const props = nested.properties as Record<string, unknown> | undefined;
  if (!props) {
    nested.properties = {};
  }
  setNestedSchemaProp(nested.properties as Record<string, unknown>, rest, leaf);
}
