/**
 * @classytic/arc
 *
 * Resource-oriented backend framework for Fastify.
 * Supports MongoDB (Mongoose) and PostgreSQL/MySQL/SQLite (Prisma).
 *
 * ## Import Strategy (Tree-Shaking)
 *
 * This main entry exports commonly-used items. For better tree-shaking,
 * import from specific subpaths when needed:
 *
 * ```typescript
 * // Main entry - common items
 * import { defineResource, createMongooseAdapter, allowPublic } from '@classytic/arc';
 *
 * // Subpath imports - specialized modules
 * import { createTestApp } from '@classytic/arc/testing';
 * import { createApp } from '@classytic/arc/factory';
 * import { PrismaQueryParser } from '@classytic/arc/adapters';
 * import { beforeCreate, afterUpdate } from '@classytic/arc/hooks';
 * import { MemoryEventTransport } from '@classytic/arc/events';
 * import { createStateMachine } from '@classytic/arc/utils';
 * ```
 *
 * ## Subpath Exports
 *
 * | Subpath | Purpose |
 * |---------|---------|
 * | `@classytic/arc/testing` | Test utilities, mocks, TestHarness |
 * | `@classytic/arc/factory` | App creation (createApp, ArcFactory) |
 * | `@classytic/arc/adapters` | Database adapters + PrismaQueryParser |
 * | `@classytic/arc/permissions` | Permission functions |
 * | `@classytic/arc/presets` | Preset functions |
 * | `@classytic/arc/hooks` | Hook helpers (beforeCreate, etc.) |
 * | `@classytic/arc/events` | Event transports |
 * | `@classytic/arc/plugins` | Fastify plugins |
 * | `@classytic/arc/utils` | Utilities (state machine, etc.) |
 * | `@classytic/arc/org` | Organization utilities |
 * | `@classytic/arc/audit` | Audit trail |
 * | `@classytic/arc/idempotency` | Idempotency stores |
 * | `@classytic/arc/types` | TypeScript types |
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
 *   auth: { jwt: { secret: process.env.JWT_SECRET } },
 *   plugins: async (fastify) => {
 *     await fastify.register(productResource.toPlugin());
 *   },
 * });
 * ```
 */

// Adapters (database abstraction)
export {
  MongooseAdapter,
  createMongooseAdapter,
  PrismaAdapter,
  createPrismaAdapter,
} from './adapters/index.js';
export type {
  DataAdapter,
  SchemaMetadata,
  FieldMetadata,
  RelationMetadata,
  ValidationResult as AdapterValidationResult,
  MongooseAdapterOptions,
  PrismaAdapterOptions,
  RepositoryLike,
} from './adapters/index.js';

// Core - Essential exports only
// For internal/advanced APIs, use: import { ... } from '@classytic/arc/core'
export {
  BaseController,
  defineResource,
  ResourceDefinition,
} from './core/index.js';
export type {
  BaseControllerOptions,
} from './core/index.js';

/**
 * Note: Arc is database-agnostic
 *
 * Import Repository directly from your database kit:
 * - MongoDB: `import { Repository } from '@classytic/mongokit'`
 *
 * Arc provides adapters (createMongooseAdapter, createPrismaAdapter) that work
 * with any repository implementing the CrudRepository interface.
 *
 * Note: PrismaAdapter is experimental - schema generation only.
 */

// Types - Re-export all types for convenience
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
  OrgScopeOptions,
  IntrospectionPluginOptions,
  CrudRouterOptions,
  // Utility types for better type inference
  InferDocType,
  InferResourceDoc,
  TypedResourceConfig,
  TypedController,
  TypedRepository,
} from './types/index.js';

// Re-export commonly used modules for convenience
// (Users can also import directly from subpaths)

// Utils - Error classes (commonly needed)
// For additional utilities, use: import { ... } from '@classytic/arc/utils'
export {
  ArcError,
  NotFoundError,
  ValidationError,
  UnauthorizedError,
  ForbiddenError,
} from './utils/index.js';

// Registry (commonly needed)
export { resourceRegistry } from './registry/index.js';

// Validation
export {
  validateResourceConfig,
  formatValidationErrors,
  assertValidConfig,
} from './core/validateResourceConfig.js';
export type {
  ConfigError,
  ValidationResult,
  ValidateOptions,
  HealthCheck,
  HealthOptions,
  GracefulShutdownOptions,
  RequestIdOptions,
} from './types/index.js';

// Production Plugins (commonly needed)
export {
  requestIdPlugin,
  healthPlugin,
  gracefulShutdownPlugin,
} from './plugins/index.js';

// Hooks System - Essential exports only
// For hook helpers (beforeCreate, afterUpdate, etc.), use: import { ... } from '@classytic/arc/hooks'
export { hookSystem } from './hooks/index.js';
export type { HookContext, HookHandler, HookSystem } from './hooks/index.js';

// Event System - Essential exports only
// For additional event utilities, use: import { ... } from '@classytic/arc/events'
export { eventPlugin } from './events/index.js';
export type { DomainEvent, EventHandler } from './events/index.js';

// Permission System - Clean function-based permissions
export {
  allowPublic,
  requireAuth,
  requireRoles,
  requireOwnership,
  allOf,
  anyOf,
  denyAll,
  when,
} from './permissions/index.js';

export type {
  PermissionCheck,
  PermissionContext,
  PermissionResult,
} from './permissions/index.js';

// Factory (production-ready app creation)
export { createApp, ArcFactory } from './factory/index.js';
export type { CreateAppOptions } from './factory/index.js';

// Version (for programmatic access)
export const version = '1.0.0';
