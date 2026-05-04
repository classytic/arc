/**
 * Bulk Operations Preset
 *
 * Adds bulk CRUD routes to a resource:
 * - POST   /{resource}/bulk   → bulkCreate
 * - PATCH  /{resource}/bulk   → bulkUpdate
 * - DELETE /{resource}/bulk   → bulkDelete
 *
 * Permissions inherit from the resource's create/update/delete permissions.
 * Handlers delegate to BaseController.bulkCreate/bulkUpdate/bulkDelete,
 * which call the repository's createMany/updateMany/deleteMany.
 *
 * DB-agnostic — works with any repository that provides these methods.
 * MongoKit provides them via batchOperationsPlugin.
 *
 * @example
 * ```typescript
 * defineResource({
 *   name: 'product',
 *   adapter: createMongooseAdapter({ model, repository }),
 *   presets: ['bulk'],
 * });
 * // Adds: POST /products/bulk, PATCH /products/bulk, DELETE /products/bulk
 * ```
 */

import { requireAuth } from "../permissions/index.js";
import type { PresetResult, ResourcePermissions, RouteDefinition } from "../types/index.js";

// ============================================================================
// Types
// ============================================================================

export type BulkOperation = "createMany" | "updateMany" | "deleteMany";

export interface BulkPresetOptions {
  /** Which bulk operations to enable (default: all three) */
  operations?: BulkOperation[];
  /** Max items per bulk create (default: 1000) */
  maxCreateItems?: number;
}

// ============================================================================
// Preset Factory
// ============================================================================

export function bulkPreset(opts?: BulkPresetOptions): PresetResult {
  const operations = opts?.operations ?? ["createMany", "updateMany", "deleteMany"];
  const maxCreateItems = opts?.maxCreateItems ?? 1000;

  return {
    name: "bulk",
    routes: (permissions: ResourcePermissions): RouteDefinition[] => {
      const routes: RouteDefinition[] = [];

      if (operations.includes("createMany")) {
        routes.push({
          method: "POST",
          path: "/bulk",
          handler: "bulkCreate",
          operation: "bulkCreate",
          summary: "Create multiple items",
          permissions: permissions.create ?? requireAuth(),
          schema: {
            body: {
              type: "object",
              properties: {
                items: { type: "array", maxItems: maxCreateItems, minItems: 1 },
              },
              required: ["items"],
            },
            // No-envelope contract: bulkCreate emits the inserted docs as a
            // bare array at the top level. No success/data wrapper.
            response: {
              201: { type: "array" },
            },
          },
        });
      }

      if (operations.includes("updateMany")) {
        routes.push({
          method: "PATCH",
          path: "/bulk",
          handler: "bulkUpdate",
          operation: "bulkUpdate",
          summary: "Update multiple items matching filter",
          permissions: permissions.update ?? requireAuth(),
          schema: {
            body: {
              type: "object",
              properties: {
                filter: { type: "object" },
                data: { type: "object" },
              },
              required: ["filter", "data"],
            },
            // No-envelope contract: bulkUpdate emits the result counts raw.
            response: {
              200: {
                type: "object",
                properties: {
                  matchedCount: { type: "number" },
                  modifiedCount: { type: "number" },
                },
              },
            },
          },
        });
      }

      if (operations.includes("deleteMany")) {
        routes.push({
          method: "DELETE",
          path: "/bulk",
          handler: "bulkDelete",
          operation: "bulkDelete",
          summary: "Delete multiple items matching filter",
          permissions: permissions.delete ?? requireAuth(),
          schema: {
            body: {
              type: "object",
              properties: {
                filter: { type: "object" },
              },
              required: ["filter"],
            },
            // No-envelope contract: bulkDelete emits the count raw.
            response: {
              200: {
                type: "object",
                properties: { deletedCount: { type: "number" } },
              },
            },
          },
        });
      }

      return routes;
    },
  };
}
