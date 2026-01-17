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
 *     approve: ['admin', 'warehouse-manager'],
 *     dispatch: ['admin', 'warehouse-staff'],
 *     receive: ['admin', 'store-manager'],
 *     cancel: ['admin'],
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
import type { RequestWithExtras } from '../types/index.js';

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
   * Per-action role requirements
   * @example { approve: ['admin', 'manager'], cancel: ['admin'] }
   */
  actionPermissions?: Record<string, string[]>;

  /**
   * Per-action JSON schema for body validation
   * @example { dispatch: { transport: { type: 'object' } } }
   */
  actionSchemas?: Record<string, Record<string, any>>;

  /**
   * Global auth roles applied to all actions (if action-specific not defined)
   */
  globalAuth?: string[];

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
    globalAuth = [],
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

  // Add global authentication if any roles specified
  const allRequiredRoles = new Set(globalAuth);
  Object.values(actionPermissions).forEach((roles) => {
    if (Array.isArray(roles)) {
      roles.forEach((r) => allRequiredRoles.add(r));
    }
  });

  if (allRequiredRoles.size > 0 && (fastify as any).authenticate) {
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
      const requiredRoles = actionPermissions[action]?.length
        ? actionPermissions[action]
        : globalAuth;

      if (requiredRoles?.length) {
        const user = (req as RequestWithExtras).user;
        if (!user) {
          return reply.code(401).send({
            success: false,
            error: 'Authentication required',
          });
        }
        if (!checkUserRoles(user, requiredRoles)) {
          return reply.code(403).send({
            success: false,
            error: `Insufficient permissions for '${action}'. Required: ${requiredRoles.join(' or ')}`,
          });
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
 * Check if user has any of the required roles
 */
function checkUserRoles(user: any, requiredRoles: string[]): boolean {
  if (!user || !requiredRoles?.length) return true;

  // Check single role field
  if (user.role && requiredRoles.includes(user.role)) {
    return true;
  }

  // Check roles array
  if (Array.isArray(user.roles)) {
    return user.roles.some((r: string) => requiredRoles.includes(r));
  }

  // Check via method if available
  if (typeof user.hasAnyRole === 'function') {
    return user.hasAnyRole(requiredRoles);
  }

  return false;
}

/**
 * Build description with action details
 */
function buildActionDescription(
  actions: Record<string, ActionHandler>,
  actionPermissions: Record<string, string[]>
): string {
  const lines = ['Unified action endpoint for state transitions.\n\n**Available actions:**'];

  Object.keys(actions).forEach((action) => {
    const roles = actionPermissions[action];
    const roleStr = roles?.length ? ` (requires: ${roles.join(' or ')})` : '';
    lines.push(`- \`${action}\`${roleStr}`);
  });

  return lines.join('\n');
}
