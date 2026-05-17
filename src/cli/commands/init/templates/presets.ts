/**
 * Preset templates — `src/shared/presets/index.ts` (multi- or single-tenant
 * preset wiring) plus the optional `flexible-multi-tenant.ts` helper that
 * ships only on multi-tenant scaffolds.
 */

import type { ProjectConfig } from "../types.js";

export function presetsMultiTenantTemplate(config: ProjectConfig): string {
  const ts = config.typescript;

  return `/**
 * Arc Presets - Multi-Tenant Configuration
 *
 * Pre-configured presets for multi-tenant applications.
 * Includes both strict and flexible tenant isolation options.
 */

import {
  multiTenantPreset,
  ownedByUserPreset,
  softDeletePreset,
  slugLookupPreset,
} from '@classytic/arc/presets';

// Flexible preset for mixed public/private routes
export { flexibleMultiTenantPreset } from './flexible-multi-tenant.js';

/**
 * Organization-scoped preset (STRICT)
 * Always requires auth, always filters by organizationId.
 * Use for admin-only resources.
 */
export const orgScoped = multiTenantPreset({
  tenantField: 'organizationId',
});

/**
 * Owned by creator preset
 * Filters queries by createdBy field.
 */
export const ownedByCreator = ownedByUserPreset({
  ownerField: 'createdBy',
});

/**
 * Owned by user preset
 * For resources where userId references the owner.
 */
export const ownedByUser = ownedByUserPreset({
  ownerField: 'userId',
});

/**
 * Soft delete preset
 * Adds deletedAt filtering and restore endpoint.
 */
export const softDelete = softDeletePreset();

/**
 * Slug lookup preset
 * Enables GET by slug in addition to ID.
 */
export const slugLookup = slugLookupPreset();

// Export all presets
export const presets = {
  orgScoped,
  ownedByCreator,
  ownedByUser,
  softDelete,
  slugLookup,
}${ts ? " as const" : ""};

export default presets;
`;
}

export function presetsSingleTenantTemplate(config: ProjectConfig): string {
  const ts = config.typescript;

  return `/**
 * Arc Presets - Single-Tenant Configuration
 *
 * Pre-configured presets for single-tenant applications.
 */

import {
  ownedByUserPreset,
  softDeletePreset,
  slugLookupPreset,
} from '@classytic/arc/presets';

/**
 * Owned by creator preset
 * Filters queries by createdBy field.
 */
export const ownedByCreator = ownedByUserPreset({
  ownerField: 'createdBy',
});

/**
 * Owned by user preset
 * For resources where userId references the owner.
 */
export const ownedByUser = ownedByUserPreset({
  ownerField: 'userId',
});

/**
 * Soft delete preset
 * Adds deletedAt filtering and restore endpoint.
 */
export const softDelete = softDeletePreset();

/**
 * Slug lookup preset
 * Enables GET by slug in addition to ID.
 */
export const slugLookup = slugLookupPreset();

// Export all presets
export const presets = {
  ownedByCreator,
  ownedByUser,
  softDelete,
  slugLookup,
}${ts ? " as const" : ""};

export default presets;
`;
}

export function flexibleMultiTenantPresetTemplate(config: ProjectConfig): string {
  const ts = config.typescript;
  const typeAnnotations = ts
    ? `
import { getOrgId, isElevated, isMember } from '@classytic/arc/scope';
import type { RequestScope } from '@classytic/arc/scope';

interface FlexibleMultiTenantOptions {
  tenantField?: string;
}

interface PresetMiddlewares {
  list: ((request: any, reply: any) => Promise<void>)[];
  get: ((request: any, reply: any) => Promise<void>)[];
  create: ((request: any, reply: any) => Promise<void>)[];
  update: ((request: any, reply: any) => Promise<void>)[];
  delete: ((request: any, reply: any) => Promise<void>)[];
}

interface Preset {
  [key: string]: unknown;
  name: string;
  middlewares: PresetMiddlewares;
}
`
    : `
const { getOrgId, isElevated, isMember } = require('@classytic/arc/scope');
`;

  return `/**
 * Flexible Multi-Tenant Preset
 *
 * Smarter tenant filtering that works with public + authenticated routes.
 *
 * Philosophy:
 * - No org scope → No filtering (public data, all orgs)
 * - Org scope present → Filter by org
 * - Elevated scope → No filter (platform admin sees all)
 *
 * Uses request.scope (RequestScope) from Arc's scope system.
 */
${typeAnnotations}
/**
 * Create flexible tenant filter middleware.
 * Only filters when org context is present.
 */
function createFlexibleTenantFilter(tenantField${ts ? ": string" : ""}) {
  return async (request${ts ? ": any" : ""}, reply${ts ? ": any" : ""}) => {
    const scope${ts ? ": RequestScope" : ""} = request.scope ?? { kind: 'public' };

    // Elevated scope — platform admin sees all, no filter
    if (isElevated(scope)) {
      request.log?.debug?.({ msg: 'Elevated scope — no tenant filter' });
      return;
    }

    // Member scope — filter by org
    if (isMember(scope)) {
      request.query = request.query ?? {};
      request.query._policyFilters = {
        ...(request.query._policyFilters ?? {}),
        [tenantField]: scope.organizationId,
      };
      request.log?.debug?.({ msg: 'Tenant filter applied', orgId: scope.organizationId, tenantField });
      return;
    }

    // Public / authenticated — no org context, show all data (public routes)
    request.log?.debug?.({ msg: 'No org context — showing all data' });
  };
}

/**
 * Create tenant injection middleware.
 * Injects tenant ID into request body on create.
 */
function createTenantInjection(tenantField${ts ? ": string" : ""}) {
  return async (request${ts ? ": any" : ""}, reply${ts ? ": any" : ""}) => {
    const scope${ts ? ": RequestScope" : ""} = request.scope ?? { kind: 'public' };
    const orgId = getOrgId(scope);

    // Fail-closed: Require orgId for create operations
    if (!orgId) {
      return reply.code(403).send({
        error: 'Organization context required to create resources',
        code: 'arc.org_required',
      });
    }

    if (request.body) {
      request.body[tenantField] = orgId;
    }
  };
}

/**
 * Flexible Multi-Tenant Preset
 *
 * @param options.tenantField - Field name in database (default: 'organizationId')
 */
export function flexibleMultiTenantPreset(options${ts ? ": FlexibleMultiTenantOptions = {}" : " = {}"})${ts ? ": Preset" : ""} {
  const { tenantField = 'organizationId' } = options;

  const tenantFilter = createFlexibleTenantFilter(tenantField);
  const tenantInjection = createTenantInjection(tenantField);

  return {
    name: 'flexibleMultiTenant',
    middlewares: {
      list: [tenantFilter],
      get: [tenantFilter],
      create: [tenantInjection],
      update: [tenantFilter],
      delete: [tenantFilter],
    },
  };
}

export default flexibleMultiTenantPreset;
`;
}
