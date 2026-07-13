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
  const imports = ts
    ? `
import { multiTenantPreset } from '@classytic/arc/presets/tenant';

interface FlexibleMultiTenantOptions {
  tenantField?: string;
}
`
    : `
const { multiTenantPreset } = require('@classytic/arc/presets/tenant');
`;

  return `/**
 * Flexible Multi-Tenant Preset
 *
 * Thin wrapper around arc's built-in 'multiTenantPreset' with public reads:
 *
 * - list/get WITHOUT org context → allowed through unfiltered (public data)
 * - org context present → rows filtered + stamped to the caller's org
 * - elevated (platform admin) → unfiltered, cross-tenant
 * - create/update fail closed without org context, and update overwrites any
 *   client-supplied tenant field (no cross-tenant document hops)
 *
 * The built-in preset also registers 'systemManaged' field rules for the
 * tenant field, so generated request schemas never demand it in the body —
 * the server stamps it from the caller's scope instead. Don't hand-roll
 * tenant middleware: without those field rules Fastify's validation rejects
 * creates before injection can run.
 *
 * Want members-only reads? Drop 'allowPublic' below, or use
 * 'multiTenantPreset({ tenantField })' directly on the resource.
 */
${imports}
export function flexibleMultiTenantPreset(options${ts ? ": FlexibleMultiTenantOptions = {}" : " = {}"}) {
  const { tenantField = 'organizationId' } = options;
  return multiTenantPreset({ tenantField, allowPublic: ['list', 'get'] });
}

export default flexibleMultiTenantPreset;
`;
}
