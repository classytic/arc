/**
 * Multi-Tenant Preset
 *
 * Adds tenant (organization) filtering and injection middlewares.
 */

import type { FastifyReply } from 'fastify';
import type {
  AnyRecord,
  CrudRouteKey,
  MiddlewareConfig,
  PresetResult,
  RequestWithExtras,
  RouteHandler,
} from '../types/index.js';

export interface MultiTenantOptions {
  /** Field name in database (default: 'organizationId') */
  tenantField?: string;

  /** Roles that bypass tenant isolation (default: ['superadmin']) */
  bypassRoles?: string[];

  /**
   * Custom function to extract organizationId from request
   * If not provided, tries in order:
   * 1. request.context.organizationId
   * 2. request.user.organizationId
   * 3. request.user.organization
   */
  extractOrganizationId?: (request: RequestWithExtras) => string | null | undefined;

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

/**
 * Default organization ID extractor
 * Tries multiple sources in order of priority
 */
function defaultExtractOrganizationId(request: RequestWithExtras): string | null | undefined {
  // Priority 1: Explicit context (set by orgScopePlugin or custom middleware)
  const context = request.context as { organizationId?: string } | undefined;
  if (context?.organizationId) {
    return context.organizationId;
  }

  // Priority 2: User's organizationId field
  const user = request.user as any;
  if (user?.organizationId) {
    return user.organizationId as string;
  }

  // Priority 3: User's organization object (nested)
  if (user?.organization) {
    const org = user.organization as any;
    return org._id || org.id || org;
  }

  return null;
}

/**
 * Create tenant filter middleware
 * Adds tenant filter to query for list/get operations
 */
function createTenantFilter(
  tenantField: string,
  bypassRoles: string[],
  extractOrganizationId: (request: RequestWithExtras) => string | null | undefined
): RouteHandler {
  return async (request: RequestWithExtras, reply: FastifyReply): Promise<void> => {
    const user = request.user;

    // SECURITY: Fail-closed - require authentication for multi-tenant routes
    // Using multiTenant on public routes is a misconfiguration that can leak data
    if (!user) {
      reply.code(401).send({
        success: false,
        error: 'Unauthorized',
        message: 'Authentication required for multi-tenant resources',
      });
      return;
    }

    // Bypass roles skip filter
    const userWithRoles = user as { roles?: string[] };
    if (userWithRoles.roles && bypassRoles.some((r) => userWithRoles.roles!.includes(r))) return;

    // Extract organization ID using custom or default extractor
    const orgId = extractOrganizationId(request);

    // Fail-closed: Require orgId for non-bypass users
    if (!orgId) {
      reply.code(403).send({
        success: false,
        error: 'Forbidden',
        message: 'Organization context required for this operation',
      });
      return;
    }

    request.query = request.query ?? {};
    (request.query as AnyRecord)._policyFilters = {
      ...((request.query as AnyRecord)._policyFilters ?? {}),
      [tenantField]: orgId,
    };
  };
}

/**
 * Create flexible tenant filter middleware
 * For routes in allowPublic: only filter when org context is present
 * No org context = allow through (public data)
 * Org context present = require auth and apply filter
 */
function createFlexibleTenantFilter(
  tenantField: string,
  bypassRoles: string[],
  extractOrganizationId: (request: RequestWithExtras) => string | null | undefined
): RouteHandler {
  return async (request: RequestWithExtras, reply: FastifyReply): Promise<void> => {
    const user = request.user;
    const orgId = extractOrganizationId(request);

    // No org context - allow through (public data, no filtering)
    if (!orgId) {
      return;
    }

    // Org context present - require authentication
    if (!user) {
      reply.code(401).send({
        success: false,
        error: 'Unauthorized',
        message: 'Authentication required for organization-scoped data',
      });
      return;
    }

    // Bypass roles skip filter (superadmin sees all)
    const userWithRoles = user as { roles?: string[] };
    if (userWithRoles.roles && bypassRoles.some((r) => userWithRoles.roles!.includes(r))) {
      return;
    }

    // Apply tenant filter
    request.query = request.query ?? {};
    (request.query as AnyRecord)._policyFilters = {
      ...((request.query as AnyRecord)._policyFilters ?? {}),
      [tenantField]: orgId,
    };
  };
}

/**
 * Create tenant injection middleware
 * Injects tenant ID into request body on create
 */
function createTenantInjection(
  tenantField: string,
  extractOrganizationId: (request: RequestWithExtras) => string | null | undefined
): RouteHandler {
  return async (request: RequestWithExtras, reply: FastifyReply): Promise<void> => {
    // Extract organization ID using custom or default extractor
    const orgId = extractOrganizationId(request);

    // Fail-closed: Require orgId to prevent orphaned data
    if (!orgId) {
      reply.code(403).send({
        success: false,
        error: 'Forbidden',
        message: 'Organization context required to create resources',
      });
      return;
    }

    if (request.body) {
      (request.body as AnyRecord)[tenantField] = orgId;
    }
  };
}

export function multiTenantPreset(options: MultiTenantOptions = {}): PresetResult {
  const {
    tenantField = 'organizationId',
    bypassRoles = ['superadmin'],
    extractOrganizationId = defaultExtractOrganizationId,
    allowPublic = [],
  } = options;

  // Create middleware variants
  const strictTenantFilter = createTenantFilter(tenantField, bypassRoles, extractOrganizationId);
  const flexibleTenantFilter = createFlexibleTenantFilter(tenantField, bypassRoles, extractOrganizationId);
  const tenantInjection = createTenantInjection(tenantField, extractOrganizationId);

  // Helper to select appropriate filter based on allowPublic
  const getFilter = (route: CrudRouteKey): RouteHandler =>
    allowPublic.includes(route) ? flexibleTenantFilter : strictTenantFilter;

  return {
    name: 'multiTenant',
    middlewares: {
      list: [getFilter('list')],
      get: [getFilter('get')],
      create: [tenantInjection],
      update: [getFilter('update')],
      delete: [getFilter('delete')],
    } as MiddlewareConfig,
  };
}

export default multiTenantPreset;
