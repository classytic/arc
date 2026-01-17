/**
 * CRUD Router Factory
 *
 * Creates standard REST routes with permission-based access control.
 * Full TypeScript support with proper Fastify types.
 *
 * Features:
 * - Permission-based access control via PermissionCheck functions
 * - Organization scoping for multi-tenant routes
 * - Consistent route patterns
 * - Framework-agnostic controllers via adapter pattern
 */

import type { FastifyInstance, FastifyRequest, FastifyReply, RouteHandlerMethod } from 'fastify';
import type {
  AdditionalRoute,
  CrudController,
  CrudRouterOptions,
  FastifyWithDecorators,
  IController,
  RequestWithExtras,
} from '../types/index.js';
import type { PermissionCheck, PermissionContext, PermissionResult } from '../permissions/types.js';
import { createCrudHandlers, createFastifyHandler } from './fastifyAdapter.js';

/**
 * Build permission middleware from PermissionCheck function
 *
 * Creates a Fastify preHandler that:
 * 1. Executes the permission check
 * 2. Returns 401 if authentication required but user absent
 * 3. Returns 403 if permission denied
 * 4. Applies query filters from PermissionResult if present
 */
function buildPermissionMiddleware(
  permissionCheck: PermissionCheck | undefined,
  resourceName: string,
  action: string
): RouteHandlerMethod | null {
  // No permission check = public route
  if (!permissionCheck) return null;

  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const reqWithExtras = request as RequestWithExtras;

    // Build permission context
    const context: PermissionContext = {
      user: reqWithExtras.user as any ?? null,
      request,
      resource: resourceName,
      action,
      resourceId: (request.params as Record<string, string>)?.id,
      organizationId: reqWithExtras.organizationId,
      data: request.body as Record<string, unknown> | undefined,
    };

    // Execute permission check
    const result = await permissionCheck(context);

    // Handle boolean result
    if (typeof result === 'boolean') {
      if (!result) {
        reply.code(context.user ? 403 : 401).send({
          success: false,
          error: context.user ? 'Permission denied' : 'Authentication required',
        });
        return;
      }
      return;
    }

    // Handle PermissionResult
    const permResult = result as PermissionResult;
    if (!permResult.granted) {
      reply.code(context.user ? 403 : 401).send({
        success: false,
        error: permResult.reason ?? (context.user ? 'Permission denied' : 'Authentication required'),
      });
      return;
    }

    // Apply filters from permission result (for ownership patterns)
    if (permResult.filters) {
      reqWithExtras._policyFilters = {
        ...(reqWithExtras._policyFilters ?? {}),
        ...permResult.filters,
      };
    }
  };
}

/**
 * Build org scoping middleware
 */
function buildOrgScopedMiddleware(
  fastify: FastifyWithDecorators,
  orgScoped: boolean | undefined,
  globalOrgScoped: boolean
): RouteHandlerMethod[] {
  // Respect route-level override, fall back to global default
  const shouldApplyOrgScoped = orgScoped ?? globalOrgScoped;

  if (!shouldApplyOrgScoped) return [];

  // Fail loudly if org scoping requested but decorator missing
  if (!fastify.organizationScoped) {
    throw new Error(
      'Organization scoping is enabled but fastify.organizationScoped decorator is not registered.\n' +
      'Register the org scope plugin before mounting resources:\n' +
      'await app.register(orgScopePlugin);\n' +
      'Docs: https://github.com/classytic/arc#multi-tenant'
    );
  }

  return [fastify.organizationScoped() as RouteHandlerMethod];
}

/**
 * Create additional routes from preset/custom definitions
 */
function createAdditionalRoutes<TDoc = unknown>(
  fastify: FastifyWithDecorators,
  routes: AdditionalRoute[],
  controller: CrudController<TDoc> | undefined,
  options: {
    tag: string;
    resourceName: string;
    orgMw: (orgScoped?: boolean) => RouteHandlerMethod[];
    arcDecorator: RouteHandlerMethod;
  }
): void {
  const { tag, resourceName, orgMw, arcDecorator } = options;

  for (const route of routes) {
    // Resolve handler - wrapHandler is REQUIRED (no auto-detection)
    let handler: RouteHandlerMethod;

    if (typeof route.handler === 'string') {
      // String handlers require a controller
      if (!controller) {
        throw new Error(
          `Route ${route.method} ${route.path}: string handler '${route.handler}' requires a controller. ` +
          'Either provide a controller or use a function handler instead.'
        );
      }
      const ctrl = controller as unknown as Record<string, unknown>;
      const method = ctrl[route.handler];
      if (typeof method !== 'function') {
        throw new Error(`Handler '${route.handler}' not found on controller`);
      }
      // Bind method to controller
      const boundMethod = (method as Function).bind(controller);

      // Explicit wrapHandler - no auto-detection
      handler = route.wrapHandler
        ? createFastifyHandler(boundMethod as any)
        : (boundMethod as RouteHandlerMethod);
    } else {
      // Function handler - use explicit wrapHandler
      handler = route.wrapHandler
        ? createFastifyHandler(route.handler as any)
        : (route.handler as RouteHandlerMethod);
    }

    // Build schema with tags
    const routeTags = route.tags ?? (tag ? [tag] : undefined);
    const schema = {
      ...(routeTags ? { tags: routeTags } : {}),
      ...(route.summary ? { summary: route.summary } : {}),
      ...(route.description ? { description: route.description } : {}),
      ...(route.schema ?? {}),
    } as Record<string, unknown>;

    // Build preHandler chain: arc decorator → permission check → org scope → custom middlewares
    const permissionMw = buildPermissionMiddleware(route.permissions, resourceName, route.method.toLowerCase());
    const preHandler = [
      arcDecorator,
      permissionMw,
      ...orgMw(),
      ...((route.preHandler ?? []) as RouteHandlerMethod[]),
    ].filter(Boolean) as RouteHandlerMethod[];

    fastify.route({
      method: route.method,
      url: route.path,
      schema: schema as any, // Fastify schema is flexible - allow any valid JSON schema
      preHandler: preHandler.length > 0 ? preHandler : undefined,
      handler,
    });
  }
}

/**
 * Create CRUD routes for a controller
 *
 * @param fastify - Fastify instance with Arc decorators
 * @param controller - CRUD controller with handler methods
 * @param options - Router configuration
 */
export function createCrudRouter<TDoc = unknown>(
  fastify: FastifyWithDecorators,
  controller: CrudController<TDoc> | undefined,
  options: CrudRouterOptions = {}
): void {
  const {
    tag = 'Resource',
    schemas = {},
    permissions = {},
    middlewares = {},
    additionalRoutes = [],
    disableDefaultRoutes = false,
    disabledRoutes = [],
    organizationScoped = false,
    resourceName = 'unknown',
    schemaOptions,
  } = options;

  // Build org scope middleware helper
  const orgMw = (orgScoped?: boolean): RouteHandlerMethod[] => {
    return buildOrgScopedMiddleware(fastify, orgScoped, organizationScoped);
  };

  // Arc metadata decorator - sets req.arc with resource configuration
  const arcDecorator: RouteHandlerMethod = async (req, _reply) => {
    (req as unknown as { arc?: unknown }).arc = {
      resourceName,
      schemaOptions,
      permissions,
    };
  };

  // Get middleware for each operation
  const mw = {
    list: (middlewares.list ?? []) as RouteHandlerMethod[],
    get: (middlewares.get ?? []) as RouteHandlerMethod[],
    create: (middlewares.create ?? []) as RouteHandlerMethod[],
    update: (middlewares.update ?? []) as RouteHandlerMethod[],
    delete: (middlewares.delete ?? []) as RouteHandlerMethod[],
  };

  // ID params schema
  const idParamsSchema = {
    type: 'object' as const,
    properties: { id: { type: 'string' as const } },
    required: ['id' as const],
  };

  // Only validate and create handlers when default routes are enabled
  let handlers: ReturnType<typeof createCrudHandlers> | undefined;

  if (!disableDefaultRoutes) {
    // Controller is required for default CRUD routes
    if (!controller) {
      throw new Error(
        'Controller is required when disableDefaultRoutes is not true. ' +
        'Provide a controller or use defineResource which auto-creates BaseController.'
      );
    }

    // Create adapted handlers for IController
    handlers = createCrudHandlers(controller as IController<TDoc>);
  }

  // Standard CRUD routes
  if (!disableDefaultRoutes && handlers) {
    // GET / - List all
    if (!disabledRoutes.includes('list')) {
      const permMw = buildPermissionMiddleware(permissions.list, resourceName, 'list');
      const listPreHandler = [arcDecorator, permMw, ...orgMw(), ...mw.list].filter(Boolean) as RouteHandlerMethod[];
      fastify.route({
        method: 'GET',
        url: '/',
        schema: {
          tags: [tag],
          summary: `List ${tag}`,
          ...(schemas.list ?? {}),
        } as any,
        preHandler: listPreHandler.length > 0 ? listPreHandler : undefined,
        handler: handlers.list,
      });
    }

    // GET /:id - Get by ID
    if (!disabledRoutes.includes('get')) {
      const permMw = buildPermissionMiddleware(permissions.get, resourceName, 'get');
      const getPreHandler = [arcDecorator, permMw, ...orgMw(), ...mw.get].filter(Boolean) as RouteHandlerMethod[];
      fastify.route({
        method: 'GET',
        url: '/:id',
        schema: {
          tags: [tag],
          summary: `Get ${tag} by ID`,
          params: idParamsSchema,
          ...(schemas.get ?? {}),
        } as any,
        preHandler: getPreHandler.length > 0 ? getPreHandler : undefined,
        handler: handlers.get,
      });
    }

    // POST / - Create
    if (!disabledRoutes.includes('create')) {
      const permMw = buildPermissionMiddleware(permissions.create, resourceName, 'create');
      const createPreHandler = [arcDecorator, permMw, ...orgMw(), ...mw.create].filter(Boolean) as RouteHandlerMethod[];
      fastify.route({
        method: 'POST',
        url: '/',
        schema: {
          tags: [tag],
          summary: `Create ${tag}`,
          ...(schemas.create ?? {}),
        } as any,
        preHandler: createPreHandler.length > 0 ? createPreHandler : undefined,
        handler: handlers.create,
      });
    }

    // PATCH /:id - Update
    if (!disabledRoutes.includes('update')) {
      const permMw = buildPermissionMiddleware(permissions.update, resourceName, 'update');
      const updatePreHandler = [arcDecorator, permMw, ...orgMw(), ...mw.update].filter(Boolean) as RouteHandlerMethod[];
      fastify.route({
        method: 'PATCH',
        url: '/:id',
        schema: {
          tags: [tag],
          summary: `Update ${tag}`,
          params: idParamsSchema,
          ...(schemas.update ?? {}),
        } as any,
        preHandler: updatePreHandler.length > 0 ? updatePreHandler : undefined,
        handler: handlers.update,
      });
    }

    // DELETE /:id - Delete
    if (!disabledRoutes.includes('delete')) {
      const permMw = buildPermissionMiddleware(permissions.delete, resourceName, 'delete');
      const deletePreHandler = [arcDecorator, permMw, ...orgMw(), ...mw.delete].filter(Boolean) as RouteHandlerMethod[];
      fastify.route({
        method: 'DELETE',
        url: '/:id',
        schema: {
          tags: [tag],
          summary: `Delete ${tag}`,
          params: idParamsSchema,
          ...(schemas.delete ?? {}),
        } as any,
        preHandler: deletePreHandler.length > 0 ? deletePreHandler : undefined,
        handler: handlers.delete,
      });
    }
  }

  // Additional routes from presets and custom
  if (additionalRoutes.length > 0) {
    createAdditionalRoutes(fastify, additionalRoutes, controller, { tag, resourceName, orgMw, arcDecorator });
  }
}

/**
 * Helper to create org scoped middleware
 */
export function createOrgScopedMiddleware(
  instance: FastifyWithDecorators
): RouteHandlerMethod[] {
  return instance.organizationScoped ? [instance.organizationScoped() as RouteHandlerMethod] : [];
}

/**
 * Create permission middleware from PermissionCheck
 * Useful for custom route registration
 */
export function createPermissionMiddleware(
  permission: PermissionCheck,
  resourceName: string,
  action: string
): RouteHandlerMethod | null {
  return buildPermissionMiddleware(permission, resourceName, action);
}

export default createCrudRouter;
