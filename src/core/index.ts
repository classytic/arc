/**
 * Core Module
 *
 * Base components for the Arc resource-oriented framework.
 */

export { BaseController } from './BaseController.js';
export type { BaseControllerOptions } from './BaseController.js';

export {
  createCrudRouter,
  createOrgScopedMiddleware,
  createPermissionMiddleware,
} from './createCrudRouter.js';

export { createActionRouter } from './createActionRouter.js';
export type { ActionHandler, ActionRouterConfig, IdempotencyService } from './createActionRouter.js';

export { defineResource, ResourceDefinition } from './defineResource.js';

// Fastify adapter for framework-agnostic controllers
export {
  createRequestContext,
  sendControllerResponse,
  createFastifyHandler,
  createCrudHandlers,
} from './fastifyAdapter.js';
