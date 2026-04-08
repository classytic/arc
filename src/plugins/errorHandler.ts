/**
 * Error Handler Plugin
 *
 * Global error handling for Arc applications.
 * Catches all errors and returns a consistent JSON response.
 *
 * @example
 * import { errorHandlerPlugin } from '@classytic/arc/plugins';
 *
 * await fastify.register(errorHandlerPlugin, {
 *   includeStack: process.env.NODE_ENV !== 'production',
 *   onError: (error, request) => {
 *     // Log to external service (Sentry, etc.)
 *     Sentry.captureException(error);
 *   }
 * });
 */

import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { isArcError } from "../utils/errors.js";

/** Class-based error mapper — maps thrown error instances to HTTP responses */
export interface ErrorMapper<T extends Error = Error> {
  /** Error class to match (uses instanceof) */
  type: new (
    ...args: unknown[]
  ) => T;
  /** Convert the error to an HTTP response shape */
  toResponse: (error: T) => {
    status: number;
    code?: string;
    message?: string;
    details?: Record<string, unknown>;
  };
}

export interface ErrorHandlerOptions {
  /**
   * Include stack trace in error responses (default: false in production)
   */
  includeStack?: boolean;

  /**
   * Custom error callback for logging to external services
   */
  onError?: (error: Error, request: FastifyRequest) => void | Promise<void>;

  /**
   * Map specific error types to custom responses (by error.name string)
   */
  errorMap?: Record<
    string,
    {
      statusCode: number;
      code: string;
      message?: string;
    }
  >;

  /**
   * Class-based error mappers — checked via `instanceof`, highest priority.
   *
   * Register your domain error classes once; Arc auto-catches and maps them
   * in every handler. Handlers just `throw` — no try/catch needed.
   *
   * @example
   * ```typescript
   * class AccountingError extends Error {
   *   constructor(message: string, public status: number, public code: string) {
   *     super(message);
   *   }
   * }
   *
   * const app = await createApp({
   *   errorHandler: {
   *     errorMappers: [
   *       {
   *         type: AccountingError,
   *         toResponse: (err) => ({ status: err.status, code: err.code, message: err.message }),
   *       },
   *     ],
   *   },
   * });
   *
   * // Now handlers just throw:
   * handler: async (req) => {
   *   await ledger.post(id); // throws AccountingError → Arc maps to proper HTTP response
   * }
   * ```
   */
  errorMappers?: ErrorMapper[];
}

interface ErrorResponse {
  success: false;
  error: string;
  code: string;
  timestamp: string;
  requestId?: string;
  details?: Record<string, unknown>;
  stack?: string;
}

async function errorHandlerPluginFn(
  fastify: FastifyInstance,
  options: ErrorHandlerOptions = {},
): Promise<void> {
  const isProduction = process.env.NODE_ENV === "production";
  const { includeStack = !isProduction, onError, errorMap = {}, errorMappers = [] } = options;

  fastify.setErrorHandler(
    async (error: FastifyError | Error, request: FastifyRequest, reply: FastifyReply) => {
      // Call custom error handler if provided
      if (onError) {
        try {
          await onError(error, request);
        } catch (callbackError) {
          request.log.error({ err: callbackError }, "Error in onError callback");
        }
      }

      // Get request ID if available
      const requestId = (request as { id?: string }).id;

      // ── Class-based error mappers (highest priority) ──
      // Checked first via instanceof — lets users register domain errors once
      if (errorMappers.length > 0) {
        for (const mapper of errorMappers) {
          if (error instanceof mapper.type) {
            const mapped = mapper.toResponse(error);
            const response: ErrorResponse = {
              success: false,
              error: mapped.message ?? error.message,
              code: mapped.code ?? "DOMAIN_ERROR",
              timestamp: new Date().toISOString(),
              ...(requestId && { requestId }),
              ...(mapped.details && { details: mapped.details }),
              ...(includeStack && error.stack ? { stack: error.stack } : {}),
            };
            return reply.code(mapped.status).send(response);
          }
        }
      }

      // Build base response
      const response: ErrorResponse = {
        success: false,
        error: error.message || "Internal Server Error",
        code: "INTERNAL_ERROR",
        timestamp: new Date().toISOString(),
        ...(requestId && { requestId }),
      };

      let statusCode = 500;

      // Handle ArcError (our error classes)
      if (isArcError(error)) {
        statusCode = error.statusCode;
        response.code = error.code;
        if (error.details) {
          response.details = error.details;
        }
        if (error.requestId) {
          response.requestId = error.requestId;
        }
        // Log cause chain for debugging (cause is now properly serialized via toJSON)
        if (error.cause) {
          request.log.error({ cause: error.cause }, "Error cause chain");
        }
      }
      // Handle Fastify validation errors
      else if ("validation" in error && Array.isArray((error as FastifyError).validation)) {
        statusCode = 400;
        response.code = "VALIDATION_ERROR";
        response.error = "Validation failed";
        response.details = {
          errors: (error as FastifyError).validation?.map((v) => ({
            field: v.instancePath?.replace(/^\//, "") || v.params?.missingProperty || "unknown",
            message: v.message || "Invalid value",
            keyword: v.keyword,
          })),
        };
      }
      // Handle Fastify errors with statusCode
      else if ("statusCode" in error && typeof (error as FastifyError).statusCode === "number") {
        statusCode = (error as FastifyError).statusCode!;
        response.code = statusCodeToCode(statusCode);
      }
      // Handle errors with .status (MongoKit, http-errors, etc.)
      else if ("status" in error && typeof (error as { status: unknown }).status === "number") {
        statusCode = (error as { status: number }).status;
        response.code = statusCodeToCode(statusCode);
      }
      // Handle mapped error types
      else if (error.name && errorMap[error.name]) {
        const mapping = errorMap[error.name]!;
        statusCode = mapping.statusCode;
        response.code = mapping.code;
        if (mapping.message) {
          response.error = mapping.message;
        }
      }
      // Handle Mongoose validation errors
      else if (error.name === "ValidationError" && "errors" in error) {
        statusCode = 400;
        response.code = "VALIDATION_ERROR";
        const mongooseErrors = (
          error as { errors: Record<string, { message: string; path: string }> }
        ).errors;

        // Security: Don't expose schema field names when details are hidden
        if (includeStack) {
          response.details = {
            errors: Object.entries(mongooseErrors).map(([field, err]) => ({
              field: err.path || field,
              message: err.message,
            })),
          };
        } else {
          response.details = { errorCount: Object.keys(mongooseErrors).length };
        }
      }
      // Handle Mongoose CastError (invalid ObjectId, etc.)
      else if (error.name === "CastError") {
        statusCode = 400;
        response.code = "INVALID_ID";
        response.error = "Invalid identifier format";
      }
      // Handle duplicate key errors (MongoDB)
      else if (error.name === "MongoServerError" && (error as { code?: number }).code === 11000) {
        statusCode = 409;
        response.code = "DUPLICATE_KEY";
        response.error = "Resource already exists";
        const keyValue = (error as { keyValue?: Record<string, unknown> }).keyValue;

        // Security: Don't expose schema field names when details are hidden
        if (keyValue && includeStack) {
          response.details = { duplicateFields: Object.keys(keyValue) };
        }
      }

      // Include stack trace if enabled
      if (includeStack && error.stack) {
        response.stack = error.stack;
      }

      // Log server errors
      if (statusCode >= 500) {
        request.log.error({ err: error, statusCode }, "Server error");
      } else if (statusCode >= 400) {
        request.log.warn({ err: error, statusCode }, "Client error");
      }

      return reply.status(statusCode).send(response);
    },
  );
}

/**
 * Map HTTP status code to error code
 */
function statusCodeToCode(statusCode: number): string {
  const codes: Record<number, string> = {
    400: "BAD_REQUEST",
    401: "UNAUTHORIZED",
    403: "FORBIDDEN",
    404: "NOT_FOUND",
    405: "METHOD_NOT_ALLOWED",
    409: "CONFLICT",
    422: "UNPROCESSABLE_ENTITY",
    429: "RATE_LIMITED",
    500: "INTERNAL_ERROR",
    502: "BAD_GATEWAY",
    503: "SERVICE_UNAVAILABLE",
    504: "GATEWAY_TIMEOUT",
  };
  return codes[statusCode] ?? "ERROR";
}

export const errorHandlerPlugin = fp(errorHandlerPluginFn, {
  name: "arc-error-handler",
  fastify: "5.x",
});
