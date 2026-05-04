/**
 * Custom-route emitter — paths declared via `customRoutes` (typically
 * preset-injected, e.g. soft-delete's `GET /:resource/deleted`).
 *
 * Each route's request/response schemas are derived from `route.schema`
 * (Fastify route-schema shape with `body`, `querystring`, `response`).
 * Zod schemas pass through `convertRouteSchema` with the OpenAPI 3.0
 * target — we don't want numeric `exclusiveMinimum` leaking into a 3.0
 * doc that expects the boolean form.
 */

import type { PermissionCheck } from "../../permissions/types.js";
import type { RegistryEntry } from "../../types/index.js";
import { convertRouteSchema } from "../../utils/schemaConverter.js";
import { createOperation } from "./operations.js";
import { convertSchemaToParameters, extractPathParams, toOpenApiPath } from "./parameters.js";
import type { Operation, PathItem, SchemaObject } from "./types.js";

/**
 * Append every entry in `resource.customRoutes` to the `paths` map.
 */
export function appendCustomRoutePaths(
  paths: Record<string, PathItem>,
  resource: RegistryEntry,
  basePath: string,
  additionalSecurity: Array<Record<string, string[]>>,
): void {
  for (const route of resource.customRoutes || []) {
    const fullPath = toOpenApiPath(`${basePath}${route.path}`);
    const method = route.method.toLowerCase() as keyof PathItem;

    if (!paths[fullPath]) {
      paths[fullPath] = {};
    }

    // Auth gate — public routes carry `permissions._isPublic === true`.
    const handlerName =
      route.operation ?? (typeof route.handler === "string" ? route.handler : "handler");
    const isPublicRoute = (route.permissions as PermissionCheck)?._isPublic === true;
    const requiresAuthForRoute = !!route.permissions && !isPublicRoute;

    const extras: Partial<Operation> = {
      parameters: extractPathParams(route.path),
      responses: {
        "200": { description: route.description || "Success" },
      },
    };

    // Add request body from route.schema.body (for POST, PUT, PATCH).
    // Auto-convert Zod schemas to JSON Schema with the OpenAPI 3.0
    // target (arc emits OpenAPI 3.0.3 — using the Fastify default here
    // would leak numeric `exclusiveMinimum` into 3.0 docs that expect
    // the boolean form).
    const rawSchema = route.schema as Record<string, unknown> | undefined;
    const routeSchema = rawSchema ? convertRouteSchema(rawSchema, "openapi-3.0") : undefined;
    if (routeSchema?.body && ["post", "put", "patch"].includes(method)) {
      extras.requestBody = {
        required: true,
        content: {
          "application/json": {
            schema: routeSchema.body as SchemaObject,
          },
        },
      };
    }

    if (routeSchema?.querystring) {
      const queryParams = convertSchemaToParameters(
        routeSchema.querystring as Record<string, unknown>,
      );
      extras.parameters = [...(extras.parameters || []), ...queryParams];
    }

    if (routeSchema?.response) {
      const responseSchemas = routeSchema.response as Record<string, unknown>;
      for (const [statusCode, schema] of Object.entries(responseSchemas)) {
        // biome-ignore lint/style/noNonNullAssertion: extras.responses is initialised above
        extras.responses![statusCode] = {
          description:
            ((schema as Record<string, unknown>).description as string) || `Response ${statusCode}`,
          content: {
            "application/json": {
              schema: schema as SchemaObject,
            },
          },
        };
      }
    }

    paths[fullPath][method] = createOperation(
      resource,
      handlerName,
      route.summary ?? handlerName,
      extras,
      requiresAuthForRoute,
      additionalSecurity,
    );
  }
}
