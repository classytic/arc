/**
 * Tree Preset
 *
 * Adds routes for hierarchical tree structures.
 */

import type {
  PresetController,
  PresetResult,
  ResourcePermissions,
  RouteDefinition,
} from "../types/index.js";
import { presetPermission } from "./presetPermission.js";

export interface TreeOptions {
  parentField?: string;
}

export function treePreset(options: TreeOptions = {}): PresetResult {
  const { parentField = "parent" } = options;

  return {
    name: "tree",
    routes: (
      permissions: ResourcePermissions,
      controller: PresetController<"getTree" | "getChildren">,
    ): RouteDefinition[] => [
      {
        method: "GET",
        path: "/tree",
        handler: controller.getTree,
        summary: "Get hierarchical tree",
        permissions: presetPermission(permissions.list, { preset: "tree", inherits: "list" }),
        operation: "getTree",
        _tenantSlot: "list",
      },
      {
        method: "GET",
        path: `/:${parentField}/children`,
        handler: controller.getChildren,
        summary: "Get children of parent",
        permissions: presetPermission(permissions.list, { preset: "tree", inherits: "list" }),
        operation: "getChildren",
        _tenantSlot: "list",
      },
    ],
    controllerOptions: {
      parentField,
    },
  };
}
