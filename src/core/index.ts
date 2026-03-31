/**
 * Core Module
 *
 * Base components for the Arc resource-oriented framework.
 */

// Constants — single source of truth for defaults and magic values
export * from "../constants.js";
export type { AccessControlConfig } from "./AccessControl.js";

// Composable classes extracted from BaseController
export { AccessControl } from "./AccessControl.js";
export type { BaseControllerOptions } from "./BaseController.js";
export { BaseController } from "./BaseController.js";
export type { BodySanitizerConfig } from "./BodySanitizer.js";
export { BodySanitizer } from "./BodySanitizer.js";
export type {
  ActionHandler,
  ActionRouterConfig,
  IdempotencyService,
} from "./createActionRouter.js";
export { createActionRouter } from "./createActionRouter.js";
export {
  createCrudRouter,
  createPermissionMiddleware,
} from "./createCrudRouter.js";
export { defineResource, ResourceDefinition } from "./defineResource.js";
// Fastify adapter for framework-agnostic controllers
export {
  createCrudHandlers,
  createFastifyHandler,
  createRequestContext,
  getControllerContext,
  getControllerScope,
  sendControllerResponse,
} from "./fastifyAdapter.js";
export type { QueryResolverConfig } from "./QueryResolver.js";
export { QueryResolver } from "./QueryResolver.js";
