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
 * import { MongoAuditStore } from '@classytic/arc/audit/mongodb';
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
 * | `@classytic/arc/events` | Event bus (MemoryTransport only) |
 * | `@classytic/arc/events/redis` | Redis Pub/Sub transport (requires ioredis) |
 * | `@classytic/arc/events/redis-stream` | Redis Streams transport (requires ioredis) |
 * | `@classytic/arc/plugins` | Fastify plugins (health, requestId, etc.) |
 * | `@classytic/arc/plugins/tracing` | OpenTelemetry tracing (requires @opentelemetry/*) |
 * | `@classytic/arc/audit` | Audit trail (MemoryStore only) |
 * | `@classytic/arc/audit/mongodb` | MongoDB audit store (requires mongoose) |
 * | `@classytic/arc/idempotency` | Idempotency (MemoryStore only) |
 * | `@classytic/arc/idempotency/redis` | Redis idempotency store (requires ioredis) |
 * | `@classytic/arc/idempotency/mongodb` | MongoDB idempotency store (requires mongoose) |
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

// ============================================================================
// Adapters (database abstraction — zero external deps at this level)
// ============================================================================
export {
  MongooseAdapter,
  createMongooseAdapter,
  PrismaAdapter,
  createPrismaAdapter,
} from "./adapters/index.js";
export type {
  DataAdapter,
  SchemaMetadata,
  FieldMetadata,
  RelationMetadata,
  ValidationResult as AdapterValidationResult,
  MongooseAdapterOptions,
  PrismaAdapterOptions,
  RepositoryLike,
} from "./adapters/index.js";

// ============================================================================
// Core — defineResource, BaseController
// ============================================================================
export {
  BaseController,
  defineResource,
  ResourceDefinition,
  getControllerScope,
} from "./core/index.js";
export type { BaseControllerOptions } from "./core/index.js";

/**
 * Note: Arc is database-agnostic
 *
 * Import Repository directly from your database kit:
 * - MongoDB: `import { Repository } from '@classytic/mongokit'`
 *
 * Arc provides adapters (createMongooseAdapter, createPrismaAdapter) that work
 * with any repository implementing the CrudRepository interface.
 */

// ============================================================================
// Types — re-export all types (zero runtime cost, eliminated at compile time)
// ============================================================================
export type {
  // Base types
  AnyRecord,
  PaginatedResult,
  ApiResponse,
  // Framework-agnostic controller types (MongoKit-compatible)
  IRequestContext,
  IControllerResponse,
  IController,
  ControllerLike,
  // User & Auth
  UserBase,
  UserOrganization,
  JWTPayload,
  // Request context
  RequestContext,
  ArcInternalMetadata,
  OwnershipCheck,
  FastifyRequestExtras,
  RequestWithExtras,
  FastifyWithAuth,
  FastifyWithDecorators,
  RouteHandlerMethod,
  // Service & Repository
  ServiceContext,
  QueryOptions,
  CrudRepository,
  // Controller
  RouteHandler,
  CrudController,
  CrudRouteKey,
  // Schema
  RouteSchemaOptions,
  FieldRule,
  CrudSchemas,
  // Routes
  AdditionalRoute,
  MiddlewareConfig,
  // Presets
  PresetResult,
  PresetFunction,
  // Resource
  ResourceConfig,
  EventDefinition,
  ResourceMetadata,
  // Registry
  RegistryEntry,
  RegistryStats,
  IntrospectionData,
  // Plugin options
  AuthPluginOptions,
  IntrospectionPluginOptions,
  CrudRouterOptions,
  RateLimitConfig,
  ConfigError,
  ValidationResult,
  ValidateOptions,
  HealthCheck,
  HealthOptions,
  GracefulShutdownOptions,
  RequestIdOptions,
  // Utility types for better type inference
  InferDocType,
  InferAdapterDoc,
  InferResourceDoc,
  TypedResourceConfig,
  TypedController,
  TypedRepository,
} from "./types/index.js";

// ============================================================================
// Constants — single source of truth for defaults and magic values (zero deps)
// ============================================================================
export * from "./constants.js";

// ============================================================================
// Errors — commonly needed alongside defineResource (zero deps, pure classes)
// ============================================================================
export {
  ArcError,
  NotFoundError,
  ValidationError,
  UnauthorizedError,
  ForbiddenError,
} from "./utils/errors.js";

// ============================================================================
// Validation — resource config validation (zero deps, pure functions)
// ============================================================================
export {
  validateResourceConfig,
  formatValidationErrors,
  assertValidConfig,
} from "./core/validateResourceConfig.js";

// ============================================================================
// Permission System — commonly used with defineResource (pure functions)
// ============================================================================
export {
  // Permission presets (common patterns in one call)
  permissions,
  publicRead,
  publicReadAdminWrite,
  authenticated,
  adminOnly,
  ownerWithAdminBypass,
  fullPublic,
  readOnly,
  // Low-level permission helpers
  allowPublic,
  requireAuth,
  requireRoles,
  requireOwnership,
  allOf,
  anyOf,
  denyAll,
  when,
  // Organization permissions
  requireOrgMembership,
  requireOrgRole,
  createOrgPermissions,
  createDynamicPermissionMatrix,
  requireTeamMembership,
  // Field-level permissions
  fields,
  applyFieldReadPermissions,
  applyFieldWritePermissions,
} from "./permissions/index.js";

export type {
  PermissionCheck,
  PermissionContext,
  PermissionResult,
  DynamicPermissionMatrixConfig,
  DynamicPermissionMatrix,
  FieldPermission,
  FieldPermissionMap,
} from "./permissions/index.js";

// ============================================================================
// Pipeline — functional guard/transform/intercept (zero deps, pure functions)
// ============================================================================
export { guard, transform, intercept, pipe } from "./pipeline/index.js";
export type {
  PipelineContext,
  PipelineStep,
  PipelineConfig,
  Guard,
  Transform,
  Interceptor,
} from "./pipeline/index.js";

// ============================================================================
// Middleware — named, priority-based (zero deps, pure functions)
// ============================================================================
export { middleware, sortMiddlewares } from "./middleware/index.js";
export type { NamedMiddleware } from "./middleware/index.js";

// ============================================================================
// Request Context — AsyncLocalStorage (zero deps)
// ============================================================================
export { requestContext } from "./context/index.js";
export type { RequestStore } from "./context/index.js";

// ============================================================================
// MOVED TO DEDICATED SUBPATHS (no longer re-exported from main barrel)
// ============================================================================
//
// These were previously re-exported here but pulled in heavy dependencies.
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

// ============================================================================
// Logger — centralized debug/warning system (zero deps)
// ============================================================================
export { configureArcLogger, arcLog } from "./logger/index.js";
export type { ArcLoggerOptions, ArcLogWriter, ArcLogger } from "./logger/index.js";

// Version from package.json (injected at build time via tsdown define)
export const version: string = "__ARC_VERSION__";
