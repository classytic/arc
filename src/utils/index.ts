/**
 * Utils Module
 *
 * Common utilities for the Arc framework.
 */

// Resource config validation — dev tooling moved here from the root barrel in
// v2.11.0 so `@classytic/arc` can honor its "root = essentials only" policy.
export type {
  ConfigError,
  ValidateOptions,
  ValidationResult,
} from "../core/validateResourceConfig.js";
export {
  assertValidConfig,
  formatValidationErrors,
  validateResourceConfig,
} from "../core/validateResourceConfig.js";
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
// Typed ErrorMapper helper — avoids `as unknown as ErrorMapper` at registration sites
export { defineErrorMapper } from "./defineErrorMapper.js";
// Typed route guard helper
export type { Guard, GuardConfig } from "./defineGuard.js";
export { defineGuard } from "./defineGuard.js";
export type { ErrorOptions } from "./errors.js";
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
  aggregateListResponse,
  bareListResponse,
  deleteResponse,
  errorContractSchema,
  errorDetailSchema,
  getDefaultCrudSchemas,
  getListQueryParams,
  keysetListResponse,
  listResponse,
  offsetListResponse,
  paginationSchema,
  queryParams,
  responses,
} from "./responseSchemas.js";
// Cross-runtime scheduling helper
export { scheduleBackground } from "./runtime.js";
export type { JsonSchemaTarget } from "./schemaConverter.js";
// Schema Converter
export {
  convertOpenApiSchemas,
  convertRouteSchema,
  isJsonSchema,
  isZodSchema,
  toJsonSchema,
} from "./schemaConverter.js";
// Minimal flat-equality matcher for `DataAdapter.matchesFilter` on custom/minimal repos
export { simpleEqualityMatcher } from "./simpleEqualityMatcher.js";
export type { StateMachine, TransitionConfig } from "./stateMachine.js";
// State Machine
export { createStateMachine } from "./stateMachine.js";
export type { EventsDecorator } from "./typeGuards.js";
// Type Guards
export { hasEvents } from "./typeGuards.js";
// User-object helpers (moved from `/types` in v2.11.0)
export { getUserId } from "./userHelpers.js";
