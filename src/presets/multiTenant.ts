/**
 * Multi-Tenant Preset
 *
 * Adds tenant (organization) filtering and injection middlewares.
 */

import type { FastifyReply, FastifyRequest } from "fastify";
import { DEFAULT_TENANT_FIELD } from "../constants.js";
import type { RequestScope } from "../scope/types.js";
import { getOrgId, isElevated, isMember, PUBLIC_SCOPE } from "../scope/types.js";
import type {
  AnyRecord,
  CrudRouteKey,
  MiddlewareConfig,
  PresetResult,
  RequestWithExtras,
  RouteHandler,
} from "../types/index.js";

export interface MultiTenantOptions {
  /** Field name in database (default: 'organizationId') */
  tenantField?: string;

  /**
   * Routes that allow public access (no auth required)
   * When a route is in this array:
   * - If no org context: allow through without filtering (public data)
   * - If org context present: require auth and apply filter
   *
   * @default [] (strict mode - all routes require auth)
   * @example
   * multiTenantPreset({ allowPublic: ['list', 'get'] })
   */
  allowPublic?: CrudRouteKey[];
}

/** Read request.scope safely */
function getScope(request: FastifyRequest): RequestScope {
  return request.scope ?? PUBLIC_SCOPE;
}

/**
 * Create tenant filter middleware
 * Adds tenant filter to query for list/get operations.
 * Reads `request.scope` for org context and elevation bypass.
 */
function createTenantFilter(tenantField: string): RouteHandler {
  return async (request: RequestWithExtras, reply: FastifyReply): Promise<void> => {
    const scope = getScope(request);

    // Elevated without org → no filter (admin viewing all)
    // Elevated with org → filter by that org
    if (isElevated(scope)) {
      const orgId = getOrgId(scope);
      if (orgId) {
        request._policyFilters = {
          ...(request._policyFilters ?? {}),
          [tenantField]: orgId,
        };
      }
      return;
    }

    // Member → filter by scope.organizationId
    if (isMember(scope)) {
      request._policyFilters = {
        ...(request._policyFilters ?? {}),
        [tenantField]: scope.organizationId,
      };
      return;
    }

    // authenticated / public → 403 (multi-tenant requires org context)
    if (scope.kind === "public") {
      reply.code(401).send({
        success: false,
        error: "Unauthorized",
        message: "Authentication required for multi-tenant resources",
      });
      return;
    }

    // authenticated but no org → 403
    reply.code(403).send({
      success: false,
      error: "Forbidden",
      message: "Organization context required for this operation",
    });
  };
}

/**
 * Create flexible tenant filter middleware
 * For routes in allowPublic: only filter when org context is present
 * No org context = allow through (public data)
 * Org context present = require auth and apply filter
 */
function createFlexibleTenantFilter(tenantField: string): RouteHandler {
  return async (request: RequestWithExtras, _reply: FastifyReply): Promise<void> => {
    const scope = getScope(request);

    // Elevated without org → no filter (admin viewing all)
    if (isElevated(scope)) {
      const orgId = getOrgId(scope);
      if (orgId) {
        request._policyFilters = {
          ...(request._policyFilters ?? {}),
          [tenantField]: orgId,
        };
      }
      return;
    }

    // Member → filter by scope.organizationId
    if (isMember(scope)) {
      request._policyFilters = {
        ...(request._policyFilters ?? {}),
        [tenantField]: scope.organizationId,
      };
      return;
    }

    // authenticated / public with no org context → allow through (public data)
    return;
  };
}

/**
 * Create tenant injection middleware
 * Injects tenant ID into request body on create.
 * Reads `request.scope` for org context.
 */
function createTenantInjection(tenantField: string): RouteHandler {
  return async (request: RequestWithExtras, reply: FastifyReply): Promise<void> => {
    const scope = getScope(request);
    const orgId = getOrgId(scope);

    // Elevated without org → skip injection (admin cross-org operation)
    if (isElevated(scope) && !orgId) {
      return;
    }

    // Fail-closed: Require orgId to prevent orphaned data
    if (!orgId) {
      reply.code(403).send({
        success: false,
        error: "Forbidden",
        message: "Organization context required to create resources",
      });
      return;
    }

    if (request.body) {
      (request.body as AnyRecord)[tenantField] = orgId;
    }
  };
}

export function multiTenantPreset(options: MultiTenantOptions = {}): PresetResult {
  const { tenantField = DEFAULT_TENANT_FIELD, allowPublic = [] } = options;

  // Create middleware variants
  const strictTenantFilter = createTenantFilter(tenantField);
  const flexibleTenantFilter = createFlexibleTenantFilter(tenantField);
  const tenantInjection = createTenantInjection(tenantField);

  // Helper to select appropriate filter based on allowPublic
  const getFilter = (route: CrudRouteKey): RouteHandler =>
    allowPublic.includes(route) ? flexibleTenantFilter : strictTenantFilter;

  return {
    name: "multiTenant",
    middlewares: {
      list: [getFilter("list")],
      get: [getFilter("get")],
      create: [tenantInjection],
      update: [getFilter("update")],
      delete: [getFilter("delete")],
    } as MiddlewareConfig,
  };
}

