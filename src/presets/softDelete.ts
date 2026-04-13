/**
 * Soft Delete Preset
 *
 * Adds routes for listing deleted items and restoring them.
 * The actual soft-delete behavior (deletedAt field, query filtering)
 * is handled by the repository/adapter layer (e.g., MongoKit's softDelete plugin).
 */

import { requireRoles } from "../permissions/index.js";
import type { PresetResult, ResourcePermissions, RouteDefinition } from "../types/index.js";

export function softDeletePreset(): PresetResult {
  return {
    name: "softDelete",
    routes: (permissions: ResourcePermissions): RouteDefinition[] => [
      {
        method: "GET",
        path: "/deleted",
        handler: "getDeleted",
        summary: "Get soft-deleted items",
        permissions: permissions.list ?? requireRoles(["admin"]),
        operation: "listDeleted",
      },
      {
        method: "POST",
        path: "/:id/restore",
        handler: "restore",
        summary: "Restore soft-deleted item",
        permissions: permissions.update ?? requireRoles(["admin"]),
        operation: "restore",
      },
    ],
  };
}
