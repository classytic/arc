/**
 * @classytic/arc
 *
 * Resource-oriented backend framework for Fastify.
 * Supports MongoDB (Mongoose) and PostgreSQL/MySQL/SQLite (Prisma).
 *
 * @example MongoDB with Mongoose
 * ```typescript
 * import {
 *   defineResource,
 *   createMongooseAdapter,
 *   allowPublic,
 *   requireRoles,
 * } from '@classytic/arc';
 *
 * const productResource = defineResource({
 *   name: 'product',
 *   adapter: createMongooseAdapter({
 *     model: ProductModel,
 *     repository: productRepository,
 *   }),
 *   presets: ['softDelete', 'slugLookup'],
 *   permissions: {
 *     list: allowPublic(),
 *     get: allowPublic(),
 *     create: requireRoles(['admin']),
 *     update: requireRoles(['admin']),
 *     delete: requireRoles(['admin']),
 *   },
 * });
 *
 * await fastify.register(productResource.toPlugin());
 * ```
 *
 * @example PostgreSQL with Prisma
 * import { PrismaClient, Prisma } from '@prisma/client';
 * import { defineResource, createPrismaAdapter } from '@classytic/arc';
 *
 * const prisma = new PrismaClient();
 *
 * const userResource = defineResource({
 *   name: 'user',
 *   adapter: createPrismaAdapter({
 *     client: prisma,
 *     modelName: 'user',
 *     repository: userRepository,
 *     dmmf: Prisma.dmmf,
 *   }),
 * });
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

// Core
export {
  BaseController,
  createCrudRouter,
  createActionRouter,
  createOrgScopedMiddleware,
  createPermissionMiddleware,
  defineResource,
  ResourceDefinition,
  // Fastify adapter for framework-agnostic controllers
  createRequestContext,
  sendControllerResponse,
  createFastifyHandler,
  createCrudHandlers,
} from './core/index.js';
export type {
  BaseControllerOptions,
  ActionHandler,
  ActionRouterConfig,
  IdempotencyService,
} from './core/index.js';

/**
 * Note: Arc is database-agnostic
 *
 * Import Repository directly from your database kit:
 * - MongoDB: `import { Repository } from '@classytic/mongokit'`
 * - Prisma: `import { Repository } from '@classytic/prismakit'` (coming soon)
 *
 * Arc provides adapters (createMongooseAdapter, createPrismaAdapter) that work
 * with any repository implementing the CrudRepository interface.
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
  AuthConfig,
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

// Utils (commonly needed)
export {
  ArcError,
  NotFoundError,
  ValidationError,
  UnauthorizedError,
  ForbiddenError,
  createStateMachine,
} from './utils/index.js';
export type { StateMachine, TransitionConfig } from './utils/index.js';

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

// Hooks System
export {
  hookSystem,
  beforeCreate,
  afterCreate,
  beforeUpdate,
  afterUpdate,
  beforeDelete,
  afterDelete,
} from './hooks/index.js';

export type {
  HookPhase,
  HookOperation,
  HookContext,
  HookHandler,
  HookRegistration,
  HookSystem,
} from './hooks/index.js';

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
