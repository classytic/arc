/**
 * Slug Lookup Preset
 *
 * Adds a route to get resource by slug.
 */

import { allowPublic } from "../permissions/index.js";
import type { PresetResult, ResourcePermissions, RouteDefinition } from "../types/index.js";

export interface SlugLookupOptions {
  slugField?: string;
}

export function slugLookupPreset(options: SlugLookupOptions = {}): PresetResult {
  const { slugField = "slug" } = options;

  return {
    name: "slugLookup",
    routes: (permissions: ResourcePermissions): RouteDefinition[] => [
      {
        method: "GET",
        path: `/slug/:${slugField}`,
        handler: "getBySlug",
        summary: "Get by slug",
        permissions: permissions.get ?? allowPublic(),
        operation: "getBySlug",
      },
    ],
    controllerOptions: {
      slugField,
    },
  };
}
