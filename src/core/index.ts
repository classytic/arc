/**
 * Core Module
 *
 * Base components for the Arc resource-oriented framework.
 */

export { BaseController } from './BaseController.js';
export type { BaseControllerOptions } from './BaseController.js';

// Composable classes extracted from BaseController
export { AccessControl } from './AccessControl.js';
export type { AccessControlConfig } from './AccessControl.js';
export { BodySanitizer } from './BodySanitizer.js';
export type { BodySanitizerConfig } from './BodySanitizer.js';
export { QueryResolver } from './QueryResolver.js';
export type { QueryResolverConfig } from './QueryResolver.js';

export {
  createCrudRouter,
  createPermissionMiddleware,
} from './createCrudRouter.js';

export { createActionRouter } from './createActionRouter.js';
export type { ActionHandler, ActionRouterConfig, IdempotencyService } from './createActionRouter.js';

export { defineResource, ResourceDefinition } from './defineResource.js';

// Constants — single source of truth for defaults and magic values
export * from '../constants.js';

// Fastify adapter for framework-agnostic controllers
export {
  createRequestContext,
  getControllerContext,
  getControllerScope,
  sendControllerResponse,
  createFastifyHandler,
  createCrudHandlers,
} from './fastifyAdapter.js';
