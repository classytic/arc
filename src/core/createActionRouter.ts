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
 * import { createActionRouter } from '@classytic/arc/core';
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

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  applyPermissionResult,
  normalizePermissionResult,
} from "../permissions/applyPermissionResult.js";
import type {
  PermissionCheck,
  PermissionContext,
  PermissionResult,
  RequestWithExtras,
  UserBase,
} from "../types/index.js";

/**
 * Action handler function
 * @param id - Resource ID
 * @param data - Action-specific data from request body
 * @param req - Full Fastify request object
 * @returns Action result (will be wrapped in success response)
 */
export type ActionHandler<TData = Record<string, unknown>, TResult = unknown> = (
  id: string,
  data: TData,
  req: RequestWithExtras,
) => Promise<TResult>;

/**
 * Action router configuration
 */
export interface ActionRouterConfig {
  /**
   * OpenAPI tag for grouping routes
   */
  readonly tag?: string;

  /**
   * Action handlers map
   * @example { approve: (id, data, req) => service.approve(id), ... }
   */
  readonly actions: Record<string, ActionHandler>;

  /**
   * Per-action permission checks (PermissionCheck functions)
   * @example { approve: requireRoles(['admin', 'manager']), cancel: requireRoles(['admin']) }
   */
  readonly actionPermissions?: Record<string, PermissionCheck>;

  /**
   * Per-action JSON schema for body validation
   * @example { dispatch: { transport: { type: 'object' } } }
   */
  readonly actionSchemas?: Record<string, Record<string, unknown>>;

  /**
   * Global permission check applied to all actions (if action-specific not defined)
   */
  readonly globalAuth?: PermissionCheck;

  /**
   * Optional idempotency service
   * If provided, will handle idempotency-key header
   */
  readonly idempotencyService?: IdempotencyService;

  /**
   * Custom error handler for action execution failures
   * @param error - The error thrown by action handler
   * @param action - The action that failed
   * @param id - The resource ID
   * @returns Status code and error response
   */
  readonly onError?: (
    error: Error,
    action: string,
    id: string,
  ) => { statusCode: number; error: string; code?: string };
}

/**
 * Idempotency service interface
 * Apps can provide their own implementation
 */
export interface IdempotencyService {
  check(key: string, payload: unknown): Promise<{ isNew: boolean; existingResult?: unknown }>;
  complete(key: string | undefined, result: unknown): Promise<void>;
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
    fastify.log.warn("[createActionRouter] No actions defined, skipping route creation");
    return;
  }

  // Build unified body schema with action-specific properties
  const bodyProperties: Record<string, unknown> = {
    action: {
      type: "string",
      enum: actionEnum,
      description: `Action to perform: ${actionEnum.join(" | ")}`,
    },
  };

  // Add action-specific schema properties
  Object.entries(actionSchemas).forEach(([actionName, schema]) => {
    if (schema && typeof schema === "object") {
      Object.entries(schema).forEach(([propName, propSchema]) => {
        const schemaObj = propSchema as Record<string, unknown>;
        bodyProperties[propName] = {
          ...schemaObj,
          description:
            `${(schemaObj.description as string) || ""} (for ${actionName} action)`.trim(),
        };
      });
    }
  });

  const routeSchema = {
    tags: tag ? [tag] : undefined,
    summary: `Perform action (${actionEnum.join("/")})`,
    description: buildActionDescription(actions, actionPermissions),
    params: {
      type: "object",
      properties: {
        id: { type: "string", description: "Resource ID" },
      },
      required: ["id"],
    },
    body: {
      type: "object",
      properties: bodyProperties,
      required: ["action"],
    },
    // No response schema — action handlers return dynamic shapes
    // (Mongoose documents, composite objects, etc.) that cannot be
    // described with a static JSON Schema.  Fastify will serialize
    // them with plain JSON.stringify, which honours toJSON().
  };

  // Build preHandlers
  const preHandler = [];

  // Determine which actions require authentication
  const hasPublicActions =
    Object.entries(actionPermissions).some(([, p]) => (p as PermissionCheck)?._isPublic) ||
    (globalAuth && (globalAuth as PermissionCheck)?._isPublic);
  const hasProtectedActions =
    Object.entries(actionPermissions).some(([, p]) => !(p as PermissionCheck)?._isPublic) ||
    (globalAuth && !(globalAuth as PermissionCheck)?._isPublic);

  // If ALL actions are protected, use global auth preHandler.
  // If mixed (some public, some protected), defer auth to per-action check
  // to avoid rejecting unauthenticated requests for public actions.
  if (hasProtectedActions && !hasPublicActions && fastify.authenticate) {
    preHandler.push(fastify.authenticate);
  }

  // Register the unified action endpoint
  fastify.post(
    "/:id/action",
    {
      schema: routeSchema,
      preHandler: preHandler.length ? preHandler : undefined,
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { action, ...data } = req.body as { action: string; [key: string]: unknown };
      const { id } = req.params as { id: string };
      const rawIdempotencyKey = req.headers["idempotency-key"];
      const idempotencyKey = Array.isArray(rawIdempotencyKey)
        ? rawIdempotencyKey[0]
        : rawIdempotencyKey;

      // Validate action exists
      const handler = actions[action];
      if (!handler) {
        return reply.code(400).send({
          success: false,
          error: `Invalid action '${action}'. Valid actions: ${actionEnum.join(", ")}`,
          validActions: actionEnum,
        });
      }

      // Check permissions: action-specific first, then fallback to globalAuth
      const permissionCheck = actionPermissions[action] ?? globalAuth;

      // If mixed public/protected actions, authenticate per-action for protected ones
      if (hasPublicActions && hasProtectedActions && permissionCheck) {
        const isPublicAction = (permissionCheck as PermissionCheck)?._isPublic;
        if (!isPublicAction && fastify.authenticate) {
          try {
            await fastify.authenticate(req, reply);
          } catch {
            // Avoid double-send: authenticate may have already sent a 401
            if (!reply.sent) {
              return reply.code(401).send({
                success: false,
                error: "Authentication required",
              });
            }
            return;
          }
          // authenticate may send reply without throwing (some implementations)
          if (reply.sent) return;
        }
      }

      if (permissionCheck) {
        const reqWithExtras = req as RequestWithExtras;
        const context: PermissionContext = {
          user: (reqWithExtras.user as UserBase | null) ?? null,
          request: req,
          resource: tag ?? "action",
          action,
          resourceId: id,
          params: req.params as Record<string, string> | undefined,
          data,
        };

        // Wrap in try/catch so authz bugs don't produce 500s
        // (consistent with CRUD router's buildPermissionMiddleware)
        let result: boolean | PermissionResult;
        try {
          result = await permissionCheck(context);
        } catch (err) {
          req.log?.warn?.({ err, resource: tag ?? "action", action }, "Permission check threw");
          return reply.code(403).send({
            success: false,
            error: "Permission denied",
          });
        }

        // Normalize boolean → PermissionResult via the single-source-of-truth helper
        const permResult = normalizePermissionResult(result);
        if (!permResult.granted) {
          return reply.code(context.user ? 403 : 401).send({
            success: false,
            error:
              permResult.reason ??
              (context.user ? `Permission denied for '${action}'` : "Authentication required"),
          });
        }

        // Apply filters + scope via the shared helper — this is what makes
        // action routes honor PermissionResult.scope the same way CRUD routes
        // do. Before this, custom auth on action routes silently dropped
        // scope + filters and handlers ran with the wrong request.scope.
        applyPermissionResult(permResult, req);
      }

      try {
        // Idempotency check (optional)
        if (idempotencyKey && idempotencyService) {
          const user = (req as RequestWithExtras).user as UserBase | undefined;
          const payloadForHash = {
            action,
            id,
            data,
            userId: (user?._id as string | undefined)?.toString?.() || user?.id || null,
          };

          const idempotencyResult = await idempotencyService.check(idempotencyKey, payloadForHash);
          // Use 'in' to check presence, not truthiness — existingResult may be
          // a valid falsy value (0, false, '', null) from a previous execution.
          if (!idempotencyResult.isNew && "existingResult" in idempotencyResult) {
            return reply.send({
              success: true,
              data: idempotencyResult.existingResult,
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
        const err = error as Record<string, unknown>;
        const statusCode = (err.statusCode as number) || (err.status as number) || 500;
        const errorCode = (err.code as string) || "ACTION_FAILED";

        if (statusCode >= 500) {
          req.log.error({ err: error, action, id }, "Action handler error");
        }

        return reply.code(statusCode).send({
          success: false,
          error: err.message || `Failed to execute '${action}' action`,
          code: errorCode,
        });
      }
    },
  );

  fastify.log.debug(
    { actions: actionEnum, tag },
    "[createActionRouter] Registered action endpoint: POST /:id/action",
  );
}

/**
 * Build description with action details
 * Uses _roles metadata from PermissionCheck functions for OpenAPI docs
 */
function buildActionDescription(
  actions: Record<string, ActionHandler>,
  actionPermissions: Record<string, PermissionCheck>,
): string {
  const lines = ["Unified action endpoint for state transitions.\n\n**Available actions:**"];

  Object.keys(actions).forEach((action) => {
    const perm = actionPermissions[action];
    const roles = (perm as PermissionCheck)?._roles;
    const roleStr = roles?.length ? ` (requires: ${roles.join(" or ")})` : "";
    lines.push(`- \`${action}\`${roleStr}`);
  });

  return lines.join("\n");
}
