/**
 * Slug Lookup Preset
 *
 * Adds a route to get resource by slug.
 */

import type { AdditionalRoute, ResourcePermissions, PresetResult } from '../types/index.js';
import { allowPublic } from '../permissions/index.js';

export interface SlugLookupOptions {
  slugField?: string;
}

export function slugLookupPreset(options: SlugLookupOptions = {}): PresetResult {
  const { slugField = 'slug' } = options;

  return {
    name: 'slugLookup',
    additionalRoutes: (permissions: ResourcePermissions): AdditionalRoute[] => [
      {
        method: 'GET',
        path: `/slug/:${slugField}`,
        handler: 'getBySlug',
        summary: 'Get by slug',
        permissions: permissions.get ?? allowPublic(),
        wrapHandler: true,
        operation: 'getBySlug',
      },
    ],
    // Pass to controller so it knows which param to read
    controllerOptions: {
      slugField,
    },
  };
}

export default slugLookupPreset;
