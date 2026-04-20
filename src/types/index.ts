/**
 * Arc Framework Types — facade re-exports.
 *
 * The barrel exists for back-compat with `import { … } from
 * '@classytic/arc/types'`. **Type-only** re-exports cost nothing at
 * runtime (TS erases them at compile time). Internal Arc code is
 * encouraged to import from the specific sub-file for clarity:
 *
 * ```typescript
 * // Preferred — explicit domain
 * import type { ResourceConfig } from '../types/resource.js';
 * import type { ParsedQuery } from '../types/query.js';
 *
 * // Allowed — facade for cross-domain or external imports
 * import type { ResourceConfig, ParsedQuery } from '../types/index.js';
 * ```
 *
 * ## File map
 * - `./base.ts`        — primitives, user shape, response envelope, Fastify decl-merge
 * - `./query.ts`       — request context, parsed query, query-parser interface
 * - `./fastify.ts`     — Fastify-specific shapes (RequestWithExtras, decorators)
 * - `./resource.ts`    — `ResourceConfig`, routes, actions, schemas, presets, hooks, events
 * - `./auth.ts`        — JWT context, authenticator, auth plugin options
 * - `./plugins.ts`     — plugin option types + `CrudRouterOptions`
 * - `./registry.ts`    — registry / introspection metadata
 * - `./validation.ts`  — config validation result types
 * - `./utility.ts`     — type-level inference helpers
 * - `./handlers.ts`    — controller / route handler shapes
 * - `./repository.ts`  — `CrudRepository`, pagination, write/delete results
 * - `./storage.ts`     — storage contract types
 */

// ──────────────────────────────────────────────────────────────────────
// Re-export Fastify primitives users commonly need
// ──────────────────────────────────────────────────────────────────────
export type { RouteHandlerMethod } from "fastify";

// ──────────────────────────────────────────────────────────────────────
// Scope — re-export the scope union + helpers (universal across handlers)
// ──────────────────────────────────────────────────────────────────────
export type { ElevationEvent, ElevationOptions } from "../scope/elevation.js";
export type { RequestScope } from "../scope/types.js";
export {
  AUTHENTICATED_SCOPE,
  getOrgId,
  getOrgRoles,
  getTeamId,
  hasOrgAccess,
  isAuthenticated,
  isElevated,
  isMember,
  PUBLIC_SCOPE,
} from "../scope/types.js";

// ──────────────────────────────────────────────────────────────────────
// Permissions — types only (functions live on `@classytic/arc/permissions`)
// ──────────────────────────────────────────────────────────────────────
export type {
  PermissionCheck,
  PermissionContext,
  PermissionResult,
  UserBase,
} from "../permissions/types.js";

// ──────────────────────────────────────────────────────────────────────
// Base — primitives, user shape, response envelope, ArcRequest
// (also installs the Fastify declaration merge)
// ──────────────────────────────────────────────────────────────────────
export type {
  AnyRecord,
  ApiResponse,
  ArcRequest,
  JWTPayload,
  ObjectId,
  UserLike,
  UserOrganization,
} from "./base.js";
export { envelope, getUserId } from "./base.js";

// ──────────────────────────────────────────────────────────────────────
// Query / Request context
// ──────────────────────────────────────────────────────────────────────
export type {
  ArcInternalMetadata,
  ControllerQueryOptions,
  LookupOption,
  OwnershipCheck,
  ParsedQuery,
  PopulateOption,
  QueryParserInterface,
  RequestContext,
  ServiceContext,
} from "./query.js";

// ──────────────────────────────────────────────────────────────────────
// Fastify-specific shapes
// ──────────────────────────────────────────────────────────────────────
export type {
  ArcDecorator,
  EventsDecorator,
  FastifyRequestExtras,
  FastifyWithAuth,
  FastifyWithDecorators,
  MiddlewareHandler,
  RequestWithExtras,
} from "./fastify.js";

// ──────────────────────────────────────────────────────────────────────
// Resource definition + routes + actions + schemas + presets + hooks + events
// ──────────────────────────────────────────────────────────────────────
export type {
  ActionDefinition,
  ActionEntry,
  ActionHandlerFn,
  ActionsMap,
  CrudController,
  CrudRouteKey,
  CrudSchemas,
  EventDefinition,
  FieldRule,
  MiddlewareConfig,
  OpenApiSchemas,
  PresetFunction,
  PresetHook,
  PresetResult,
  RateLimitConfig,
  ResourceCacheConfig,
  ResourceConfig,
  ResourceHookContext,
  ResourceHooks,
  ResourcePermissions,
  RouteDefinition,
  RouteMcpConfig,
  RouteMethod,
  RouteSchemaOptions,
} from "./resource.js";

// ──────────────────────────────────────────────────────────────────────
// Auth
// ──────────────────────────────────────────────────────────────────────
export type {
  Authenticator,
  AuthenticatorContext,
  AuthHelpers,
  AuthPluginOptions,
  JwtContext,
  TokenPair,
} from "./auth.js";

// ──────────────────────────────────────────────────────────────────────
// Plugins
// ──────────────────────────────────────────────────────────────────────
export type {
  CrudRouterOptions,
  GracefulShutdownOptions,
  HealthCheck,
  HealthOptions,
  IntrospectionPluginOptions,
  RequestIdOptions,
} from "./plugins.js";

// ──────────────────────────────────────────────────────────────────────
// Registry / introspection
// ──────────────────────────────────────────────────────────────────────
export type {
  IntrospectionData,
  RegistryEntry,
  RegistryStats,
  ResourceMetadata,
} from "./registry.js";

// ──────────────────────────────────────────────────────────────────────
// Validation
// ──────────────────────────────────────────────────────────────────────
export type { ConfigError, ValidateOptions, ValidationResult } from "./validation.js";

// ──────────────────────────────────────────────────────────────────────
// Type-level utilities
// ──────────────────────────────────────────────────────────────────────
export type {
  InferAdapterDoc,
  InferDocType,
  InferResourceDoc,
  TypedController,
  TypedRepository,
  TypedResourceConfig,
} from "./utility.js";

// ──────────────────────────────────────────────────────────────────────
// Handler / route shapes — kept in dedicated module
// ──────────────────────────────────────────────────────────────────────
export type {
  ControllerHandler,
  ControllerLike,
  FastifyHandler,
  IController,
  IControllerResponse,
  IRequestContext,
  RouteHandler,
} from "./handlers.js";

// ──────────────────────────────────────────────────────────────────────
// Pagination — discriminated union (arc-owned). The individual offset /
// keyset shapes ship from `@classytic/repo-core/pagination`; arc adds the
// union for BaseController's list/getDeleted return types.
//
// Kit contracts (`StandardRepo`, `QueryOptions`, `WriteOptions`, etc.)
// live in `@classytic/repo-core/repository` — import them directly from
// repo-core. Arc does not re-export them.
// ──────────────────────────────────────────────────────────────────────
export type { PaginationResult } from "./repository.js";

// ──────────────────────────────────────────────────────────────────────
// Base controller options — canonical definition lives in core/
// ──────────────────────────────────────────────────────────────────────
export type { BaseControllerOptions } from "../core/BaseController.js";
