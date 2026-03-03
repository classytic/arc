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
import type { RegistryEntry, FastifyWithDecorators } from '../types/index.js';
import type { PermissionCheck } from '../permissions/types.js';
import { getUserRoles } from '../permissions/types.js';
import type { ExternalOpenApiPaths } from './externalPaths.js';
import { convertRouteSchema } from '../utils/schemaConverter.js';

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

export interface OpenApiBuildOptions {
  title?: string;
  version?: string;
  description?: string;
  serverUrl?: string;
  apiPrefix?: string;
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
  /** Arc permission metadata (OpenAPI extension) */
  'x-arc-permission'?: { type: string; roles?: readonly string[] };
  /** Arc pipeline steps (OpenAPI extension) */
  'x-arc-pipeline'?: Array<{ type: string; name: string }>;
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

  // Build spec from instance-scoped registry
  const buildSpec = (): OpenApiSpec => {
    const arc = (fastify as unknown as FastifyWithDecorators).arc;
    const resources = arc?.registry?.getAll() ?? [];
    const externalPaths = arc?.externalOpenApiPaths ?? [];
    return buildOpenApiSpec(resources, {
      title,
      version,
      description,
      serverUrl,
      apiPrefix,
    }, externalPaths.length > 0 ? externalPaths : undefined);
  };

  // Serve OpenAPI spec
  fastify.get(`${prefix}/openapi.json`, async (request, reply) => {
    // Check auth if required
    if (authRoles.length > 0) {
      const user = (request as { user?: Record<string, unknown> }).user;
      const roles = getUserRoles(user);
      if (!authRoles.some((r) => roles.includes(r)) && !roles.includes('superadmin')) {
        reply.code(403).send({ error: 'Access denied' });
        return;
      }
    }

    const spec = buildSpec();
    // Return object directly - let Fastify handle serialization & compression
    return spec;
  });

  fastify.log?.debug?.(`OpenAPI spec available at ${prefix}/openapi.json`);
};

/**
 * Build OpenAPI spec from registry resources.
 * Shared by HTTP docs endpoint and CLI export command.
 */
export function buildOpenApiSpec(
  resources: RegistryEntry[],
  options: OpenApiBuildOptions = {},
  externalPaths?: ExternalOpenApiPaths[],
): OpenApiSpec {
  const {
    title = 'Arc API',
    version = '1.0.0',
    description,
    serverUrl,
    apiPrefix = '',
  } = options;

  const paths: Record<string, PathItem> = {};
  const tags: Array<{ name: string; description?: string }> = [];

  // Collect additional security alternatives from external integrations.
  // Each item is OR'd with bearerAuth on authenticated resource operations.
  const additionalSecurity = externalPaths
    ?.flatMap(ext => ext.resourceSecurity ?? []) ?? [];

  for (const resource of resources) {
    // Build tag description with preset/pipeline info
    const tagDescParts = [`${resource.displayName || resource.name} operations`];
    if (resource.presets && resource.presets.length > 0) {
      tagDescParts.push(`Presets: ${resource.presets.join(', ')}`);
    }
    if (resource.pipelineSteps && resource.pipelineSteps.length > 0) {
      const stepNames = resource.pipelineSteps.map((s) => `${s.type}(${s.name})`);
      tagDescParts.push(`Pipeline: ${stepNames.join(' → ')}`);
    }
    if (resource.events && resource.events.length > 0) {
      tagDescParts.push(`Events: ${resource.events.join(', ')}`);
    }

    tags.push({
      name: resource.tag || resource.name,
      description: tagDescParts.join('. '),
    });

    const resourcePaths = generateResourcePaths(resource, apiPrefix, additionalSecurity);
    Object.assign(paths, resourcePaths);
  }

  // Merge external paths (Better Auth, custom integrations, etc.)
  if (externalPaths) {
    for (const ext of externalPaths) {
      for (const [path, methods] of Object.entries(ext.paths)) {
        paths[path] = paths[path]
          ? { ...paths[path], ...methods } as PathItem
          : methods as PathItem;
      }
      if (ext.tags) {
        for (const tag of ext.tags) {
          if (!tags.find((t) => t.name === tag.name)) {
            tags.push(tag);
          }
        }
      }
    }
  }

  // Merge external security schemes and schemas
  const externalSecuritySchemes = externalPaths
    ?.reduce<Record<string, Record<string, unknown>>>((acc, ext) => ({ ...acc, ...ext.securitySchemes }), {}) ?? {};
  const externalSchemas = externalPaths
    ?.reduce<Record<string, Record<string, unknown>>>((acc, ext) => ({ ...acc, ...ext.schemas }), {}) ?? {};

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
      schemas: {
        ...generateSchemas(resources),
        ...externalSchemas,
      } as Record<string, SchemaObject>,
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
        // Plugin-specific schemes (e.g. apiKeyAuth) are auto-detected
        // and injected via externalSecuritySchemes from the auth extractor.
        ...externalSecuritySchemes,
      } as Record<string, SecurityScheme>,
    },
    tags,
  };
}

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
function generateResourcePaths(
  resource: RegistryEntry,
  apiPrefix = '',
  additionalSecurity: Array<Record<string, string[]>> = [],
): Record<string, PathItem> {
  const paths: Record<string, PathItem> = {};
  const basePath = `${apiPrefix}${resource.prefix}`;

  // Skip if default routes are disabled and no additional routes
  if (resource.disableDefaultRoutes && (!resource.additionalRoutes || resource.additionalRoutes.length === 0)) {
    return paths;
  }

  // Default CRUD routes (respects disabledRoutes + updateMethod)
  if (!resource.disableDefaultRoutes) {
    const disabledSet = new Set(resource.disabledRoutes ?? []);
    const updateMethod = resource.updateMethod ?? 'PATCH';

    // Collection routes: GET / (list) + POST / (create)
    const collectionPath: PathItem = {};

    if (!disabledSet.has('list')) {
      const listParams = resource.openApiSchemas?.listQuery
        ? convertSchemaToParameters(resource.openApiSchemas.listQuery as Record<string, unknown>)
        : DEFAULT_LIST_PARAMS;

      collectionPath.get = createOperation(resource, 'list', 'List all', {
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
                    docs: { type: 'array', items: { $ref: `#/components/schemas/${resource.name}` } },
                    page: { type: 'integer' },
                    limit: { type: 'integer' },
                    total: { type: 'integer' },
                    pages: { type: 'integer' },
                    hasNext: { type: 'boolean' },
                    hasPrev: { type: 'boolean' },
                  },
                },
              },
            },
          },
        },
      }, undefined, additionalSecurity);
    }

    if (!disabledSet.has('create')) {
      collectionPath.post = createOperation(resource, 'create', 'Create new', {
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
      }, undefined, additionalSecurity);
    }

    if (Object.keys(collectionPath).length > 0) {
      paths[basePath] = collectionPath;
    }

    // Item routes: GET /:id + UPDATE /:id + DELETE /:id
    const itemPath: PathItem = {};

    if (!disabledSet.has('get')) {
      itemPath.get = createOperation(resource, 'get', 'Get by ID', {
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
      }, undefined, additionalSecurity);
    }

    if (!disabledSet.has('update')) {
      const updateOp = createOperation(resource, 'update', 'Update', {
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
      }, undefined, additionalSecurity);

      if (updateMethod === 'both') {
        itemPath.put = updateOp;
        itemPath.patch = updateOp;
      } else if (updateMethod === 'PUT') {
        itemPath.put = updateOp;
      } else {
        itemPath.patch = updateOp;
      }
    }

    if (!disabledSet.has('delete')) {
      itemPath.delete = createOperation(resource, 'delete', 'Delete', {
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
      }, undefined, additionalSecurity);
    }

    if (Object.keys(itemPath).length > 0) {
      paths[toOpenApiPath(`${basePath}/:id`)] = itemPath;
    }
  }

  // Additional routes from presets
  for (const route of resource.additionalRoutes || []) {
    const fullPath = toOpenApiPath(`${basePath}${route.path}`);
    const method = route.method.toLowerCase() as keyof PathItem;

    if (!paths[fullPath]) {
      paths[fullPath] = {};
    }

    // Check if route requires auth (not public)
    const handlerName = route.operation ?? (typeof route.handler === 'string' ? route.handler : 'handler');
    const isPublicRoute = (route.permissions as PermissionCheck)?._isPublic === true;
    const requiresAuthForRoute = !!route.permissions && !isPublicRoute;

    // Build extras from route schema
    const extras: Partial<Operation> = {
      parameters: extractPathParams(route.path),
      responses: {
        '200': { description: route.description || 'Success' },
      },
    };

    // Add request body from route.schema.body (for POST, PUT, PATCH)
    // Auto-convert Zod schemas to JSON Schema (no-op for plain JSON Schema)
    const rawSchema = route.schema as Record<string, unknown> | undefined;
    const routeSchema = rawSchema ? convertRouteSchema(rawSchema) : undefined;
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
      requiresAuthForRoute,
      additionalSecurity,
    );
  }

  return paths;
}

/**
 * Create an operation object
 * @param requiresAuthOverride - Override for whether auth is required (for additional routes)
 * @param additionalSecurity - Extra security alternatives from external integrations (OR'd with bearerAuth)
 */
function createOperation(
  resource: RegistryEntry,
  operation: string,
  summary: string,
  extras: Partial<Operation>,
  requiresAuthOverride?: boolean,
  additionalSecurity: Array<Record<string, string[]>> = [],
): Operation {
  const permissions = resource.permissions || {};
  // Check if permission check is defined for this operation
  const operationPermission = (permissions as Record<string, unknown>)[operation];
  // Check if it's marked as public (allowPublic())
  const isPublic = (operationPermission as PermissionCheck)?._isPublic === true;
  // Check for role requirements
  const requiredRoles = (operationPermission as PermissionCheck)?._roles;
  // If override is provided, use it; otherwise check if operation has a permission check that isn't public
  const requiresAuth = requiresAuthOverride !== undefined
    ? requiresAuthOverride
    : typeof operationPermission === 'function' && !isPublic;

  // Build permission annotation
  const permAnnotation = describePermissionForOpenApi(operationPermission);

  // Build description with permission + preset info
  const descParts: string[] = [];
  if (permAnnotation) {
    descParts.push(`**Permission**: ${permAnnotation.type === 'public' ? 'Public' : permAnnotation.type === 'requireRoles' ? `Requires roles: ${(permAnnotation.roles ?? []).join(', ')}` : 'Requires authentication'}`);
  }
  if (resource.presets && resource.presets.length > 0) {
    descParts.push(`**Presets**: ${resource.presets.join(', ')}`);
  }
  // Find pipeline steps that apply to this operation
  const applicableSteps = (resource.pipelineSteps ?? []).filter((s) => {
    if (!s.operations) return true; // applies to all
    return s.operations.includes(operation);
  });

  const op: Operation = {
    tags: [resource.tag || 'Resource'],
    summary: `${summary} ${(resource.displayName || resource.name).toLowerCase()}`,
    operationId: `${resource.name}_${operation}`,
    ...(descParts.length > 0 && { description: descParts.join('\n\n') }),
    // Only add security requirement if route requires auth
    ...(requiresAuth && {
      security: [{ bearerAuth: [] }, ...additionalSecurity],
    }),
    // Permission metadata extension
    ...(permAnnotation && { 'x-arc-permission': permAnnotation }),
    // Pipeline extension
    ...(applicableSteps.length > 0 && {
      'x-arc-pipeline': applicableSteps.map((s) => ({ type: s.type, name: s.name })),
    }),
    responses: {
      ...(requiresAuth && {
        '401': {
          description: 'Authentication required — no valid Bearer token provided',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/Error' },
            },
          },
        },
        '403': {
          description: permAnnotation?.roles
            ? `Forbidden — requires one of: ${(permAnnotation.roles as string[]).join(', ')}`
            : 'Forbidden — insufficient permissions',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/Error' },
            },
          },
        },
      }),
      '500': { description: 'Internal server error' },
    },
    ...extras,
  };

  return op;
}

/**
 * Describe a permission check function for OpenAPI.
 * Extracts role, org role, and team permission metadata from permission functions.
 */
function describePermissionForOpenApi(
  check: unknown,
): { type: string; roles?: readonly string[]; orgRoles?: readonly string[] } | undefined {
  if (!check || typeof check !== 'function') return undefined;

  const fn = check as PermissionCheck & {
    _orgRoles?: readonly string[];
    _orgPermission?: string;
    _teamPermission?: string;
  };

  if (fn._isPublic === true) return { type: 'public' };

  const result: { type: string; roles?: readonly string[]; orgRoles?: readonly string[] } = {
    type: 'requireAuth',
  };

  if (Array.isArray(fn._roles) && fn._roles.length > 0) {
    result.type = 'requireRoles';
    result.roles = fn._roles as string[];
  }
  if (Array.isArray(fn._orgRoles) && fn._orgRoles.length > 0) {
    result.orgRoles = fn._orgRoles;
  }

  return result;
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
    // Common schemas (pagination fields are inlined in list responses)
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
    const fieldPerms = resource.fieldPermissions;

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

    // Annotate fields with permission info
    if (fieldPerms && schemas[resource.name]?.properties) {
      const props = schemas[resource.name]!.properties!;
      for (const [field, perm] of Object.entries(fieldPerms)) {
        if (props[field]) {
          // Add permission description to existing field
          const desc = props[field]!.description ?? '';
          const permDesc = formatFieldPermDescription(perm);
          props[field]!.description = desc ? `${desc} (${permDesc})` : permDesc;
        } else if (perm.type === 'hidden') {
          // Hidden fields won't appear in schema — note in schema description
        }
      }
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

/**
 * Format a field permission description for OpenAPI
 */
function formatFieldPermDescription(
  perm: { type: string; roles?: readonly string[]; redactValue?: unknown },
): string {
  switch (perm.type) {
    case 'hidden':
      return 'Hidden — never returned in responses';
    case 'visibleTo':
      return `Visible to: ${(perm.roles ?? []).join(', ')}`;
    case 'writableBy':
      return `Writable by: ${(perm.roles ?? []).join(', ')}`;
    case 'redactFor':
      return `Redacted for: ${(perm.roles ?? []).join(', ')}`;
    default:
      return perm.type;
  }
}

export default fp(openApiPlugin, {
  name: 'arc-openapi',
  fastify: '5.x',
});

export { openApiPlugin };
