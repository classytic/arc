/**
 * Multi-Tenant Preset
 *
 * Adds tenant (organization) filtering and injection middlewares.
 */

import type { FastifyReply } from 'fastify';
import type {
  AnyRecord,
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
  } = options;

  const tenantFilter = createTenantFilter(tenantField, bypassRoles, extractOrganizationId);
  const tenantInjection = createTenantInjection(tenantField, extractOrganizationId);

  return {
    name: 'multiTenant',
    middlewares: {
      list: [tenantFilter],
      get: [tenantFilter],
      create: [tenantInjection],
      update: [tenantFilter],
      delete: [tenantFilter],
    } as MiddlewareConfig,
  };
}

export default multiTenantPreset;
