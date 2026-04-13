/**
 * Utils Module
 *
 * Common utilities for the Arc framework.
 */

export type { CircuitBreakerOptions, CircuitBreakerStats } from "./circuitBreaker.js";
// Circuit Breaker
export {
  CircuitBreaker,
  CircuitBreakerError,
  CircuitBreakerRegistry,
  CircuitState,
  createCircuitBreaker,
  createCircuitBreakerRegistry,
} from "./circuitBreaker.js";
// Compensating Transaction
export type {
  CompensationDefinition,
  CompensationError,
  CompensationHooks,
  CompensationResult,
  CompensationStep,
} from "./compensation.js";
export { defineCompensation, withCompensation } from "./compensation.js";
// Typed route guard helper
export type { Guard, GuardConfig } from "./defineGuard.js";
export { defineGuard } from "./defineGuard.js";
export type { ErrorDetails } from "./errors.js";
// Errors
export {
  ArcError,
  ConflictError,
  createDomainError,
  createError,
  ForbiddenError,
  isArcError,
  NotFoundError,
  OrgAccessDeniedError,
  OrgRequiredError,
  RateLimitError,
  ServiceUnavailableError,
  UnauthorizedError,
  ValidationError,
} from "./errors.js";
// Raw handler wrapper
export { handleRaw } from "./handleRaw.js";
export type { ArcQueryParserOptions } from "./queryParser.js";
// Query Parser
export {
  ArcQueryParser,
  createQueryParser,
} from "./queryParser.js";
export type { JsonSchema } from "./responseSchemas.js";
// Response Schemas
export {
  deleteResponse,
  errorResponseSchema,
  getDefaultCrudSchemas,
  getListQueryParams,
  itemResponse,
  listResponse,
  mutationResponse,
  paginationSchema,
  queryParams,
  responses,
  successResponseSchema,
  wrapResponse,
} from "./responseSchemas.js";
// Schema Converter
export {
  convertOpenApiSchemas,
  convertRouteSchema,
  isJsonSchema,
  isZodSchema,
  toJsonSchema,
} from "./schemaConverter.js";
export type { StateMachine, TransitionConfig } from "./stateMachine.js";
// State Machine
export { createStateMachine } from "./stateMachine.js";
export type { EventsDecorator } from "./typeGuards.js";
// Type Guards
export { hasEvents } from "./typeGuards.js";
