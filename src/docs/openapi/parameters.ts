/**
 * OpenAPI parameter helpers — path-param extraction and JSON-Schema →
 * query-parameter array conversion.
 */

import type { Parameter, SchemaObject } from "./types.js";

/**
 * Default query parameters for list endpoints when the resource hasn't
 * provided an explicit `openApiSchemas.listQuery` schema. These match
 * the defaults arc's `QueryParser` honours, so codegen consumers get
 * working scaffolds even for kits that don't surface a typed list query.
 */
export const DEFAULT_LIST_PARAMS: Parameter[] = [
  { name: "page", in: "query", schema: { type: "integer" }, description: "Page number" },
  { name: "limit", in: "query", schema: { type: "integer" }, description: "Items per page" },
  {
    name: "sort",
    in: "query",
    schema: { type: "string" },
    description: "Sort field (prefix with - for descending)",
  },
];

/**
 * Convert Fastify-style params (`/:id`) to OpenAPI-style params
 * (`/{id}`).
 */
export function toOpenApiPath(path: string): string {
  return path.replace(/:([^/]+)/g, "{$1}");
}

/**
 * Convert a JSON-Schema `{ type: 'object', properties: {...} }` into an
 * OpenAPI parameter array — each property becomes one query parameter.
 *
 * `description` is lifted from the property to the Parameter level
 * (OpenAPI's preferred location); the rest of the schema body stays in
 * `param.schema`.
 */
export function convertSchemaToParameters(schema: Record<string, unknown>): Parameter[] {
  const params: Parameter[] = [];
  const properties = (schema.properties as Record<string, Record<string, unknown>>) || {};
  const required = (schema.required as string[]) || [];

  for (const [name, prop] of Object.entries(properties)) {
    const description = prop.description as string | undefined;
    const { description: _, ...schemaProps } = prop;

    const param: Parameter = {
      name,
      in: "query",
      required: required.includes(name),
      schema: schemaProps as SchemaObject,
    };

    if (description) {
      param.description = description;
    }

    params.push(param);
  }
  return params;
}

/**
 * Extract path parameters from a route path (e.g. `/foo/:id/bar/:slug`
 * → `[{ name: 'id', ...}, { name: 'slug', ...}]`). All extracted params
 * are typed as `string` — Fastify path captures are always strings.
 */
export function extractPathParams(path: string): Parameter[] {
  const params: Parameter[] = [];
  const matches = path.matchAll(/:([^/]+)/g);

  for (const match of matches) {
    const paramName = match[1];
    if (paramName) {
      params.push({
        name: paramName,
        in: "path",
        required: true,
        schema: { type: "string" },
      });
    }
  }

  return params;
}
