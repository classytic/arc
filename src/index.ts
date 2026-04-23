/**
 * @classytic/arc
 *
 * Resource-oriented backend framework for Fastify.
 * Production-ready MongoDB support is provided via MongoKit.
 * Prisma/PostgreSQL/MySQL/SQLite adapter support is available as experimental
 * bring-your-own-repository integration via Arc's DataAdapter interface.
 *
 * ## Import Strategy (Tree-Shaking)
 *
 * This main entry exports ONLY the essentials for defining resources.
 * All other features live in dedicated subpaths — Node.js does NOT
 * tree-shake, so barrel re-exports load eagerly at runtime.
 *
 * ```typescript
 * // Main entry — resource definition + permissions + errors
 * import { defineResource, createMongooseAdapter, allowPublic } from '@classytic/arc';
 *
 * // Everything else from dedicated subpaths:
 * import { createApp } from '@classytic/arc/factory';
 * import { createTestApp } from '@classytic/arc/testing';
 * import { eventPlugin } from '@classytic/arc/events';
 * import { beforeCreate } from '@classytic/arc/hooks';
 * import { healthPlugin } from '@classytic/arc/plugins';
 * import { RedisEventTransport } from '@classytic/arc/events/redis';
 * import { tracingPlugin } from '@classytic/arc/plugins/tracing';
 * import { auditPlugin } from '@classytic/arc/audit';
 * // audit accepts a RepositoryLike directly — no adapter import needed
 * ```
 *
 * ## Subpath Exports
 *
 * | Subpath | Purpose |
 * |---------|---------|
 * | `@classytic/arc` | Core: defineResource, adapters, permissions, errors |
 * | `@classytic/arc/factory` | App creation (createApp, ArcFactory) |
 * | `@classytic/arc/permissions` | Permission functions (also in main) |
 * | `@classytic/arc/adapters` | Database adapters + PrismaQueryParser |
 * | `@classytic/arc/presets` | Preset functions (softDelete, tree, etc.) |
 * | `@classytic/arc/hooks` | Hook helpers (beforeCreate, afterUpdate) |
 * | `@classytic/arc/middleware` | Middleware helpers (multipartBody, named/priority middleware) |
 * | `@classytic/arc/pipeline` | Functional guard / intercept / pipe / transform |
 * | `@classytic/arc/context` | AsyncLocalStorage request context |
 * | `@classytic/arc/logger` | Internal debug/warning logger (arcLog) |
 * | `@classytic/arc/events` | Event bus (MemoryTransport only) |
 * | `@classytic/arc/events/redis` | Redis Pub/Sub transport (requires ioredis) |
 * | `@classytic/arc/events/redis-stream` | Redis Streams transport (requires ioredis) |
 * | `@classytic/arc/plugins` | Fastify plugins (health, requestId, etc.) |
 * | `@classytic/arc/plugins/tracing` | OpenTelemetry tracing (requires @opentelemetry/*) |
 * | `@classytic/arc/audit` | Audit trail — accepts any `RepositoryLike` directly |
 * | `@classytic/arc/idempotency` | Idempotency — accepts any `RepositoryLike` directly |
 * | `@classytic/arc/idempotency/redis` | Redis idempotency store (non-repository backend) |
 * | `@classytic/arc/utils` | Utilities (errors, state machine, circuit breaker) |
 * | `@classytic/arc/org` | Organization/multi-tenant |
 * | `@classytic/arc/auth` | Authentication (JWT, Better Auth) |
 * | `@classytic/arc/testing` | Test utilities, mocks, TestHarness |
 * | `@classytic/arc/schemas` | TypeBox schema helpers |
 * | `@classytic/arc/types` | TypeScript types only |
 * | `@classytic/arc/discovery` | Auto-discovery plugin |
 * | `@classytic/arc/integrations/streamline` | @classytic/streamline adapter |
 * | `@classytic/arc/integrations/websocket` | @fastify/websocket adapter |
 * | `@classytic/arc/integrations/jobs` | BullMQ job queue adapter |
 *
 * @example Basic Resource
 * ```typescript
 * import { defineResource, createMongooseAdapter, allowPublic, requireRoles } from '@classytic/arc';
 *
 * const productResource = defineResource({
 *   name: 'product',
 *   adapter: createMongooseAdapter({ model: ProductModel, repository: productRepo }),
 *   permissions: {
 *     list: allowPublic(),
 *     create: requireRoles(['admin']),
 *   },
 * });
 * ```
 *
 * @example Full Application
 * ```typescript
 * import { createApp } from '@classytic/arc/factory';
 * import { productResource } from './modules/product.resource.js';
 *
 * const app = await createApp({
 *   preset: 'production',
 *   auth: { type: 'jwt', jwt: { secret: process.env.JWT_SECRET } },
 *   plugins: async (fastify) => {
 *     await fastify.register(productResource.toPlugin());
 *   },
 * });
 * ```
 */

export type {
  DataAdapter,
  FieldMetadata,
  RelationMetadata,
  RepositoryLike,
  SchemaMetadata,
  ValidationResult as AdapterValidationResult,
} from "./adapters/index.js";
// ============================================================================
// Adapters (database abstraction — zero external deps at this level)
// ============================================================================
export {
  createMongooseAdapter,
  createPrismaAdapter,
  MongooseAdapter,
  PrismaAdapter,
} from "./adapters/index.js";

// Note: MongooseAdapterOptions and PrismaAdapterOptions are NOT re-exported
// from the root barrel to avoid pulling mongoose/prisma types into consumers
// who don't use those adapters. Import from '@classytic/arc/adapters' instead.

export type { BaseControllerOptions, ListResult } from "./core/index.js";
// ============================================================================
// Core — defineResource, controller split (v2.11.0)
// ============================================================================
export {
  BaseController,
  BaseCrudController,
  BulkMixin,
  defineResource,
  defineResourceVariants,
  getControllerScope,
  ResourceDefinition,
  SlugMixin,
  SoftDeleteMixin,
  TreeMixin,
} from "./core/index.js";
// Mixin extension interfaces — useful when typing custom mixin compositions
export type { BulkExt, SlugExt, SoftDeleteExt, TreeExt } from "./core/index.js";

/**
 * Note: Arc is database-agnostic
 *
 * Import Repository directly from your database kit:
 * - MongoDB: `import { Repository } from '@classytic/mongokit'`
 *
 * Arc provides adapters (createMongooseAdapter, createPrismaAdapter) that work
 * with any repository implementing the `StandardRepo` contract from `@classytic/repo-core`.
 */

// ============================================================================
// Constants — single source of truth for defaults and magic values (zero deps).
// Explicit named re-exports (v2.11.0) — no `export *` so the barrel surface
// is auditable and future internal-only constants don't leak implicitly.
// ============================================================================
export {
  CRUD_OPERATIONS,
  DEFAULT_ID_FIELD,
  DEFAULT_LIMIT,
  DEFAULT_MAX_LIMIT,
  DEFAULT_SORT,
  DEFAULT_TENANT_FIELD,
  DEFAULT_UPDATE_METHOD,
  HOOK_OPERATIONS,
  HOOK_PHASES,
  MAX_FILTER_DEPTH,
  MAX_REGEX_LENGTH,
  MAX_SEARCH_LENGTH,
  MUTATION_OPERATIONS,
  RESERVED_QUERY_PARAMS,
  SYSTEM_FIELDS,
} from "./constants.js";
export type {
  CrudOperation,
  HookOperation,
  HookPhase,
  MutationOperation,
} from "./constants.js";

// ============================================================================
// Validation — resource config validation. Relocated to `@classytic/arc/utils`
// in v2.11.0 (dev tooling, not runtime essentials). Removed from root barrel
// to enforce the "root = essentials only" policy.
// ============================================================================
export type {
  DynamicPermissionMatrix,
  DynamicPermissionMatrixConfig,
  FieldPermission,
  FieldPermissionMap,
  PermissionCheck,
  PermissionContext,
  PermissionResult,
} from "./permissions/index.js";
// ============================================================================
// Permission System — commonly used with defineResource (pure functions)
// ============================================================================
export {
  adminOnly,
  allOf,
  // Low-level permission helpers
  allowPublic,
  anyOf,
  applyFieldReadPermissions,
  applyFieldWritePermissions,
  authenticated,
  createDynamicPermissionMatrix,
  createOrgPermissions,
  denyAll,
  // Field-level permissions
  fields,
  fullPublic,
  ownerWithAdminBypass,
  // Permission presets (common patterns in one call)
  permissions,
  publicRead,
  publicReadAdminWrite,
  readOnly,
  requireAuth,
  // Parent-child org hierarchy (holding → subsidiary → branch, MSP, white-label)
  requireOrgInScope,
  // Organization permissions
  requireOrgMembership,
  requireOrgRole,
  requireOwnership,
  requireRoles,
  // App-defined scope dimensions (branch, project, region, workspace, ...)
  requireScopeContext,
  // Service / API key scopes (OAuth-style)
  requireServiceScope,
  requireTeamMembership,
  when,
} from "./permissions/index.js";
// ============================================================================
// Types — re-export all types (zero runtime cost, eliminated at compile time)
// ============================================================================
export type {
  // Base types
  AnyRecord,
  ApiResponse,
  ArcInternalMetadata,
  // User & Auth / DX helpers
  ArcRequest,
  // Plugin options
  AuthPluginOptions,
  ConfigError,
  ControllerLike,
  CrudController,
  CrudRouteKey,
  CrudRouterOptions,
  CrudSchemas,
  EventDefinition,
  FastifyRequestExtras,
  FastifyWithAuth,
  FastifyWithDecorators,
  FieldRule,
  GracefulShutdownOptions,
  HealthCheck,
  HealthOptions,
  IController,
  IControllerResponse,
  InferAdapterDoc,
  // Utility types for better type inference
  InferDocType,
  InferResourceDoc,
  IntrospectionData,
  IntrospectionPluginOptions,
  // Framework-agnostic controller types (MongoKit-compatible)
  IRequestContext,
  JWTPayload,
  MiddlewareConfig,
  OwnershipCheck,
  // Pagination discriminated union (arc-owned; individual shapes ship from repo-core)
  PaginationResult,
  PresetFunction,
  // Presets
  PresetResult,
  // Query parser contract — surfaced at the root so callers can annotate
  // `queryParser: QueryParserInterface` without reaching into
  // `@classytic/arc/types`. Also works around the alias-chain ergonomics
  // issue where type-only re-exports couldn't be picked up by some
  // bundlers without the direct root export.
  QueryParserInterface,
  RateLimitConfig,
  // Registry
  RegistryEntry,
  RegistryStats,
  // Request context
  RequestContext,
  RequestIdOptions,
  RequestWithExtras,
  // Resource
  ResourceConfig,
  ResourceMetadata,
  // Controller
  RouteHandler,
  RouteHandlerMethod,
  // Schema
  RouteSchemaOptions,
  // Service & Repository
  ServiceContext,
  TypedController,
  TypedRepository,
  TypedResourceConfig,
  UserBase,
  UserOrganization,
  ValidateOptions,
  ValidationResult,
} from "./types/index.js";
// DX helpers (v2.11.0: relocated to `/utils` as part of the `/types`
// type-only cleanup — root re-exports for DX).
export { envelope, getUserId } from "./utils/index.js";
// ============================================================================
// Errors — commonly needed alongside defineResource (zero deps, pure classes)
// ============================================================================
export {
  ArcError,
  createDomainError,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
} from "./utils/errors.js";
// handleRaw lives on @classytic/arc/utils only — not re-exported from root to preserve tree-shaking

// ============================================================================
// MOVED TO DEDICATED SUBPATHS (no longer re-exported from main barrel)
// ============================================================================
//
// These were previously re-exported here but barrel re-exports hurt tree-shaking.
// Import from their dedicated subpaths instead:
//
// Factory (pulls in security plugins):
//   import { createApp, ArcFactory } from '@classytic/arc/factory';
//
// Plugins (each plugin is self-contained):
//   import { healthPlugin } from '@classytic/arc/plugins';
//   import { tracingPlugin } from '@classytic/arc/plugins/tracing';
//
// Hooks (HookSystem):
//   import { createHookSystem, HookSystem } from '@classytic/arc/hooks';
//
// Events (eventPlugin + transports):
//   import { eventPlugin } from '@classytic/arc/events';
//   import { RedisEventTransport } from '@classytic/arc/events/redis';
//
// Registry:
//   import { ResourceRegistry } from '@classytic/arc/registry';
//
// Request Context (AsyncLocalStorage):
//   import { requestContext, type RequestStore } from '@classytic/arc/context';
//
// Middleware (multipartBody, named middleware):
//   import { multipartBody, middleware, sortMiddlewares } from '@classytic/arc/middleware';
//
// Pipeline (guard, intercept, pipe, transform):
//   import { guard, intercept, pipe, transform } from '@classytic/arc/pipeline';
//
// Logger (arcLog, configureArcLogger):
//   import { arcLog, configureArcLogger } from '@classytic/arc/logger';

// Version from package.json (injected at build time via tsdown define)
// Replaced at build time by tsdown `define` option.
// Falls back to 'dev' when running from source (tests, tsx).
export const version: string = typeof __ARC_VERSION__ !== "undefined" ? __ARC_VERSION__ : "dev";
declare const __ARC_VERSION__: string;
