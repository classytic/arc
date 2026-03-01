/**
 * Tree Preset
 *
 * Adds routes for hierarchical tree structures.
 */

import type { AdditionalRoute, ResourcePermissions, PresetResult } from '../types/index.js';
import { allowPublic } from '../permissions/index.js';

export interface TreeOptions {
  parentField?: string;
}

export function treePreset(options: TreeOptions = {}): PresetResult {
  const { parentField = 'parent' } = options;

  return {
    name: 'tree',
    additionalRoutes: (permissions: ResourcePermissions): AdditionalRoute[] => [
      {
        method: 'GET',
        path: '/tree',
        handler: 'getTree',
        summary: 'Get hierarchical tree',
        permissions: permissions.list ?? allowPublic(),
        wrapHandler: true,
        operation: 'getTree',
      },
      {
        method: 'GET',
        path: `/:${parentField}/children`,
        handler: 'getChildren',
        summary: 'Get children of parent',
        permissions: permissions.list ?? allowPublic(),
        wrapHandler: true,
        operation: 'getChildren',
      },
    ],
    // Pass to controller so it knows which param to read
    controllerOptions: {
      parentField,
    },
  };
}

export default treePreset;
