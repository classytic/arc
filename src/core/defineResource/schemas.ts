/**
 * OpenAPI schema resolution — Phase 7 of `defineResource()`.
 *
 * Pipeline (each step is a pure function over `OpenApiSchemas | undefined`):
 *
 *   adapter.generateSchemas()
 *     → stripSystemManagedFromBodyRequired   (from `../schemaOptions.js`)
 *     → cleanLegacyObjectIdParams            (idField safety net)
 *     → layerQueryParserListQuery            (kit's listQuery JSON Schema)
 *     → mergeUserOpenApiOverrides            (per-resource overrides)
 *     → convertOpenApiSchemas                (Zod → JSON Schema if needed)
 *
 * Non-fatal: if any step throws, the orchestrator returns `undefined` so
 * the resource still boots — docs / introspection / MCP tool schemas
 * degrade visibly instead of silently drifting.
 *
 * Pulled out of `defineResource.ts` so the central function reads as
 * orchestration only; the schema mechanics live next to each other and
 * are easier to evolve in isolation.
 */

import { arcLog } from "../../logger/index.js";
import type { RegisterOptions } from "../../registry/ResourceRegistry.js";
import type {
  AnyRecord,
  OpenApiSchemas,
  QueryParserInterface,
  ResourceConfig,
} from "../../types/index.js";
import { convertOpenApiSchemas } from "../../utils/schemaConverter.js";
import { stripSystemManagedFromBodyRequired } from "../schemaOptions.js";

/**
 * Phase 7 orchestrator — runs the schema pipeline and returns the
 * registry metadata for the resource. Returns `undefined` (with a
 * structured warn log) if any step throws.
 */
export function resolveOpenApiSchemas<TDoc>(
  resolvedConfig: ResourceConfig<TDoc>,
): RegisterOptions | undefined {
  try {
    let openApiSchemas = generateAdapterSchemas(resolvedConfig);
    openApiSchemas = stripSystemManagedFromBodyRequired(
      openApiSchemas,
      resolvedConfig.schemaOptions,
    );
    openApiSchemas = cleanLegacyObjectIdParams(openApiSchemas, resolvedConfig.idField);
    openApiSchemas = layerQueryParserListQuery(openApiSchemas, resolvedConfig.queryParser);
    openApiSchemas = mergeUserOpenApiOverrides(openApiSchemas, resolvedConfig.openApiSchemas);
    if (openApiSchemas) openApiSchemas = convertOpenApiSchemas(openApiSchemas);
    return { module: resolvedConfig.module, openApiSchemas };
  } catch (err) {
    // Schema-generation errors are non-fatal but not silent — the resource
    // boots and serves traffic; docs/introspection will be missing.
    // Honors `ARC_SUPPRESS_WARNINGS=1`.
    arcLog("defineResource").warn(
      `OpenAPI/MCP schema generation failed for resource "${resolvedConfig.name}": ${
        err instanceof Error ? err.message : String(err)
      }. Resource will boot without registry metadata — OpenAPI docs and MCP tool schemas will be missing.`,
    );
    return undefined;
  }
}

/**
 * Step 1 — delegate to the adapter's `generateSchemas`. Returns
 * `undefined` when the adapter doesn't implement the optional method.
 */
export function generateAdapterSchemas<TDoc>(
  resolvedConfig: ResourceConfig<TDoc>,
): OpenApiSchemas | undefined {
  if (!resolvedConfig.adapter?.generateSchemas) return undefined;
  const adapterContext = {
    idField: resolvedConfig.idField,
    resourceName: resolvedConfig.name,
  };
  return resolvedConfig.adapter.generateSchemas(resolvedConfig.schemaOptions, adapterContext) as
    | OpenApiSchemas
    | undefined;
}

/**
 * Safety net: when `idField` is overridden to a non-default value (UUIDs,
 * slugs, ORD-2026-0001), strip any ObjectId pattern left on `params.id` by
 * legacy adapters or plugins that didn't honor `AdapterSchemaContext.idField`.
 * Custom IDs must not be rejected by AJV before BaseController runs the
 * actual lookup.
 */
export function cleanLegacyObjectIdParams(
  openApiSchemas: OpenApiSchemas | undefined,
  idField: string | undefined,
): OpenApiSchemas | undefined {
  if (!openApiSchemas || !idField || idField === "_id") return openApiSchemas;
  const params = openApiSchemas.params as AnyRecord | undefined;
  if (!params || typeof params !== "object") return openApiSchemas;
  const properties = params.properties as AnyRecord | undefined;
  const idProp = properties?.id as AnyRecord | undefined;
  if (!idProp || typeof idProp !== "object") return openApiSchemas;

  const pattern = idProp.pattern;
  const isObjectIdPattern =
    typeof pattern === "string" &&
    (pattern === "^[0-9a-fA-F]{24}$" ||
      pattern === "^[a-f\\d]{24}$" ||
      pattern === "^[a-fA-F0-9]{24}$" ||
      /^\^\[[a-fA-F0-9\\d]+\]\{24\}\$$/.test(pattern));
  if (!isObjectIdPattern) return openApiSchemas;

  const cleanedId: AnyRecord = { ...idProp };
  delete cleanedId.pattern;
  delete cleanedId.minLength;
  delete cleanedId.maxLength;
  if (!cleanedId.description) {
    cleanedId.description = `${idField} (custom ID field)`;
  }
  return {
    ...openApiSchemas,
    params: {
      ...params,
      properties: { ...properties, id: cleanedId },
    } as AnyRecord,
  };
}

/**
 * Layer the query parser's `getQuerySchema()` output as `listQuery` so
 * the kit's filterable-fields surface flows into OpenAPI / MCP without
 * the user re-declaring it.
 */
export function layerQueryParserListQuery(
  openApiSchemas: OpenApiSchemas | undefined,
  queryParser: QueryParserInterface | unknown | undefined,
): OpenApiSchemas | undefined {
  const qp = queryParser as QueryParserInterface | undefined;
  if (!qp?.getQuerySchema) return openApiSchemas;
  const querySchema = qp.getQuerySchema();
  if (!querySchema) return openApiSchemas;
  return {
    ...openApiSchemas,
    listQuery: querySchema as unknown as AnyRecord,
  } as OpenApiSchemas;
}

/**
 * Apply per-resource `openApiSchemas` overrides on top of the kit's
 * generated schemas. Shallow merge by slot — users who want field-level
 * surgery should compose at the schema-options layer before this point.
 */
export function mergeUserOpenApiOverrides(
  openApiSchemas: OpenApiSchemas | undefined,
  userOverrides: OpenApiSchemas | undefined,
): OpenApiSchemas | undefined {
  if (!userOverrides) return openApiSchemas;
  return { ...openApiSchemas, ...userOverrides };
}
