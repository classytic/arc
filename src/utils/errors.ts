/**
 * Error Classes
 *
 * Standard error types for the Arc framework.
 */

export interface ErrorDetails {
  code?: string;
  statusCode?: number;
  details?: Record<string, unknown>;
  cause?: Error;
  requestId?: string;
}

/**
 * Base Arc Error
 *
 * All Arc errors extend this class and produce a consistent error envelope:
 * {
 *   success: false,
 *   error: "Human-readable message",
 *   code: "MACHINE_CODE",
 *   requestId: "uuid",     // For tracing
 *   timestamp: "ISO date", // When error occurred
 *   details: { ... }       // Additional context
 * }
 */
export class ArcError extends Error {
  override name: string;
  readonly code: string;
  readonly statusCode: number;
  readonly details?: Record<string, unknown>;
  override readonly cause?: Error;
  readonly timestamp: string;
  requestId?: string;

  constructor(message: string, options: ErrorDetails = {}) {
    // Pass cause to native Error for proper chain support (Node 16.9+)
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = 'ArcError';
    this.code = options.code ?? 'ARC_ERROR';
    this.statusCode = options.statusCode ?? 500;
    this.details = options.details;
    // cause is now set by super() — keep explicit assignment for TypeScript override
    this.cause = options.cause;
    this.timestamp = new Date().toISOString();
    this.requestId = options.requestId;

    // Maintain proper stack trace
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }

  /**
   * Set request ID (typically from request context)
   */
  withRequestId(requestId: string): this {
    this.requestId = requestId;
    return this;
  }

  /**
   * Convert to JSON response.
   * Includes cause chain when present for debugging visibility.
   */
  toJSON(): Record<string, unknown> {
    return {
      success: false,
      error: this.message,
      code: this.code,
      timestamp: this.timestamp,
      ...(this.requestId && { requestId: this.requestId }),
      ...(this.details && { details: this.details }),
      ...(this.cause && {
        cause: this.cause instanceof ArcError
          ? this.cause.toJSON()
          : { message: (this.cause as Error).message, name: (this.cause as Error).name },
      }),
    };
  }
}

/**
 * Not Found Error - 404
 */
export class NotFoundError extends ArcError {
  constructor(resource: string, identifier?: string) {
    const message = identifier
      ? `${resource} with identifier '${identifier}' not found`
      : `${resource} not found`;

    super(message, {
      code: 'NOT_FOUND',
      statusCode: 404,
      details: { resource, identifier },
    });
    this.name = 'NotFoundError';
  }
}

/**
 * Validation Error - 400
 */
export class ValidationError extends ArcError {
  readonly errors: Array<{ field: string; message: string }>;

  constructor(
    message: string,
    errors: Array<{ field: string; message: string }> = []
  ) {
    super(message, {
      code: 'VALIDATION_ERROR',
      statusCode: 400,
      details: { errors },
    });
    this.name = 'ValidationError';
    this.errors = errors;
  }
}

/**
 * Unauthorized Error - 401
 */
export class UnauthorizedError extends ArcError {
  constructor(message = 'Authentication required') {
    super(message, {
      code: 'UNAUTHORIZED',
      statusCode: 401,
    });
    this.name = 'UnauthorizedError';
  }
}

/**
 * Forbidden Error - 403
 */
export class ForbiddenError extends ArcError {
  constructor(message = 'Access denied') {
    super(message, {
      code: 'FORBIDDEN',
      statusCode: 403,
    });
    this.name = 'ForbiddenError';
  }
}

/**
 * Conflict Error - 409
 */
export class ConflictError extends ArcError {
  constructor(message: string, field?: string) {
    super(message, {
      code: 'CONFLICT',
      statusCode: 409,
      details: field ? { field } : undefined,
    });
    this.name = 'ConflictError';
  }
}

/**
 * Organization Required Error - 403
 */
export class OrgRequiredError extends ArcError {
  readonly organizations?: Array<{ id: string; roles?: string[] }>;

  constructor(
    message: string,
    organizations?: Array<{ id: string; roles?: string[] }>
  ) {
    super(message, {
      code: 'ORG_SELECTION_REQUIRED',
      statusCode: 403,
      details: organizations ? { organizations } : undefined,
    });
    this.name = 'OrgRequiredError';
    this.organizations = organizations;
  }
}

/**
 * Organization Access Denied Error - 403
 */
export class OrgAccessDeniedError extends ArcError {
  constructor(orgId?: string) {
    super('Organization access denied', {
      code: 'ORG_ACCESS_DENIED',
      statusCode: 403,
      details: orgId ? { organizationId: orgId } : undefined,
    });
    this.name = 'OrgAccessDeniedError';
  }
}

/**
 * Rate Limit Error - 429
 */
export class RateLimitError extends ArcError {
  readonly retryAfter?: number;

  constructor(message = 'Too many requests', retryAfter?: number) {
    super(message, {
      code: 'RATE_LIMITED',
      statusCode: 429,
      details: retryAfter ? { retryAfter } : undefined,
    });
    this.name = 'RateLimitError';
    this.retryAfter = retryAfter;
  }
}

/**
 * Service Unavailable Error - 503
 */
export class ServiceUnavailableError extends ArcError {
  constructor(message = 'Service temporarily unavailable') {
    super(message, {
      code: 'SERVICE_UNAVAILABLE',
      statusCode: 503,
    });
    this.name = 'ServiceUnavailableError';
  }
}

/**
 * Create error from status code
 */
export function createError(
  statusCode: number,
  message: string,
  details?: Record<string, unknown>
): ArcError {
  const codes: Record<number, string> = {
    400: 'BAD_REQUEST',
    401: 'UNAUTHORIZED',
    403: 'FORBIDDEN',
    404: 'NOT_FOUND',
    409: 'CONFLICT',
    429: 'RATE_LIMITED',
    500: 'INTERNAL_ERROR',
    503: 'SERVICE_UNAVAILABLE',
  };

  return new ArcError(message, {
    code: codes[statusCode] ?? 'ERROR',
    statusCode,
    details,
  });
}

/**
 * Check if error is an Arc error
 */
export function isArcError(error: unknown): error is ArcError {
  return error instanceof ArcError;
}
