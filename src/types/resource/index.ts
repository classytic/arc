/**
 * Resource Types — everything about defining a resource.
 *
 * `ResourceConfig`, route + action shapes, JSON schemas, middleware
 * config, presets, hooks, events. Split into themed files; this barrel
 * preserves the original `types/resource` surface exactly.
 *
 * ## File map
 * - `./tenant.ts`     — `OnTenantDeleteConfig`, `ResolvedTenantPurge`
 * - `./cache.ts`      — `ResourceCacheConfig`
 * - `./rate-limit.ts` — `RateLimitConfig`
 * - `./fields.ts`     — `ArcFieldRule`, `FieldRule`
 * - `./schemas.ts`    — `RouteSchemaOptions`, `CrudSchemas`, `OpenApiSchemas`, `CrudRouteKey`, `MiddlewareConfig`
 * - `./routes.ts`     — `RouteDefinition`, `RouteMethod`, `RouteMcpConfig`
 * - `./actions.ts`    — `ActionDefinition`, `ActionsMap`, `ActionEntry`, `ActionHandlerFn`
 * - `./hooks.ts`      — `ResourceHooks`, `ResourceHookContext`
 * - `./presets.ts`    — `PresetResult`, `PresetHook`, `PresetFunction`
 * - `./events.ts`     — `EventDefinition`
 * - `./extensions.ts` — `ResourceExtensions` (plugin declaration-merge target)
 * - `./config.ts`     — `ResourceConfig`, `ResourcePermissions`, `CrudController`
 */

export type { ActionDefinition, ActionEntry, ActionHandlerFn, ActionsMap } from "./actions.js";
export type { ResourceCacheConfig } from "./cache.js";
export type { CrudController, ResourceConfig, ResourcePermissions } from "./config.js";
export type { EventDefinition } from "./events.js";
export type { ResourceExtensions } from "./extensions.js";
export type { ArcFieldRule, FieldRule } from "./fields.js";
export type { ResourceHookContext, ResourceHooks } from "./hooks.js";
export type { PresetFunction, PresetHook, PresetResult } from "./presets.js";
export type { RateLimitConfig } from "./rate-limit.js";
export type { RouteDefinition, RouteMcpConfig, RouteMethod } from "./routes.js";
export type {
  CrudRouteKey,
  CrudSchemas,
  MiddlewareConfig,
  OpenApiSchemas,
  RouteSchemaOptions,
} from "./schemas.js";
export type { OnTenantDeleteConfig, ResolvedTenantPurge } from "./tenant.js";
export type {
  MutationWriteContext,
  ResourceWrites,
  WriteContext,
  WriteVerbKey,
} from "./writes.js";
