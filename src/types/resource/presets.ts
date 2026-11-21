/**
 * Preset types — the hook/route/middleware bundle a preset contributes
 * to a resource, and the preset-function shape itself.
 */

import type { AnyRecord } from "../base.js";
import type { ControllerHandler } from "../handlers.js";
import type { ResourceConfig, ResourcePermissions } from "./config.js";
import type { RouteDefinition } from "./routes.js";
import type { MiddlewareConfig, RouteSchemaOptions } from "./schemas.js";

export interface PresetHook {
  operation: "create" | "update" | "delete" | "read" | "list";
  phase: "before" | "after";
  handler: (ctx: AnyRecord) => void | Promise<void> | AnyRecord | Promise<AnyRecord>;
  priority?: number;
}

/**
 * The resource's controller as a preset route builder sees it. `handler:
 * controller.getStats` runs the method on the real controller (`this`-bound) per
 * request, so the auto-built `BaseController` works too; a method read this way
 * is verified at boot. Name the methods you read: `PresetController<"getStats">`.
 */
export type PresetController<TMethod extends string = string> = {
  readonly [K in TMethod]: ControllerHandler;
};

export interface PresetResult {
  name: string;
  /**
   * Preset routes, merged into the resource's `routes`. The function form gets the
   * resource's permissions and its controller: `handler: controller.getStats`
   * (a method read this way is verified at boot).
   *
   * A string `handler`, string `rawHandler` or `controllerMethod` on a preset route
   * is deprecated like on a resource route: it warns once and is removed in the
   * next minor.
   */
  routes?:
    | RouteDefinition[]
    | ((permissions: ResourcePermissions, controller: PresetController) => RouteDefinition[]);
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
