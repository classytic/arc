/**
 * Global error handler — converts every thrown error into the canonical
 * `ErrorContract` wire shape from `@classytic/repo-core/errors`.
 *
 * Wire shape (no envelope; HTTP status discriminates success vs error):
 * ```
 * { code, message, status, details?, meta?, correlationId? }
 * ```
 *
 * Throw anywhere — controller, hook, middleware — and the response is
 * automatically converted. `ArcError` instances and any `HttpError`-shaped
 * throw (mongokit, sqlitekit, streamline, prismakit) flow through the
 * canonical converter unchanged.
 *
 * Custom domain error classes register via `errorMappers` (instanceof) or
 * `errorMap` (by name). Driver-specific duplicate-key violations
 * (Mongo 11000, Prisma P2002, Postgres 23505, MySQL 1062, SQLite
 * UNIQUE) collapse to a 409 with `code: 'arc.conflict'`.
 *
 * @example
 * await fastify.register(errorHandlerPlugin, {
 *   includeStack: process.env.NODE_ENV !== 'production',
 *   onError: (err) => Sentry.captureException(err),
 * });
 */

import type { ErrorContract, ErrorDetail } from "@classytic/repo-core/errors";
import { isHttpError, toErrorContract } from "@classytic/repo-core/errors";
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { isArcError, statusToArcCode } from "../utils/errors.js";

/**
 * Class-based error mapper — `instanceof` check converts a thrown class
 * to a partial `ErrorContract`. Highest-priority dispatch in the handler.
 */
export interface ErrorMapper<T extends Error = Error> {
  type: abstract new (
    // biome-ignore lint/suspicious/noExplicitAny: permissive ctor signature is deliberate
    ...args: any[]
  ) => T;
  toResponse: (error: T) => {
    status: number;
    code?: string;
    message?: string;
    details?: ReadonlyArray<ErrorDetail>;
    meta?: Record<string, unknown>;
  };
}

export interface ErrorHandlerOptions {
  /** Include `meta.stack` on the wire (defaults to `NODE_ENV !== 'production'`). */
  includeStack?: boolean;
  /** Custom callback fired for every error — log to Sentry / Datadog / etc. */
  onError?: (error: Error, request: FastifyRequest) => void | Promise<void>;
  /** Map by `error.name` string. Lower priority than `errorMappers`. */
  errorMap?: Record<string, { statusCode: number; code: string; message?: string }>;
  /** Map by `instanceof`. Highest priority — checked first. */
  errorMappers?: ErrorMapper[];
  /** Driver-aware duplicate-key classifier. Override to add long-tail drivers. */
  isDuplicateKeyError?: (err: unknown) => boolean;
}

/**
 * Default duplicate-key detector. Strict driver-code matching only — never
 * message strings (false positives mask real WriteConflict / NotWritable
 * errors as 409s). Long-tail drivers compose: see jsdoc on
 * {@link ErrorHandlerOptions.isDuplicateKeyError}.
 */
export function defaultIsDuplicateKeyError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: number | string; codeName?: string; errno?: number };
  if (e.code === 11000 || e.codeName === "DuplicateKey") return true; // MongoDB
  if (e.code === "P2002") return true; // Prisma
  if (e.code === "23505") return true; // Postgres / Neon
  if (e.code === "ER_DUP_ENTRY" || e.errno === 1062) return true; // MySQL / MariaDB
  if (e.code === "SQLITE_CONSTRAINT_UNIQUE" || e.code === "SQLITE_CONSTRAINT_PRIMARYKEY") {
    // SQLITE_CONSTRAINT alone covers NOT NULL / CHECK / FK violations too —
    // match only the unique-constraint variants to avoid false 409s.
    return true;
  }
  return false;
}

function extractDuplicateFields(err: unknown): string[] | null {
  if (!err || typeof err !== "object") return null;
  const e = err as {
    keyValue?: Record<string, unknown>;
    meta?: { target?: unknown };
    constraint?: unknown;
  };
  if (e.keyValue && typeof e.keyValue === "object") return Object.keys(e.keyValue);
  if (e.meta?.target) {
    if (Array.isArray(e.meta.target)) return e.meta.target.map(String);
    if (typeof e.meta.target === "string") return [e.meta.target];
  }
  if (typeof e.constraint === "string") return [e.constraint];
  return null;
}

/** Map Fastify schema-validation errors → canonical `ErrorDetail[]`. */
function fastifyValidationDetails(error: FastifyError): ErrorDetail[] {
  return (error.validation ?? []).map((v) => {
    const missingProperty = v.params?.missingProperty;
    const path =
      v.instancePath?.replace(/^\//, "") ||
      (typeof missingProperty === "string" ? missingProperty : undefined);
    return {
      ...(path ? { path } : {}),
      code: v.keyword ?? "invalid",
      message: v.message || "Invalid value",
    };
  });
}

/** Map Mongoose `ValidationError.errors` → canonical `ErrorDetail[]`. */
function mongooseValidationDetails(
  errors: Record<string, { message: string; path: string }>,
): ErrorDetail[] {
  return Object.entries(errors).map(([field, e]) => ({
    path: e.path || field,
    code: "validation_error",
    message: e.message,
  }));
}

async function errorHandlerPluginFn(
  fastify: FastifyInstance,
  options: ErrorHandlerOptions = {},
): Promise<void> {
  const isProduction = process.env.NODE_ENV === "production";
  const {
    includeStack = !isProduction,
    onError,
    errorMap = {},
    errorMappers = [],
    isDuplicateKeyError = defaultIsDuplicateKeyError,
  } = options;

  fastify.setErrorHandler(
    async (error: FastifyError | Error, request: FastifyRequest, reply: FastifyReply) => {
      if (onError) {
        try {
          await onError(error, request);
        } catch (callbackError) {
          request.log.error({ err: callbackError }, "Error in onError callback");
        }
      }

      const correlationId = (request as { id?: string }).id;
      const contract = classify(error, { errorMappers, errorMap, isDuplicateKeyError });

      // Stamp correlation + (optional) stack into `meta` — both are
      // host-set, not throwable contract fields.
      const meta: Record<string, unknown> = { ...(contract.meta ?? {}) };
      if (includeStack && error.stack) meta.stack = error.stack;
      const wire: ErrorContract = {
        ...contract,
        ...(correlationId ? { correlationId } : {}),
        ...(Object.keys(meta).length > 0 ? { meta } : {}),
      };

      const status = wire.status ?? 500;
      if (status >= 500) {
        request.log.error({ err: error, status }, "Server error");
      } else if (status >= 400) {
        request.log.warn({ err: error, status }, "Client error");
      }
      // Log cause chain for ArcErrors that wrap a downstream exception.
      if (isArcError(error) && error.cause) {
        request.log.error({ cause: error.cause }, "Error cause chain");
      }

      return reply.status(status).send(wire);
    },
  );
}

/**
 * Single-pass error → `ErrorContract` classifier. Dispatch order is fixed:
 *
 *   1. Class-based mappers (`instanceof`) — user-registered domain errors
 *   2. `ArcError` / any `HttpError`-shaped throw — flows through `toErrorContract`
 *   3. Fastify schema-validation errors — `error.validation` array
 *   4. Fastify-style errors with a numeric `statusCode`
 *   5. Name-keyed `errorMap` entries
 *   6. Mongoose `ValidationError` / `CastError`
 *   7. Driver-specific duplicate-key classifier
 *   8. Fallback: `arc.internal_error` 500
 */
function classify(
  error: Error,
  ctx: {
    errorMappers: ErrorMapper[];
    errorMap: Record<string, { statusCode: number; code: string; message?: string }>;
    isDuplicateKeyError: (err: unknown) => boolean;
  },
): ErrorContract {
  // 1. Instance-based mappers
  for (const mapper of ctx.errorMappers) {
    if (error instanceof mapper.type) {
      const mapped = mapper.toResponse(error);
      return {
        code: mapped.code ?? statusToArcCode(mapped.status),
        message: mapped.message ?? error.message,
        status: mapped.status,
        ...(mapped.details ? { details: mapped.details } : {}),
        ...(mapped.meta ? { meta: mapped.meta } : {}),
      };
    }
  }

  // 2. ArcError + any HttpError-shaped throw — repo-core's converter
  // handles `code` cascade, `validationErrors`/`duplicate.fields` →
  // `details`, and `meta` passthrough.
  if (isArcError(error) || isHttpError(error)) {
    return toErrorContract(error);
  }

  // 3. Fastify schema-validation errors
  const fastifyErr = error as FastifyError;
  if (Array.isArray(fastifyErr.validation)) {
    return {
      code: "arc.validation_error",
      message: "Validation failed",
      status: 400,
      details: fastifyValidationDetails(fastifyErr),
    };
  }

  // 4. Fastify errors with a numeric statusCode
  if (typeof fastifyErr.statusCode === "number") {
    return {
      code: statusToArcCode(fastifyErr.statusCode),
      message: error.message || "Error",
      status: fastifyErr.statusCode,
    };
  }

  // 5. Name-keyed map
  if (error.name && ctx.errorMap[error.name]) {
    const m = ctx.errorMap[error.name]!;
    return {
      code: m.code,
      message: m.message ?? error.message,
      status: m.statusCode,
    };
  }

  // 6. Mongoose validation / cast
  if (error.name === "ValidationError" && "errors" in error) {
    const errs = (error as { errors: Record<string, { message: string; path: string }> }).errors;
    return {
      code: "arc.validation_error",
      message: error.message || "Validation failed",
      status: 400,
      details: mongooseValidationDetails(errs),
    };
  }
  if (error.name === "CastError") {
    return {
      code: "arc.invalid_id",
      message: "Invalid identifier format",
      status: 400,
    };
  }

  // 7. Driver duplicate-key
  if (ctx.isDuplicateKeyError(error)) {
    const fields = extractDuplicateFields(error);
    return {
      code: "arc.conflict",
      message: "Resource already exists",
      status: 409,
      ...(fields && fields.length > 0
        ? {
            details: fields.map((f) => ({
              path: f,
              code: "duplicate_key",
              message: `Duplicate value for "${f}"`,
            })),
          }
        : {}),
    };
  }

  // 8. Fallback
  return {
    code: "arc.internal_error",
    message: error.message || "Internal Server Error",
    status: 500,
  };
}

export const errorHandlerPlugin = fp(errorHandlerPluginFn, {
  name: "arc-error-handler",
  fastify: "5.x",
});
