/**
 * Slug Lookup Preset
 *
 * Adds a route to get resource by slug.
 */

import type {
  PresetController,
  PresetResult,
  ResourcePermissions,
  RouteDefinition,
} from "../types/index.js";
import { presetPermission } from "./presetPermission.js";

export interface SlugLookupOptions {
  slugField?: string;
}

export function slugLookupPreset(options: SlugLookupOptions = {}): PresetResult {
  const { slugField = "slug" } = options;

  return {
    name: "slugLookup",
    routes: (
      permissions: ResourcePermissions,
      controller: PresetController<"getBySlug">,
    ): RouteDefinition[] => [
      {
        method: "GET",
        path: `/slug/:${slugField}`,
        handler: controller.getBySlug,
        summary: "Get by slug",
        permissions: presetPermission(permissions.get, { preset: "slugLookup", inherits: "get" }),
        operation: "getBySlug",
        _tenantSlot: "get",
      },
    ],
    controllerOptions: {
      slugField,
    },
  };
}
