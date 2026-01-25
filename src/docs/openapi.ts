/**
 * OpenAPI Spec Generator
 *
 * Auto-generates OpenAPI 3.0 specification from Arc resource registry.
 *
 * @example
 * import { openApiPlugin } from '@classytic/arc/docs';
 *
 * await fastify.register(openApiPlugin, {
 *   title: 'My API',
 *   version: '1.0.0',
 * });
 *
 * // Spec available at /_docs/openapi.json
 */

import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { resourceRegistry } from '../registry/index.js';
import type { RegistryEntry } from '../types/index.js';

export interface OpenApiOptions {
  /** API title */
  title?: string;
  /** API version */
  version?: string;
  /** API description */
  description?: string;
  /** Server URL */
  serverUrl?: string;
  /** Route prefix for spec endpoint (default: '/_docs') */
  prefix?: string;
  /** API prefix for all resource paths (e.g., '/api/v1') */
  apiPrefix?: string;
  /** Auth roles required to access spec (default: [] = public) */
  authRoles?: string[];
  /** Include internal routes (default: false) */
  includeInternal?: boolean;
  /** Custom OpenAPI extensions */
  extensions?: Record<string, unknown>;
}

export interface OpenApiSpec {
  openapi: string;
  info: {
    title: string;
    version: string;
    description?: string;
  };
  servers?: Array<{ url: string; description?: string }>;
  paths: Record<string, PathItem>;
  components: {
    schemas: Record<string, SchemaObject>;
    securitySchemes?: Record<string, SecurityScheme>;
  };
  tags: Array<{ name: string; description?: string }>;
  security?: Array<Record<string, string[]>>;
}

interface PathItem {
  get?: Operation;
  post?: Operation;
  put?: Operation;
  patch?: Operation;
  delete?: Operation;
  options?: Operation;
  head?: Operation;
}

interface Operation {
  tags: string[];
  summary: string;
  description?: string;
  operationId: string;
  parameters?: Parameter[];
  requestBody?: RequestBody;
  responses: Record<string, Response>;
  security?: Array<Record<string, string[]>>;
}

interface Parameter {
  name: string;
  in: 'path' | 'query' | 'header';
  required?: boolean;
  schema: SchemaObject;
  description?: string;
}

interface RequestBody {
  required?: boolean;
  content: Record<string, { schema: SchemaObject }>;
}

interface Response {
  description: string;
  content?: Record<string, { schema: SchemaObject }>;
}

interface SchemaObject {
  type?: string;
  format?: string;
  properties?: Record<string, SchemaObject>;
  items?: SchemaObject;
  required?: string[];
  $ref?: string;
  description?: string;
  example?: unknown;
  additionalProperties?: boolean | SchemaObject;
  enum?: string[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
}

interface SecurityScheme {
  type: string;
  scheme?: string;
  bearerFormat?: string;
  in?: string;
  name?: string;
}

const openApiPlugin: FastifyPluginAsync<OpenApiOptions> = async (
  fastify: FastifyInstance,
  opts: OpenApiOptions = {}
) => {
  const {
    title = 'Arc API',
    version = '1.0.0',
    description,
    serverUrl,
    prefix = '/_docs',
    apiPrefix = '',
    authRoles = [],
  } = opts;

  // Build spec from registry (schemas are pre-generated at resource definition time)
  const buildSpec = (): OpenApiSpec => {
    const resources = resourceRegistry.getAll();
    const paths: Record<string, PathItem> = {};
    const tags: Array<{ name: string; description?: string }> = [];

    for (const resource of resources) {
      // Add tag for resource
      tags.push({
        name: resource.tag || resource.name,
        description: `${resource.displayName || resource.name} operations`,
      });

      // Generate paths for this resource (with API prefix)
      const resourcePaths = generateResourcePaths(resource, apiPrefix);
      Object.assign(paths, resourcePaths);
    }

    return {
      openapi: '3.0.3',
      info: {
        title,
        version,
        ...(description && { description }),
      },
      ...(serverUrl && {
        servers: [{ url: serverUrl }],
      }),
      paths,
      components: {
        schemas: generateSchemas(resources),
        securitySchemes: {
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'JWT',
          },
          orgHeader: {
            type: 'apiKey',
            in: 'header',
            name: 'x-organization-id',
          },
        },
      },
      tags,
      // Note: Security is defined per-operation, not globally
      // This allows public routes to have no security requirement
    };
  };

  // Serve OpenAPI spec
  fastify.get(`${prefix}/openapi.json`, async (request, reply) => {
    // Check auth if required
    if (authRoles.length > 0) {
      const user = (request as { user?: { roles?: string[] } }).user;
      const hasRole = authRoles.some((role) => user?.roles?.includes(role));
      if (!hasRole && !user?.roles?.includes('superadmin')) {
        reply.code(403).send({ error: 'Access denied' });
        return;
      }
    }

    const spec = buildSpec();
    // Return object directly - let Fastify handle serialization & compression
    return spec;
  });

  fastify.log?.info?.(`OpenAPI spec available at ${prefix}/openapi.json`);
};

/**
 * Convert Fastify-style params (/:id) to OpenAPI-style params (/{id})
 */
function toOpenApiPath(path: string): string {
  return path.replace(/:([^/]+)/g, '{$1}');
}

/**
 * Convert OpenAPI schema to query parameters array
 * Transforms { properties: { page: { type: 'integer' } } } to [{ name: 'page', in: 'query', schema: { type: 'integer' } }]
 */
function convertSchemaToParameters(schema: Record<string, unknown>): Parameter[] {
  const params: Parameter[] = [];
  const properties = (schema.properties as Record<string, Record<string, unknown>>) || {};
  const required = (schema.required as string[]) || [];

  for (const [name, prop] of Object.entries(properties)) {
    // Extract description separately (goes to Parameter level, not schema)
    const description = prop.description as string | undefined;
    const { description: _, ...schemaProps } = prop;

    const param: Parameter = {
      name,
      in: 'query',
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
 * Default query parameters when no listQuery schema is provided
 */
const DEFAULT_LIST_PARAMS: Parameter[] = [
  { name: 'page', in: 'query', schema: { type: 'integer' }, description: 'Page number' },
  { name: 'limit', in: 'query', schema: { type: 'integer' }, description: 'Items per page' },
  { name: 'sort', in: 'query', schema: { type: 'string' }, description: 'Sort field (prefix with - for descending)' },
];

/**
 * Generate paths for a resource
 */
function generateResourcePaths(resource: RegistryEntry, apiPrefix = ''): Record<string, PathItem> {
  const paths: Record<string, PathItem> = {};
  const basePath = `${apiPrefix}${resource.prefix}`;

  // Skip if default routes are disabled and no additional routes
  if (resource.disableDefaultRoutes && (!resource.additionalRoutes || resource.additionalRoutes.length === 0)) {
    return paths;
  }

  // Default CRUD routes
  if (!resource.disableDefaultRoutes) {
    // GET / - List
    // Use custom listQuery schema if provided, otherwise use defaults
    const listParams = resource.openApiSchemas?.listQuery
      ? convertSchemaToParameters(resource.openApiSchemas.listQuery as Record<string, unknown>)
      : DEFAULT_LIST_PARAMS;

    paths[basePath] = {
      get: createOperation(resource, 'list', 'List all', {
        parameters: listParams,
        responses: {
          '200': {
            description: 'List of items',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { type: 'boolean' },
                    data: { type: 'array', items: { $ref: `#/components/schemas/${resource.name}` } },
                    pagination: { $ref: '#/components/schemas/Pagination' },
                  },
                },
              },
            },
          },
        },
      }),
      post: createOperation(resource, 'create', 'Create new', {
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: `#/components/schemas/${resource.name}Input` },
            },
          },
        },
        responses: {
          '201': {
            description: 'Created successfully',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { type: 'boolean' },
                    data: { $ref: `#/components/schemas/${resource.name}` },
                    message: { type: 'string' },
                  },
                },
              },
            },
          },
        },
      }),
    };

    // GET/PATCH/DELETE /:id
    paths[toOpenApiPath(`${basePath}/:id`)] = {
      get: createOperation(resource, 'get', 'Get by ID', {
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '200': {
            description: 'Item found',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { type: 'boolean' },
                    data: { $ref: `#/components/schemas/${resource.name}` },
                  },
                },
              },
            },
          },
          '404': { description: 'Not found' },
        },
      }),
      patch: createOperation(resource, 'update', 'Update', {
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: `#/components/schemas/${resource.name}Input` },
            },
          },
        },
        responses: {
          '200': {
            description: 'Updated successfully',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { type: 'boolean' },
                    data: { $ref: `#/components/schemas/${resource.name}` },
                    message: { type: 'string' },
                  },
                },
              },
            },
          },
        },
      }),
      delete: createOperation(resource, 'delete', 'Delete', {
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '200': {
            description: 'Deleted successfully',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { type: 'boolean' },
                    message: { type: 'string' },
                  },
                },
              },
            },
          },
        },
      }),
    };
  }

  // Additional routes from presets
  for (const route of resource.additionalRoutes || []) {
    const fullPath = toOpenApiPath(`${basePath}${route.path}`);
    const method = route.method.toLowerCase() as keyof PathItem;

    if (!paths[fullPath]) {
      paths[fullPath] = {};
    }

    // Check if route requires auth (not public)
    const handlerName = typeof route.handler === 'string' ? route.handler : 'handler';
    const isPublicRoute = (route.permissions as { _isPublic?: boolean })?._isPublic === true;
    const requiresAuthForRoute = !!route.permissions && !isPublicRoute;

    // Build extras from route schema
    const extras: Partial<Operation> = {
      parameters: extractPathParams(route.path),
      responses: {
        '200': { description: route.description || 'Success' },
      },
    };

    // Add request body from route.schema.body (for POST, PUT, PATCH)
    const routeSchema = route.schema as Record<string, unknown> | undefined;
    if (routeSchema?.body && ['post', 'put', 'patch'].includes(method)) {
      extras.requestBody = {
        required: true,
        content: {
          'application/json': {
            schema: routeSchema.body as SchemaObject,
          },
        },
      };
    }

    // Add query parameters from route.schema.querystring
    if (routeSchema?.querystring) {
      const queryParams = convertSchemaToParameters(routeSchema.querystring as Record<string, unknown>);
      extras.parameters = [...(extras.parameters || []), ...queryParams];
    }

    // Add custom response schema if provided
    if (routeSchema?.response) {
      const responseSchemas = routeSchema.response as Record<string, unknown>;
      for (const [statusCode, schema] of Object.entries(responseSchemas)) {
        extras.responses![statusCode] = {
          description: (schema as Record<string, unknown>).description as string || `Response ${statusCode}`,
          content: {
            'application/json': {
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
      requiresAuthForRoute
    );
  }

  return paths;
}

/**
 * Create an operation object
 * @param requiresAuthOverride - Override for whether auth is required (for additional routes)
 */
function createOperation(
  resource: RegistryEntry,
  operation: string,
  summary: string,
  extras: Partial<Operation>,
  requiresAuthOverride?: boolean
): Operation {
  const permissions = resource.permissions || {};
  // Check if permission check is defined for this operation
  const operationPermission = (permissions as Record<string, unknown>)[operation];
  // Check if it's marked as public (allowPublic())
  const isPublic = (operationPermission as { _isPublic?: boolean })?._isPublic === true;
  // If override is provided, use it; otherwise check if operation has a permission check that isn't public
  const requiresAuth = requiresAuthOverride !== undefined
    ? requiresAuthOverride
    : typeof operationPermission === 'function' && !isPublic;

  return {
    tags: [resource.tag || 'Resource'],
    summary: `${summary} ${(resource.displayName || resource.name).toLowerCase()}`,
    operationId: `${resource.name}_${operation}`,
    // Only add security requirement if route requires auth
    ...(requiresAuth && {
      security: [{ bearerAuth: [] }],
    }),
    responses: {
      ...(requiresAuth && {
        '401': { description: 'Unauthorized' },
        '403': { description: 'Forbidden' },
      }),
      '500': { description: 'Internal server error' },
    },
    ...extras,
  };
}

/**
 * Extract path parameters from route path
 */
function extractPathParams(path: string): Parameter[] {
  const params: Parameter[] = [];
  const matches = path.matchAll(/:([^/]+)/g);

  for (const match of matches) {
    const paramName = match[1];
    if (paramName) {
      params.push({
        name: paramName,
        in: 'path',
        required: true,
        schema: { type: 'string' },
      });
    }
  }

  return params;
}

/**
 * Generate schema definitions from pre-stored registry schemas.
 * Schemas are generated at resource definition time and stored in the registry.
 *
 * Response schema priority:
 * 1. If resource provides explicit `openApiSchemas.response`, use it as-is
 * 2. Otherwise, auto-generate from `createBody` + _id + timestamps
 *
 * Note: This is for OpenAPI documentation only - does NOT affect Fastify serialization.
 */
function generateSchemas(resources: RegistryEntry[]): Record<string, SchemaObject> {
  const schemas: Record<string, SchemaObject> = {
    // Common schemas
    Pagination: {
      type: 'object',
      properties: {
        page: { type: 'integer' },
        limit: { type: 'integer' },
        total: { type: 'integer' },
        totalPages: { type: 'integer' },
        hasNextPage: { type: 'boolean' },
        hasPrevPage: { type: 'boolean' },
      },
    },
    Error: {
      type: 'object',
      properties: {
        success: { type: 'boolean', example: false },
        error: { type: 'string' },
        code: { type: 'string' },
        requestId: { type: 'string' },
        timestamp: { type: 'string' },
      },
    },
  };

  for (const resource of resources) {
    const storedSchemas = resource.openApiSchemas;

    // === RESPONSE SCHEMA (for GET responses) ===
    // Priority 1: Explicit response schema provided by user
    if (storedSchemas?.response) {
      schemas[resource.name] = {
        type: 'object',
        description: resource.displayName,
        ...(storedSchemas.response as SchemaObject),
      };
    }
    // Priority 2: Auto-generate from createBody
    else if (storedSchemas?.createBody) {
      schemas[resource.name] = {
        type: 'object',
        description: resource.displayName,
        properties: {
          _id: { type: 'string', description: 'Unique identifier' },
          ...((storedSchemas.createBody as SchemaObject).properties ?? {}),
          createdAt: { type: 'string', format: 'date-time', description: 'Creation timestamp' },
          updatedAt: { type: 'string', format: 'date-time', description: 'Last update timestamp' },
        },
      };
    }
    // Fallback: Placeholder schema
    else {
      schemas[resource.name] = {
        type: 'object',
        description: resource.displayName,
        properties: {
          _id: { type: 'string', description: 'Unique identifier' },
          createdAt: { type: 'string', format: 'date-time', description: 'Creation timestamp' },
          updatedAt: { type: 'string', format: 'date-time', description: 'Last update timestamp' },
        },
      };
    }

    // === INPUT SCHEMAS (for POST/PATCH requests) ===
    if (storedSchemas?.createBody) {
      schemas[`${resource.name}Input`] = {
        type: 'object',
        description: `${resource.displayName} create input`,
        ...(storedSchemas.createBody as SchemaObject),
      };

      if (storedSchemas.updateBody) {
        schemas[`${resource.name}Update`] = {
          type: 'object',
          description: `${resource.displayName} update input`,
          ...(storedSchemas.updateBody as SchemaObject),
        };
      }
    } else {
      schemas[`${resource.name}Input`] = {
        type: 'object',
        description: `${resource.displayName} input`,
      };
    }
  }

  return schemas;
}

export default fp(openApiPlugin, {
  name: 'arc-openapi',
  fastify: '5.x',
});

export { openApiPlugin };
