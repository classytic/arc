/**
 * Plugin Option Types — graceful shutdown, request id, health,
 * introspection, CRUD router options.
 */

import type { RouteHandlerMethod } from "fastify";
import "./base.js";
import type {
  CrudRouteKey,
  CrudSchemas,
  MiddlewareConfig,
  RateLimitConfig,
  ResourcePermissions,
  RouteDefinition,
  RouteSchemaOptions,
} from "./resource.js";

export interface GracefulShutdownOptions {
  timeout?: number;
  onShutdown?: () => Promise<void> | void;
  signals?: NodeJS.Signals[];
  logEvents?: boolean;
}

export interface RequestIdOptions {
  headerName?: string;
  generator?: () => string;
}

export interface HealthOptions {
  path?: string;
  check?: () => Promise<unknown>;
}

export interface HealthCheck {
  healthy: boolean;
  timestamp: string;
  [key: string]: unknown;
}

export interface IntrospectionPluginOptions {
  path?: string;
  prefix?: string;
  enabled?: boolean;
  authRoles?: string[];
}

export interface CrudRouterOptions {
  /** Route prefix */
  prefix?: string;
  /** Permission checks for CRUD operations */
  permissions?: ResourcePermissions;
  /** OpenAPI tag for grouping routes */
  tag?: string;
  /** JSON schemas for CRUD operations */
  schemas?: Partial<CrudSchemas>;
  /** Middlewares for each CRUD operation */
  middlewares?: MiddlewareConfig;
  /** Custom routes (from presets or user-defined) */
  routes?: readonly RouteDefinition[];
  /** Disable all default CRUD routes */
  disableDefaultRoutes?: boolean;
  /** Disable specific CRUD routes */
  disabledRoutes?: CrudRouteKey[];
  /** Functional pipeline (guard/transform/intercept) */
  pipe?: import("../pipeline/types.js").PipelineConfig;
  /** Resource name for lifecycle hooks */
  resourceName?: string;
  /** Schema generation options */
  schemaOptions?: RouteSchemaOptions;
  /** Field-level permissions (visibility, writability per role) */
  fields?: import("../permissions/fields.js").FieldPermissionMap;
  /** HTTP method for update routes. Default: 'PATCH' */
  updateMethod?: "PUT" | "PATCH" | "both";
  /**
   * Per-resource rate limiting. Requires `@fastify/rate-limit` to be
   * registered. Set to `false` to disable for this resource.
   */
  rateLimit?: RateLimitConfig | false;
  /** PreHandler guards applied to every route (CRUD + custom + preset). */
  routeGuards?: RouteHandlerMethod[];
  /**
   * Resource's bound `idField` (`_id`, `slug`, `reportId`, …). Surfaces on
   * `req.arc.idField` for every CRUD route so handlers + middleware can
   * compose `findOne` filters via `getEntityQuery(req)` without
   * re-reading resource config. Defaults to `_id`.
   */
  idField?: string;
}
