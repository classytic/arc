/**
 * Better Auth OpenAPI Extractor
 *
 * Introspects a Better Auth instance's `api` object and extracts
 * OpenAPI-compatible path definitions from endpoint metadata.
 *
 * Schema conversion uses Zod v4's native `z.toJSONSchema()` via
 * the shared `schemaConverter` utility.
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

import type { ExternalOpenApiPaths } from "../docs/externalPaths.js";
import { toJsonSchema } from "../utils/schemaConverter.js";

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
  /**
   * Additional user fields from Better Auth config.
   * These get merged into signUpEmail/updateUser request body schemas
   * and the User component schema for $ref resolution.
   *
   * Fields with `input: false` are excluded from request bodies
   * but still appear in the User component schema (output-only).
   */
  userFields?: Record<
    string,
    {
      type: string;
      description?: string;
      /** Whether this field is required in sign-up (default: false) */
      required?: boolean;
      /** Whether this field is accepted in request body (default: true). Set false for output-only fields. */
      input?: boolean;
    }
  >;
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
        requestBody?: {
          content: Record<string, { schema: Record<string, unknown> }>;
          required?: boolean;
        };
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
  if (typeof value !== "function" && typeof value !== "object") return false;
  if (!value) return false;

  const v = value as Record<string, unknown>;
  return typeof v.path === "string" && typeof v.options === "object" && v.options !== null;
}

/**
 * Convert Fastify-style path params (/:id) to OpenAPI-style (/{id})
 */
function toOpenApiPath(path: string): string {
  return path.replace(/:([^/]+)/g, "{$1}");
}

/**
 * Extract path parameters from a path string
 */
function extractPathParams(
  path: string,
): Array<{ name: string; in: "path"; required: true; schema: { type: string } }> {
  const params: Array<{ name: string; in: "path"; required: true; schema: { type: string } }> = [];
  const matches = path.matchAll(/:(\w+)/g);
  for (const match of matches) {
    params.push({
      name: match[1]!,
      in: "path",
      required: true,
      schema: { type: "string" },
    });
  }
  return params;
}

/**
 * Extract OpenAPI paths from a Better Auth instance's API object.
 *
 * Walks `authApi` (the `auth.api` object from Better Auth), discovers
 * endpoints, converts their Zod schemas to JSON Schema via `z.toJSONSchema()`,
 * and returns a complete `ExternalOpenApiPaths` object ready for Arc's spec builder.
 */
export function extractBetterAuthOpenApi(
  authApi: Record<string, unknown>,
  options: BetterAuthOpenApiOptions = {},
): ExternalOpenApiPaths {
  const {
    basePath = "/api/auth",
    tagName = "Authentication",
    tagDescription = "Better Auth authentication endpoints",
    excludePaths = [],
    excludeServerOnly = true,
    userFields,
  } = options;

  const normalizedBase = basePath.replace(/\/+$/, "");
  const paths: Record<string, Record<string, unknown>> = {};

  // Auto-detect active plugins by inspecting available endpoints.
  // This avoids hardcoding plugin-specific schemes — the spec adapts to
  // whatever plugins the app has registered with Better Auth.
  const detectedPlugins = detectActivePlugins(authApi);

  // Build security options dynamically: session + bearer are always available,
  // others are added based on detected plugins.
  const securityOptions: Array<Record<string, unknown[]>> = [
    { cookieAuth: [] },
    { bearerAuth: [] },
  ];
  if (detectedPlugins.apiKey) {
    securityOptions.push({ apiKeyAuth: [] });
  }

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
        methods.push(...endpointOpts.method.map((m) => m.toLowerCase()));
      } else {
        methods.push(endpointOpts.method.toLowerCase());
      }
    } else {
      // Default: GET if no body, POST if body exists
      methods.push(endpointOpts.body ? "post" : "get");
    }

    // Extract OpenAPI metadata from endpoint
    const openApiMeta = endpointOpts.metadata?.openapi;

    // Build operation for each method
    for (const method of methods) {
      const operation: Record<string, unknown> = {
        tags: openApiMeta?.tags ?? [tagName],
        operationId: openApiMeta?.operationId ?? key,
        summary: openApiMeta?.summary ?? formatOperationSummary(key),
        security: securityOptions,
      };

      if (openApiMeta?.description) {
        operation.description = openApiMeta.description;
      }

      // Path parameters
      const pathParams = extractPathParams(endpointPath);
      const parameters: unknown[] = [...pathParams];

      // Query parameters (for GET/DELETE)
      if ((method === "get" || method === "delete") && endpointOpts.query) {
        const querySchema = toJsonSchema(endpointOpts.query);
        if (querySchema && querySchema.type === "object" && querySchema.properties) {
          const props = querySchema.properties as Record<string, Record<string, unknown>>;
          const required = (querySchema.required as string[]) ?? [];
          for (const [name, prop] of Object.entries(props)) {
            const paramEntry: Record<string, unknown> = {
              name,
              in: "query",
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
      if (method === "post" || method === "put" || method === "patch") {
        if (openApiMeta?.requestBody) {
          // Prefer metadata.openapi.requestBody (cleaner than Zod conversion)
          operation.requestBody = structuredClone(openApiMeta.requestBody);
        } else if (endpointOpts.body) {
          // Fall back to Zod body conversion
          const bodySchema = toJsonSchema(endpointOpts.body);
          if (bodySchema) {
            operation.requestBody = {
              required: true,
              content: {
                "application/json": { schema: bodySchema },
              },
            };
          }
        }

        // Merge userFields into sign-up and update-user request bodies
        if (userFields && isUserFieldEndpoint(endpointPath) && operation.requestBody) {
          mergeUserFieldsIntoRequestBody(
            operation.requestBody as Record<string, unknown>,
            userFields,
            endpointPath,
          );
        }
      }

      // Responses
      if (openApiMeta?.responses) {
        operation.responses = openApiMeta.responses;
      } else {
        // Default responses
        operation.responses = {
          "200": { description: "Success" },
          "400": { description: "Bad request" },
          "401": { description: "Unauthorized" },
        };
      }

      // Add to paths
      if (!paths[fullPath]) paths[fullPath] = {};
      (paths[fullPath] as Record<string, unknown>)[method] = operation;
    }
  }

  // Build component schemas for $ref resolution (e.g. $ref: "#/components/schemas/User")
  const schemas: Record<string, Record<string, unknown>> = {
    User: {
      type: "object",
      properties: {
        id: { type: "string" },
        name: { type: "string" },
        email: { type: "string", format: "email" },
        emailVerified: { type: "boolean" },
        image: { type: "string", nullable: true },
        createdAt: { type: "string", format: "date-time" },
        updatedAt: { type: "string", format: "date-time" },
      },
    },
    Session: {
      type: "object",
      properties: {
        id: { type: "string" },
        userId: { type: "string" },
        token: { type: "string" },
        expiresAt: { type: "string", format: "date-time" },
        ipAddress: { type: "string", nullable: true },
        userAgent: { type: "string", nullable: true },
        createdAt: { type: "string", format: "date-time" },
        updatedAt: { type: "string", format: "date-time" },
      },
    },
  };

  // Merge userFields into User component schema (all fields, including input: false)
  if (userFields) {
    const userProps = schemas.User?.properties as Record<string, unknown>;
    for (const [name, field] of Object.entries(userFields)) {
      const prop: Record<string, unknown> = { type: field.type };
      if (field.description) prop.description = field.description;
      userProps[name] = prop;
    }
  }

  // Build security schemes — always include cookieAuth, add plugin-specific schemes dynamically
  const securitySchemes: Record<string, Record<string, unknown>> = {
    cookieAuth: {
      type: "apiKey",
      in: "cookie",
      name: "better-auth.session_token",
      description: "Session cookie set by Better Auth after sign-in",
    },
  };

  if (detectedPlugins.apiKey) {
    securitySchemes.apiKeyAuth = {
      type: "apiKey",
      in: "header",
      name: "x-api-key",
      description:
        "API key for programmatic access. Pass org context via x-organization-id header.",
    };
  }

  // Build resourceSecurity — additional auth alternatives for Arc resource paths.
  // Each item is OR'd with bearerAuth; keys within the same object are AND'd.
  const resourceSecurity: Array<Record<string, string[]>> = [];
  if (detectedPlugins.apiKey) {
    // API key requires org header for tenant context (AND = same object)
    resourceSecurity.push({ apiKeyAuth: [], orgHeader: [] });
  }

  return {
    paths,
    schemas,
    securitySchemes,
    tags: [{ name: tagName, description: tagDescription }],
    resourceSecurity: resourceSecurity.length > 0 ? resourceSecurity : undefined,
  };
}

// ============================================================================
// Plugin Detection
// ============================================================================

interface DetectedPlugins {
  apiKey: boolean;
  organization: boolean;
}

/**
 * Auto-detect active Better Auth plugins by inspecting the API object.
 *
 * Rather than hardcoding plugin-specific behavior, we check for known
 * endpoint signatures that each plugin registers. This way the OpenAPI
 * spec adapts automatically to whatever plugins the app has enabled —
 * no Arc update needed when adding/removing plugins.
 */
function detectActivePlugins(authApi: Record<string, unknown>): DetectedPlugins {
  const endpointPaths = new Set<string>();

  for (const value of Object.values(authApi)) {
    if (isBetterAuthEndpoint(value)) {
      endpointPaths.add(value.path);
    }
  }

  return {
    // apiKey plugin registers /api-key/create
    apiKey: endpointPaths.has("/api-key/create"),
    // organization plugin registers /organization/create
    organization: endpointPaths.has("/organization/create"),
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
    .replace(/([A-Z])/g, " $1")
    .replace(/^./, (s) => s.toUpperCase())
    .trim();
}

/**
 * Check if an endpoint path should have userFields merged into its request body.
 */
function isUserFieldEndpoint(path: string): boolean {
  return path === "/sign-up/email" || path === "/update-user";
}

/**
 * Merge user-defined fields into an existing requestBody schema.
 * For updateUser, all fields are treated as optional regardless of their `required` setting.
 */
function mergeUserFieldsIntoRequestBody(
  requestBody: Record<string, unknown>,
  userFields: NonNullable<BetterAuthOpenApiOptions["userFields"]>,
  endpointPath: string,
): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const content = (requestBody as any)?.content?.["application/json"];
  if (!content?.schema) return;

  const schema = content.schema as Record<string, unknown>;

  if (!schema.properties) schema.properties = {};
  if (!schema.required) schema.required = [];

  const props = schema.properties as Record<string, unknown>;
  const required = schema.required as string[];

  for (const [name, field] of Object.entries(userFields)) {
    // Skip input: false fields (output-only, not accepted in request body)
    if (field.input === false) continue;

    // For updateUser, all fields are optional
    const isRequired = endpointPath === "/update-user" ? false : (field.required ?? false);

    const prop: Record<string, unknown> = { type: field.type };
    if (field.description) prop.description = field.description;
    props[name] = prop;

    if (isRequired && !required.includes(name)) {
      required.push(name);
    }
  }
}
