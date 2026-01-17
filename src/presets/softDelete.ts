/**
 * Soft Delete Preset
 *
 * Adds routes for listing deleted items and restoring them.
 */

import type { AdditionalRoute, PresetResult, ResourcePermissions } from '../types/index.js';
import { requireRoles } from '../permissions/index.js';

export interface SoftDeleteOptions {
  deletedField?: string;
}

export function softDeletePreset(options: SoftDeleteOptions = {}): PresetResult {
  const { deletedField: _deletedField = 'deletedAt' } = options;

  return {
    name: 'softDelete',
    additionalRoutes: (permissions: ResourcePermissions): AdditionalRoute[] => [
      {
        method: 'GET',
        path: '/deleted',
        handler: 'getDeleted',
        summary: 'Get soft-deleted items',
        permissions: permissions.list ?? requireRoles(['admin']),
        wrapHandler: true,
      },
      {
        method: 'POST',
        path: '/:id/restore',
        handler: 'restore',
        summary: 'Restore soft-deleted item',
        permissions: permissions.update ?? requireRoles(['admin']),
        wrapHandler: true,
      },
    ],
  };
}

export default softDeletePreset;
