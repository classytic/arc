/**
 * Soft Delete Preset
 *
 * Adds routes for listing deleted items and restoring them.
 * The actual soft-delete behavior (deletedAt field, query filtering)
 * is handled by the repository/adapter layer (e.g., MongoKit's softDelete plugin).
 */

import type { AdditionalRoute, PresetResult, ResourcePermissions } from '../types/index.js';
import { requireRoles } from '../permissions/index.js';

export function softDeletePreset(): PresetResult {
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
        operation: 'listDeleted',
      },
      {
        method: 'POST',
        path: '/:id/restore',
        handler: 'restore',
        summary: 'Restore soft-deleted item',
        permissions: permissions.update ?? requireRoles(['admin']),
        wrapHandler: true,
        operation: 'restore',
      },
    ],
  };
}

export default softDeletePreset;
