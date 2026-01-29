/**
 * Action Router Factory (Stripe Pattern)
 *
 * Consolidates multiple state-transition endpoints into a single unified action endpoint.
 * Instead of separate endpoints for each action (approve, dispatch, receive, cancel),
 * this creates one endpoint: POST /:id/action
 *
 * Benefits:
 * - 40% fewer endpoints
 * - Consistent permission checking
 * - Self-documenting via action enum
 * - Type-safe action validation
 * - Single audit point for all state transitions
 *
 * @example
 * import { createActionRouter } from '@classytic/arc';
 * import { requireRoles } from '@classytic/arc/permissions';
 *
 * createActionRouter(fastify, {
 *   tag: 'Inventory - Transfers',
 *   actions: {
 *     approve: async (id, data, req) => transferService.approve(id, req.user),
 *     dispatch: async (id, data, req) => transferService.dispatch(id, data.transport, req.user),
 *     receive: async (id, data, req) => transferService.receive(id, data, req.user),
 *     cancel: async (id, data, req) => transferService.cancel(id, data.reason, req.user),
 *   },
 *   actionPermissions: {
 *     approve: requireRoles(['admin', 'warehouse-manager']),
 *     dispatch: requireRoles(['admin', 'warehouse-staff']),
 *     receive: requireRoles(['admin', 'store-manager']),
 *     cancel: requireRoles(['admin']),
 *   },
 *   actionSchemas: {
 *     dispatch: {
 *       transport: { type: 'object', properties: { driver: { type: 'string' } } }
 *     },
 *     cancel: {
 *       reason: { type: 'string', minLength: 10 }
 *     },
 *   }
 * });
 */

import type { FastifyInstance, FastifyRequest, FastifyReply, RouteOptions } from 'fastify';
import type { RequestWithExtras, PermissionCheck, PermissionContext, PermissionResult } from '../types/index.js';

/**
 * Action handler function
 * @param id - Resource ID
 * @param data - Action-specific data from request body
 * @param req - Full Fastify request object
 * @returns Action result (will be wrapped in success response)
 */
export type ActionHandler<TData = any, TResult = any> = (
  id: string,
  data: TData,
  req: RequestWithExtras
) => Promise<TResult>;

/**
 * Action router configuration
 */
export interface ActionRouterConfig {
  /**
   * OpenAPI tag for grouping routes
   */
  tag?: string;

  /**
   * Action handlers map
   * @example { approve: (id, data, req) => service.approve(id), ... }
   */
  actions: Record<string, ActionHandler>;

  /**
   * Per-action permission checks (PermissionCheck functions)
   * @example { approve: requireRoles(['admin', 'manager']), cancel: requireRoles(['admin']) }
   */
  actionPermissions?: Record<string, PermissionCheck>;

  /**
   * Per-action JSON schema for body validation
   * @example { dispatch: { transport: { type: 'object' } } }
   */
  actionSchemas?: Record<string, Record<string, any>>;

  /**
   * Global permission check applied to all actions (if action-specific not defined)
   */
  globalAuth?: PermissionCheck;

  /**
   * Optional idempotency service
   * If provided, will handle idempotency-key header
   */
  idempotencyService?: IdempotencyService;

  /**
   * Custom error handler for action execution failures
   * @param error - The error thrown by action handler
   * @param action - The action that failed
   * @param id - The resource ID
   * @returns Status code and error response
   */
  onError?: (
    error: Error,
    action: string,
    id: string
  ) => { statusCode: number; error: string; code?: string };
}

/**
 * Idempotency service interface
 * Apps can provide their own implementation
 */
export interface IdempotencyService {
  check(key: string, payload: any): Promise<{ isNew: boolean; existingResult?: any }>;
  complete(key: string | undefined, result: any): Promise<void>;
  fail(key: string | undefined, error: Error): Promise<void>;
}

/**
 * Create action-based state transition endpoint
 *
 * Registers: POST /:id/action
 * Body: { action: string, ...actionData }
 *
 * @param fastify - Fastify instance
 * @param config - Action router configuration
 */
export function createActionRouter(fastify: FastifyInstance, config: ActionRouterConfig): void {
  const {
    tag,
    actions,
    actionPermissions = {},
    actionSchemas = {},
    globalAuth,
    idempotencyService,
    onError,
  } = config;

  const actionEnum = Object.keys(actions);

  if (actionEnum.length === 0) {
    fastify.log.warn('[createActionRouter] No actions defined, skipping route creation');
    return;
  }

  // Build unified body schema with action-specific properties
  const bodyProperties: Record<string, any> = {
    action: {
      type: 'string',
      enum: actionEnum,
      description: `Action to perform: ${actionEnum.join(' | ')}`,
    },
  };

  // Add action-specific schema properties
  Object.entries(actionSchemas).forEach(([actionName, schema]) => {
    if (schema && typeof schema === 'object') {
      Object.entries(schema).forEach(([propName, propSchema]) => {
        bodyProperties[propName] = {
          ...propSchema,
          description: `${propSchema.description || ''} (for ${actionName} action)`.trim(),
        };
      });
    }
  });

  const routeSchema = {
    tags: tag ? [tag] : undefined,
    summary: `Perform action (${actionEnum.join('/')})`,
    description: buildActionDescription(actions, actionPermissions),
    params: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Resource ID' },
      },
      required: ['id'],
    },
    body: {
      type: 'object',
      properties: bodyProperties,
      required: ['action'],
    },
    response: {
      200: {
        type: 'object',
        properties: {
          success: { type: 'boolean' },
          data: { type: 'object' },
        },
      },
      400: {
        type: 'object',
        properties: {
          success: { type: 'boolean' },
          error: { type: 'string' },
        },
      },
      403: {
        type: 'object',
        properties: {
          success: { type: 'boolean' },
          error: { type: 'string' },
        },
      },
    },
  };

  // Build preHandlers
  const preHandler = [];

  // Add authentication if any action permission requires it (not public)
  const allPermissions = Object.values(actionPermissions);
  const needsAuth = allPermissions.some(
    (p) => !(p as PermissionCheck & { _isPublic?: boolean })?._isPublic
  ) || (globalAuth && !(globalAuth as PermissionCheck & { _isPublic?: boolean })?._isPublic);

  if (needsAuth && (fastify as any).authenticate) {
    preHandler.push((fastify as any).authenticate);
  }

  // Register the unified action endpoint
  fastify.post(
    '/:id/action',
    {
      schema: routeSchema,
      preHandler: preHandler.length ? preHandler : undefined,
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { action, ...data } = req.body as { action: string; [key: string]: any };
      const { id } = req.params as { id: string };
      const rawIdempotencyKey = req.headers['idempotency-key'];
      const idempotencyKey = Array.isArray(rawIdempotencyKey)
        ? rawIdempotencyKey[0]
        : rawIdempotencyKey;

      // Validate action exists
      const handler = actions[action];
      if (!handler) {
        return reply.code(400).send({
          success: false,
          error: `Invalid action '${action}'. Valid actions: ${actionEnum.join(', ')}`,
          validActions: actionEnum,
        });
      }

      // Check permissions: action-specific first, then fallback to globalAuth
      const permissionCheck = actionPermissions[action] ?? globalAuth;

      if (permissionCheck) {
        const reqWithExtras = req as RequestWithExtras;
        const context: PermissionContext = {
          user: (reqWithExtras.user as any) ?? null,
          request: req,
          resource: tag ?? 'action',
          action,
          resourceId: id,
          data,
        };

        const result = await permissionCheck(context);

        if (typeof result === 'boolean') {
          if (!result) {
            return reply.code(context.user ? 403 : 401).send({
              success: false,
              error: context.user ? `Permission denied for '${action}'` : 'Authentication required',
            });
          }
        } else {
          const permResult = result as PermissionResult;
          if (!permResult.granted) {
            return reply.code(context.user ? 403 : 401).send({
              success: false,
              error: permResult.reason ?? (context.user ? `Permission denied for '${action}'` : 'Authentication required'),
            });
          }
        }
      }

      try {
        // Idempotency check (optional)
        if (idempotencyKey && idempotencyService) {
          const user = (req as RequestWithExtras).user as any;
          const payloadForHash = {
            action,
            id,
            data,
            userId: user?._id?.toString?.() || user?.id || null,
          };

          const { isNew, existingResult } = await idempotencyService.check(
            idempotencyKey,
            payloadForHash
          );
          if (!isNew && existingResult) {
            return reply.send({
              success: true,
              data: existingResult,
              cached: true,
            });
          }
        }

        // Execute the action handler
        const result = await handler(id, data, req as RequestWithExtras);

        if (idempotencyService) {
          await idempotencyService.complete(idempotencyKey, result);
        }

        return reply.send({
          success: true,
          data: result,
        });
      } catch (error) {
        if (idempotencyService) {
          await idempotencyService.fail(idempotencyKey, error as Error);
        }

        // Use custom error handler if provided
        if (onError) {
          const { statusCode, error: errorMsg, code } = onError(error as Error, action, id);
          return reply.code(statusCode).send({
            success: false,
            error: errorMsg,
            code,
          });
        }

        // Default error handling
        const err = error as any;
        const statusCode = err.statusCode || err.status || 500;
        const errorCode = err.code || 'ACTION_FAILED';

        if (statusCode >= 500) {
          req.log.error({ err: error, action, id }, 'Action handler error');
        }

        return reply.code(statusCode).send({
          success: false,
          error: err.message || `Failed to execute '${action}' action`,
          code: errorCode,
        });
      }
    }
  );

  fastify.log.info(
    { actions: actionEnum, tag },
    '[createActionRouter] Registered action endpoint: POST /:id/action'
  );
}

/**
 * Build description with action details
 * Uses _roles metadata from PermissionCheck functions for OpenAPI docs
 */
function buildActionDescription(
  actions: Record<string, ActionHandler>,
  actionPermissions: Record<string, PermissionCheck>
): string {
  const lines = ['Unified action endpoint for state transitions.\n\n**Available actions:**'];

  Object.keys(actions).forEach((action) => {
    const perm = actionPermissions[action];
    const roles = (perm as PermissionCheck & { _roles?: readonly string[] })?._roles;
    const roleStr = roles?.length ? ` (requires: ${roles.join(' or ')})` : '';
    lines.push(`- \`${action}\`${roleStr}`);
  });

  return lines.join('\n');
}
