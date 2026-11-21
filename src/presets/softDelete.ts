/**
 * Soft Delete Preset
 *
 * Adds routes for listing deleted items and restoring them.
 * The actual soft-delete behavior (deletedAt field, query filtering)
 * is handled by the repository/adapter layer (e.g., MongoKit's softDelete plugin).
 */

import { requireRoles } from "../permissions/index.js";
import type {
  PresetController,
  PresetResult,
  ResourcePermissions,
  RouteDefinition,
} from "../types/index.js";

export function softDeletePreset(): PresetResult {
  // `_presetSource` is an internal marker the MCP layer reads to
  // attribute tool origins ("preset:softDelete vs user-authored route").
  // Carried as a sidecar field so it doesn't change RouteDefinition's
  // public surface; collision diagnostics in `createMcpServer.ts` use
  // it to auto-namespace preset routes around user `actions.restore`
  // instead of crashing the boot. Routes are runtime-frozen after
  // `defineResource` so the field is set once at preset-emit time.
  return {
    name: "softDelete",
    routes: (
      permissions: ResourcePermissions,
      controller: PresetController<"getDeleted" | "restore">,
    ): RouteDefinition[] => [
      {
        method: "GET",
        path: "/deleted",
        handler: controller.getDeleted,
        summary: "Get soft-deleted items",
        permissions: permissions.list ?? requireRoles(["admin"]),
        operation: "listDeleted",
        _tenantSlot: "list",
        _presetSource: "softDelete",
      },
      {
        method: "POST",
        path: "/:id/restore",
        handler: controller.restore,
        summary: "Restore soft-deleted item",
        permissions: permissions.update ?? requireRoles(["admin"]),
        operation: "restore",
        _tenantSlot: "update",
        _presetSource: "softDelete",
      },
    ],
  };
}
