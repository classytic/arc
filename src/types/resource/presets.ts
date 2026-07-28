/**
 * Preset types — the hook/route/middleware bundle a preset contributes
 * to a resource, and the preset-function shape itself.
 */

import type { AnyRecord } from "../base.js";
import type { ResourceConfig, ResourcePermissions } from "./config.js";
import type { RouteDefinition } from "./routes.js";
import type { MiddlewareConfig, RouteSchemaOptions } from "./schemas.js";

export interface PresetHook {
  operation: "create" | "update" | "delete" | "read" | "list";
  phase: "before" | "after";
  handler: (ctx: AnyRecord) => void | Promise<void> | AnyRecord | Promise<AnyRecord>;
  priority?: number;
}

export interface PresetResult {
  name: string;
  /** Preset routes — merged into the resource's `routes` array. */
  routes?: RouteDefinition[] | ((permissions: ResourcePermissions) => RouteDefinition[]);
  middlewares?: MiddlewareConfig;
  /**
   * Permission gates the preset contributes as SECURE DEFAULTS. Merged per-op
   * into the resource's `permissions`, but ONLY for operations the host has not
   * explicitly gated — the host's own permission always wins. Lets a preset make
   * authorization part of the permission/introspection model (required auth at
   * `onRequest`, MCP parity) instead of relying on middleware alone. Example:
   * `ownedByUser` injects `requireAuth()` on update/delete so an ownership
   * resource is never public-by-omission.
   */
  permissions?: Partial<ResourcePermissions>;
  schemaOptions?: RouteSchemaOptions;
  controllerOptions?: Record<string, unknown>;
  hooks?: PresetHook[];
}

export type PresetFunction = (config: ResourceConfig) => PresetResult;
