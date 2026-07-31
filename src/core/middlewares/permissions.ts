/**
 * Permission middleware + context — the static per-route CRUD gate, the
 * dynamic per-action gate, and the shared PermissionContext builder both
 * gates must agree on.
 */

import type { FastifyReply, FastifyRequest, RouteHandlerMethod } from "fastify";

import { evaluateAndApplyPermission } from "../../permissions/authorizationDecision.js";
import type { PermissionCheck, PermissionContext } from "../../permissions/types.js";
import { getRequestScope } from "../../scope/types.js";
import type { RequestWithExtras, UserLike } from "../../types/index.js";
import { createError } from "../../utils/errors.js";

/**
 * Build a PermissionContext from a Fastify request. Extracted so the CRUD
 * permission middleware and the dynamic action-permission check use the same
 * field layout — divergence here silently broke policy filters for actions.
 */
export function buildPermissionContext(
  req: FastifyRequest,
  opts: {
    resource: string;
    action: string;
    resourceId?: string;
    data?: Record<string, unknown>;
  },
): PermissionContext {
  const reqWithExtras = req as RequestWithExtras;
  const params = req.params as Record<string, string> | undefined;
  return {
    user: (reqWithExtras.user as UserLike | undefined) ?? null,
    // First-class scope so checks read `scopeOf(ctx)` and combinators can thread
    // it purely — the raw `request` is the escape hatch, not the scope source.
    scope: getRequestScope(req),
    request: req,
    resource: opts.resource,
    action: opts.action,
    resourceId: opts.resourceId ?? params?.id,
    params,
    data: opts.data ?? (req.body as Record<string, unknown> | undefined),
  };
}

/**
 * Static per-route CRUD permission gate. The permission and action are known
 * at route-registration time, so the gate is a plain preHandler.
 *
 * Actions use the dynamic counterpart `buildActionPermissionMw` — their
 * permission is resolved from `body.action` at request time.
 */
export function buildCrudPermissionMw(
  permissionCheck: PermissionCheck | undefined,
  resourceName: string,
  action: string,
): RouteHandlerMethod | null {
  if (!permissionCheck) return null;
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const context = buildPermissionContext(req, { resource: resourceName, action });
    await evaluateAndApplyPermission(permissionCheck, context, req, reply);
    // evaluateAndApplyPermission returns false when it sends a response;
    // Fastify treats a sent reply as terminating the preHandler chain.
  };
}

/**
 * Dynamic per-action permission gate for the action router.
 *
 * Resolves the permission from `body.action` at request time and runs
 * `evaluateAndApplyPermission` from the canonical `permissionMw` slot — so
 * `_policyFilters` and `request.scope` are installed BEFORE `pluginMw`
 * (idempotency) and `routeGuards` run. Previously this check lived inside
 * the main action handler, which meant idempotency recorded unauthorized
 * requests and route guards saw unfiltered scope — the very divergence
 * routerShared exists to prevent.
 *
 * Also acts as a defensive fallback for invalid action names — the
 * `oneOf` body schema normally rejects these at AJV validation, but
 * hosts that disable schema validation still get a 400 here.
 */
export function buildActionPermissionMw(
  actionEnum: readonly string[],
  actionPermissions: Record<string, PermissionCheck>,
  globalAuth: PermissionCheck | undefined,
  resourceName: string,
): RouteHandlerMethod {
  const enumSet = new Set(actionEnum);
  const validActions = [...actionEnum];
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const body = (req.body ?? {}) as { action?: string } & Record<string, unknown>;
    const action = body.action;

    if (!action || !enumSet.has(action)) {
      // Throw a canonical 400 ArcError — the global error handler emits the
      // ErrorContract shape with `details.validActions` for consumers.
      throw createError(
        400,
        `Invalid action '${action ?? ""}'. Valid actions: ${validActions.join(", ")}`,
        { validActions },
      );
    }

    const permissionCheck = actionPermissions[action] ?? globalAuth;
    if (!permissionCheck) return;

    const { action: _discard, ...data } = body;
    const params = req.params as { id?: string } | undefined;
    const context = buildPermissionContext(req, {
      resource: resourceName,
      action,
      resourceId: params?.id,
      data,
    });
    await evaluateAndApplyPermission(permissionCheck, context, req, reply, {
      defaultDenialMessage: (user) =>
        user ? `Permission denied for '${action}'` : "Authentication required",
    });
  };
}
