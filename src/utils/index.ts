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
  // Aliases for backwards compatibility with local responseSchemas.js
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
  circuitBreakerRegistry,
  CircuitState,
} from './circuitBreaker.js';
export type { CircuitBreakerOptions, CircuitBreakerStats } from './circuitBreaker.js';

// Query Parser
export {
  ArcQueryParser,
  createQueryParser,
} from './queryParser.js';
export type { ArcQueryParserOptions } from './queryParser.js';
