/**
 * Slug Lookup Preset
 *
 * Adds a route to get resource by slug.
 */

import { allowPublic } from "../permissions/index.js";
import type { AdditionalRoute, PresetResult, ResourcePermissions } from "../types/index.js";

export interface SlugLookupOptions {
  slugField?: string;
}

export function slugLookupPreset(options: SlugLookupOptions = {}): PresetResult {
  const { slugField = "slug" } = options;

  return {
    name: "slugLookup",
    additionalRoutes: (permissions: ResourcePermissions): AdditionalRoute[] => [
      {
        method: "GET",
        path: `/slug/:${slugField}`,
        handler: "getBySlug",
        summary: "Get by slug",
        permissions: permissions.get ?? allowPublic(),
        wrapHandler: true,
        operation: "getBySlug",
      },
    ],
    // Pass to controller so it knows which param to read
    controllerOptions: {
      slugField,
    },
  };
}

