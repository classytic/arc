/**
 * Tree Preset
 *
 * Adds routes for hierarchical tree structures.
 */

import { allowPublic } from "../permissions/index.js";
import type { PresetResult, ResourcePermissions, RouteDefinition } from "../types/index.js";

export interface TreeOptions {
  parentField?: string;
}

export function treePreset(options: TreeOptions = {}): PresetResult {
  const { parentField = "parent" } = options;

  return {
    name: "tree",
    routes: (permissions: ResourcePermissions): RouteDefinition[] => [
      {
        method: "GET",
        path: "/tree",
        handler: "getTree",
        summary: "Get hierarchical tree",
        permissions: permissions.list ?? allowPublic(),
        operation: "getTree",
      },
      {
        method: "GET",
        path: `/:${parentField}/children`,
        handler: "getChildren",
        summary: "Get children of parent",
        permissions: permissions.list ?? allowPublic(),
        operation: "getChildren",
      },
    ],
    controllerOptions: {
      parentField,
    },
  };
}
