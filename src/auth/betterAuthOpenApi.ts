/**
 * Better Auth OpenAPI Extractor
 *
 * Introspects a Better Auth instance's `api` object and extracts
 * OpenAPI-compatible path definitions from endpoint metadata.
 *
 * IMPORTANT: This module uses duck-typing to detect Zod schemas.
 * It does NOT import `zod` — it inspects runtime object shapes.
 * This avoids a hard dependency on zod/better-auth from Arc core.
 *
 * @example
 * ```typescript
 * import { extractBetterAuthOpenApi } from '@classytic/arc/auth';
 *
 * const auth = betterAuth({ ... });
 * const openapi = extractBetterAuthOpenApi(auth.api, { basePath: '/api/auth' });
 * // openapi.paths, openapi.securitySchemes, openapi.tags
 * ```
 */

import type { ExternalOpenApiPaths } from '../docs/externalPaths.js';

// ============================================================================
// Types
// ============================================================================

export interface BetterAuthOpenApiOptions {
  /** Base path prefix for auth routes (default: '/api/auth') */
  basePath?: string;
  /** Tag name for auth routes in OpenAPI (default: 'Authentication') */
  tagName?: string;
  /** Tag description */
  tagDescription?: string;
  /** Exclude specific paths from the spec (e.g. ['/ok', '/error']) */
  excludePaths?: string[];
  /** Exclude SERVER_ONLY endpoints (default: true) */
  excludeServerOnly?: boolean;
}

// ============================================================================
// Duck-Typed Zod → JSON Schema Converter
// ============================================================================

/**
 * Check if an object looks like a Zod schema (duck-typing).
 * Looks for `._def` with a `typeName` — the universal Zod marker.
 */
function isZodLike(obj: unknown): obj is { _def: { typeName: string; [k: string]: unknown }; shape?: Record<string, unknown> } {
  return (
    obj !== null &&
    typeof obj === 'object' &&
    '_def' in (obj as Record<string, unknown>) &&
    typeof (obj as Record<string, unknown>)._def === 'object' &&
    typeof ((obj as Record<string, unknown>)._def as Record<string, unknown>).typeName === 'string'
  );
}

/**
 * Convert a Zod-like schema to JSON Schema via duck-typing.
 * Handles common types without importing Zod.
 */
export function zodLikeToJsonSchema(schema: unknown): Record<string, unknown> | undefined {
  if (!isZodLike(schema)) return undefined;

  const { typeName } = schema._def;

  // ZodObject — walk .shape to extract properties
  if (typeName === 'ZodObject') {
    const shape = typeof schema.shape === 'function'
      ? (schema.shape as () => Record<string, unknown>)()
      : schema.shape;

    if (!shape || typeof shape !== 'object') return { type: 'object' };

    const properties: Record<string, unknown> = {};
    const required: string[] = [];

    for (const [key, value] of Object.entries(shape)) {
      const prop = zodLikeToJsonSchema(value);
      if (prop) {
        // Preserve description from Zod .describe() or .meta()
        if (isZodLike(value) && value._def.description) {
          (prop as Record<string, unknown>).description = value._def.description;
        }
        properties[key] = prop;
      }

      // Field is required unless it's ZodOptional or ZodDefault
      if (isZodLike(value)) {
        const innerType = value._def.typeName;
        if (innerType !== 'ZodOptional' && innerType !== 'ZodDefault') {
          required.push(key);
        }
      }
    }

    return {
      type: 'object',
      properties,
      ...(required.length > 0 && { required }),
    };
  }

  // ZodOptional — unwrap inner type
  if (typeName === 'ZodOptional') {
    const inner = zodLikeToJsonSchema(schema._def.innerType);
    return inner ?? { type: 'string' };
  }

  // ZodDefault — unwrap inner type + attach default value
  if (typeName === 'ZodDefault') {
    const inner = zodLikeToJsonSchema(schema._def.innerType);
    const defaultValue = typeof schema._def.defaultValue === 'function'
      ? (schema._def.defaultValue as () => unknown)()
      : schema._def.defaultValue;
    return { ...(inner ?? { type: 'string' }), default: defaultValue };
  }

  // ZodNullable — unwrap inner type
  if (typeName === 'ZodNullable') {
    const inner = zodLikeToJsonSchema(schema._def.innerType);
    return inner ?? { type: 'string' };
  }

  // ZodEnum — string enum
  if (typeName === 'ZodEnum') {
    return { type: 'string', enum: schema._def.values as string[] };
  }

  // ZodNativeEnum
  if (typeName === 'ZodNativeEnum') {
    const values = schema._def.values;
    if (values && typeof values === 'object') {
      return { type: 'string', enum: Object.values(values) };
    }
    return { type: 'string' };
  }

  // ZodLiteral
  if (typeName === 'ZodLiteral') {
    const value = schema._def.value;
    return { type: typeof value as string, enum: [value] };
  }

  // ZodArray — extract item type
  if (typeName === 'ZodArray') {
    const items = zodLikeToJsonSchema(schema._def.type);
    return { type: 'array', items: items ?? { type: 'string' } };
  }

  // ZodUnion / ZodDiscriminatedUnion
  if (typeName === 'ZodUnion' || typeName === 'ZodDiscriminatedUnion') {
    const options = schema._def.options as unknown[];
    if (Array.isArray(options)) {
      const oneOf = options.map(o => zodLikeToJsonSchema(o)).filter(Boolean);
      if (oneOf.length > 0) return { oneOf };
    }
    return { type: 'object' };
  }

  // ZodRecord
  if (typeName === 'ZodRecord') {
    const valueType = zodLikeToJsonSchema(schema._def.valueType);
    return { type: 'object', additionalProperties: valueType ?? { type: 'string' } };
  }

  // Primitives
  const typeMap: Record<string, string> = {
    ZodString: 'string',
    ZodNumber: 'number',
    ZodBoolean: 'boolean',
    ZodDate: 'string',
    ZodBigInt: 'integer',
    ZodAny: 'object',
    ZodUnknown: 'object',
    ZodVoid: 'object',
    ZodNull: 'string',
    ZodUndefined: 'string',
  };

  const jsonType = typeMap[typeName];
  if (jsonType) {
    const result: Record<string, unknown> = { type: jsonType };
    // ZodDate should have format: date-time
    if (typeName === 'ZodDate') result.format = 'date-time';
    // String format hints from Zod checks
    if (typeName === 'ZodString' && Array.isArray(schema._def.checks)) {
      for (const check of schema._def.checks as Array<{ kind: string }>) {
        if (check.kind === 'email') result.format = 'email';
        else if (check.kind === 'url') result.format = 'uri';
        else if (check.kind === 'uuid') result.format = 'uuid';
      }
    }
    return result;
  }

  // ZodEffects (transform, refine, preprocess) — unwrap inner
  if (typeName === 'ZodEffects') {
    return zodLikeToJsonSchema(schema._def.schema) ?? { type: 'object' };
  }

  // ZodPipeline — unwrap inner
  if (typeName === 'ZodPipeline') {
    return zodLikeToJsonSchema(schema._def.in) ?? { type: 'object' };
  }

  // ZodLazy — try to unwrap
  if (typeName === 'ZodLazy' && typeof schema._def.getter === 'function') {
    try {
      return zodLikeToJsonSchema((schema._def.getter as () => unknown)());
    } catch {
      return { type: 'object' };
    }
  }

  // Fallback
  return { type: 'object' };
}

// ============================================================================
// Better Auth Endpoint Discovery
// ============================================================================

/** Shape of a Better Auth endpoint function with metadata */
interface BetterAuthEndpoint {
  path: string;
  options: {
    method?: string | string[];
    body?: unknown;
    query?: unknown;
    metadata?: {
      openapi?: {
        summary?: string;
        description?: string;
        operationId?: string;
        responses?: Record<string, unknown>;
        tags?: string[];
      };
      SERVER_ONLY?: boolean;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
}

/**
 * Check if a value looks like a Better Auth endpoint (has .path and .options)
 */
function isBetterAuthEndpoint(value: unknown): value is BetterAuthEndpoint {
  if (typeof value !== 'function' && typeof value !== 'object') return false;
  if (!value) return false;

  const v = value as Record<string, unknown>;
  return (
    typeof v.path === 'string' &&
    typeof v.options === 'object' &&
    v.options !== null
  );
}

/**
 * Convert Fastify-style path params (/:id) to OpenAPI-style (/{id})
 */
function toOpenApiPath(path: string): string {
  return path.replace(/:([^/]+)/g, '{$1}');
}

/**
 * Extract path parameters from a path string
 */
function extractPathParams(path: string): Array<{ name: string; in: 'path'; required: true; schema: { type: string } }> {
  const params: Array<{ name: string; in: 'path'; required: true; schema: { type: string } }> = [];
  const matches = path.matchAll(/:(\w+)/g);
  for (const match of matches) {
    params.push({
      name: match[1]!,
      in: 'path',
      required: true,
      schema: { type: 'string' },
    });
  }
  return params;
}

/**
 * Extract OpenAPI paths from a Better Auth instance's API object.
 *
 * Walks `authApi` (the `auth.api` object from Better Auth), discovers
 * endpoints, converts their Zod schemas to JSON Schema, and returns
 * a complete `ExternalOpenApiPaths` object ready for Arc's spec builder.
 */
export function extractBetterAuthOpenApi(
  authApi: Record<string, unknown>,
  options: BetterAuthOpenApiOptions = {},
): ExternalOpenApiPaths {
  const {
    basePath = '/api/auth',
    tagName = 'Authentication',
    tagDescription = 'Better Auth authentication endpoints',
    excludePaths = [],
    excludeServerOnly = true,
  } = options;

  const normalizedBase = basePath.replace(/\/+$/, '');
  const paths: Record<string, Record<string, unknown>> = {};

  for (const [key, value] of Object.entries(authApi)) {
    if (!isBetterAuthEndpoint(value)) continue;

    const endpoint = value;
    const { path: endpointPath, options: endpointOpts } = endpoint;

    // Skip excluded paths
    if (excludePaths.includes(endpointPath)) continue;

    // Skip SERVER_ONLY endpoints
    if (excludeServerOnly && endpointOpts.metadata?.SERVER_ONLY) continue;

    // Build full path
    const fullPath = toOpenApiPath(`${normalizedBase}${endpointPath}`);

    // Determine HTTP method(s)
    const methods: string[] = [];
    if (endpointOpts.method) {
      if (Array.isArray(endpointOpts.method)) {
        methods.push(...endpointOpts.method.map(m => m.toLowerCase()));
      } else {
        methods.push(endpointOpts.method.toLowerCase());
      }
    } else {
      // Default: GET if no body, POST if body exists
      methods.push(endpointOpts.body ? 'post' : 'get');
    }

    // Extract OpenAPI metadata from endpoint
    const openApiMeta = endpointOpts.metadata?.openapi;

    // Build operation for each method
    for (const method of methods) {
      const operation: Record<string, unknown> = {
        tags: openApiMeta?.tags ?? [tagName],
        operationId: openApiMeta?.operationId ?? key,
        summary: openApiMeta?.summary ?? formatOperationSummary(key),
        security: [{ cookieAuth: [] }, { bearerAuth: [] }],
      };

      if (openApiMeta?.description) {
        operation.description = openApiMeta.description;
      }

      // Path parameters
      const pathParams = extractPathParams(endpointPath);
      const parameters: unknown[] = [...pathParams];

      // Query parameters (for GET/DELETE)
      if ((method === 'get' || method === 'delete') && endpointOpts.query) {
        const querySchema = zodLikeToJsonSchema(endpointOpts.query);
        if (querySchema && querySchema.type === 'object' && querySchema.properties) {
          const props = querySchema.properties as Record<string, Record<string, unknown>>;
          const required = (querySchema.required as string[]) ?? [];
          for (const [name, prop] of Object.entries(props)) {
            const paramEntry: Record<string, unknown> = {
              name,
              in: 'query',
              required: required.includes(name),
              schema: prop,
            };
            if (prop.description) {
              paramEntry.description = prop.description;
            }
            parameters.push(paramEntry);
          }
        }
      }

      if (parameters.length > 0) {
        operation.parameters = parameters;
      }

      // Request body (for POST/PUT/PATCH)
      if ((method === 'post' || method === 'put' || method === 'patch') && endpointOpts.body) {
        const bodySchema = zodLikeToJsonSchema(endpointOpts.body);
        if (bodySchema) {
          operation.requestBody = {
            required: true,
            content: {
              'application/json': { schema: bodySchema },
            },
          };
        }
      }

      // Responses
      if (openApiMeta?.responses) {
        operation.responses = openApiMeta.responses;
      } else {
        // Default responses
        operation.responses = {
          '200': { description: 'Success' },
          '400': { description: 'Bad request' },
          '401': { description: 'Unauthorized' },
        };
      }

      // Add to paths
      if (!paths[fullPath]) paths[fullPath] = {};
      (paths[fullPath] as Record<string, unknown>)[method] = operation;
    }
  }

  return {
    paths,
    securitySchemes: {
      cookieAuth: {
        type: 'apiKey',
        in: 'cookie',
        name: 'better-auth.session_token',
        description: 'Session cookie set by Better Auth after sign-in',
      },
    },
    tags: [{ name: tagName, description: tagDescription }],
  };
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Convert a camelCase key like 'signInEmail' to a readable summary like 'Sign in email'
 */
function formatOperationSummary(key: string): string {
  return key
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, (s) => s.toUpperCase())
    .trim();
}
