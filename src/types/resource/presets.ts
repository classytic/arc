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
  schemaOptions?: RouteSchemaOptions;
  controllerOptions?: Record<string, unknown>;
  hooks?: PresetHook[];
}

export type PresetFunction = (config: ResourceConfig) => PresetResult;
