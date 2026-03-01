/**
 * Utils Module
 *
 * Common utilities for the Arc framework.
 */

// Errors
export {
  ArcError,
  NotFoundError,
  ValidationError,
  UnauthorizedError,
  ForbiddenError,
  ConflictError,
  OrgRequiredError,
  OrgAccessDeniedError,
  RateLimitError,
  ServiceUnavailableError,
  createError,
  isArcError,
} from './errors.js';
export type { ErrorDetails } from './errors.js';

// Response Schemas
export {
  successResponseSchema,
  errorResponseSchema,
  paginationSchema,
  wrapResponse,
  listResponse,
  itemResponse,
  mutationResponse,
  deleteResponse,
  responses,
  queryParams,
  getListQueryParams,
  getDefaultCrudSchemas,
  itemWrapper,
  paginateWrapper,
  messageWrapper,
} from './responseSchemas.js';
export type { JsonSchema } from './responseSchemas.js';

// State Machine
export { createStateMachine } from './stateMachine.js';
export type { StateMachine, TransitionConfig } from './stateMachine.js';

// Circuit Breaker
export {
  CircuitBreaker,
  CircuitBreakerError,
  CircuitBreakerRegistry,
  createCircuitBreaker,
  createCircuitBreakerRegistry,
  CircuitState,
} from './circuitBreaker.js';
export type { CircuitBreakerOptions, CircuitBreakerStats } from './circuitBreaker.js';

// Query Parser
export {
  ArcQueryParser,
  createQueryParser,
} from './queryParser.js';
export type { ArcQueryParserOptions } from './queryParser.js';

// Type Guards
export { hasEvents } from './typeGuards.js';
export type { EventsDecorator } from './typeGuards.js';

// Schema Converter
export {
  toJsonSchema,
  isJsonSchema,
  isZodSchema,
  convertOpenApiSchemas,
  convertRouteSchema,
} from './schemaConverter.js';
