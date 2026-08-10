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

import { isProductionEnv } from "@classytic/primitives/environment";
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
  /**
   * Include `meta.stack` on the wire.
   *
   * Under `createApp`, defaults from the resolved `preset` (falling back to the
   * environment via `isProductionEnv`, which knows both `production` and `prod`).
   * Registering this plugin DIRECTLY skips that, and the default is the
   * environment alone.
   */
  includeStack?: boolean;
  /**
   * Ship the raw `error.message` of UNCLASSIFIED 500s on the wire.
   *
   * Same derivation as {@link includeStack}: the `preset` under `createApp`,
   * otherwise the environment. Both are host keys, so stating one no longer
   * silently resets the other — `registerErrorHandler` MERGES them over the
   * derived pair instead of replacing it.
   *
   * Only the `arc.internal_error` fallback is affected — an unclassified
   * throw carries whatever some driver/library put in the message (connection
   * strings, file paths, SQL fragments), which must not reach clients in
   * production. Deliberate 5xx contracts are untouched: `ArcError` /
   * domain-coded throws (`payment.gateway.timeout`, …) keep their message
   * because the thrower chose it for the client. The raw message is always
   * logged via `request.log.error({ err })` regardless of this flag.
   */
  exposeInternalMessages?: boolean;
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
  // Walk the `cause` chain (bounded): ORMs wrap driver errors — Drizzle's
  // DrizzleQueryError carries the Postgres 23505 on `.cause`, not on
  // itself — and a top-level-only check turns clean 409s into 500s.
  // Matching stays strict-code-only at every level (never messages).
  let current: unknown = err;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth++) {
    const e = current as {
      code?: number | string;
      codeName?: string;
      errno?: number;
      cause?: unknown;
    };
    if (e.code === 11000 || e.codeName === "DuplicateKey") return true; // MongoDB
    if (e.code === "P2002") return true; // Prisma
    if (e.code === "23505") return true; // Postgres / Neon
    if (e.code === "ER_DUP_ENTRY" || e.errno === 1062) return true; // MySQL / MariaDB
    if (e.code === "SQLITE_CONSTRAINT_UNIQUE" || e.code === "SQLITE_CONSTRAINT_PRIMARYKEY") {
      // SQLITE_CONSTRAINT alone covers NOT NULL / CHECK / FK violations too —
      // match only the unique-constraint variants to avoid false 409s.
      return true;
    }
    current = e.cause;
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
    // AJV `maximum` / `minimum` / `exclusiveMaximum` / `exclusiveMinimum`
    // errors carry the bound under `params.limit` (a confusingly-named
    // AJV field — it's the threshold, not the value that failed). Lift
    // it onto `meta` so callers reading the detail can fix the request
    // without parsing the human-readable `message`. This is the same
    // information arc previously hid: a 400 on `?limit=200` against a
    // resource capped at 100 used to surface only "Bad Request" with
    // no machine-readable cap.
    const meta: Record<string, unknown> = {};
    if (
      v.keyword === "maximum" ||
      v.keyword === "minimum" ||
      v.keyword === "exclusiveMaximum" ||
      v.keyword === "exclusiveMinimum"
    ) {
      const bound = (v.params as { limit?: number } | undefined)?.limit;
      if (typeof bound === "number") meta.bound = bound;
    }
    if (v.keyword === "enum") {
      const allowed = (v.params as { allowedValues?: unknown[] } | undefined)?.allowedValues;
      if (Array.isArray(allowed)) meta.allowedValues = allowed;
    }
    return {
      ...(path ? { path } : {}),
      code: v.keyword ?? "invalid",
      message: v.message || "Invalid value",
      ...(Object.keys(meta).length > 0 ? { meta } : {}),
    };
  });
}

/**
 * Hoist a context-aware message + machine-readable `meta` for the
 * common pagination-cap miss (`?limit=200` against a maxLimit=100
 * resource). Pre-2.17.0 the wire envelope carried "Validation failed"
 * + a detail with the AJV string; hosts had to grep the detail's
 * message to surface the cap. Now the top-level message is
 * "limit must be <= 100 (got 200)" AND `meta.cap` / `meta.received`
 * are stamped on the contract for programmatic callers.
 */
function describePaginationCap(
  error: FastifyError,
  details: ErrorDetail[],
): { message: string; meta: Record<string, unknown> } | null {
  if (!Array.isArray(error.validation) || error.validation.length === 0) return null;
  const v = error.validation.find(
    (entry) =>
      (entry.instancePath === "/limit" || entry.instancePath === "/page") &&
      (entry.keyword === "maximum" || entry.keyword === "minimum"),
  );
  if (!v) return null;
  const field = v.instancePath === "/limit" ? "limit" : "page";
  const bound = (v.params as { limit?: number } | undefined)?.limit;
  if (typeof bound !== "number") return null;
  const detail = details.find((d) => d.path === field);
  return {
    message: detail?.message
      ? `Query parameter '${field}' ${detail.message} (cap is ${bound})`
      : `Query parameter '${field}' violates bound ${bound}`,
    meta: { field, cap: bound },
  };
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
  /**
   * The FALLBACK for a plugin registered directly (`fastify.register(errorHandlerPlugin)`), which
   * has no access to `createApp`'s resolved `preset`. Composed through `createApp`, both switches
   * arrive already derived from the preset and this default never applies — see
   * `factory/registerAuth.ts#registerErrorHandler`.
   *
   * Via the shared classifier, NOT `process.env.NODE_ENV === "production"`. That comparison
   * recognises only the long spelling, so a deployment using `NODE_ENV=prod` got BOTH switches
   * true: stack traces AND the raw thrown message of a 500 returned to clients, in production,
   * with nothing to indicate it.
   */
  const productionEnv = isProductionEnv(process.env.NODE_ENV);
  const {
    includeStack = !productionEnv,
    exposeInternalMessages = !productionEnv,
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
      // Unclassified 500s carry whatever a driver/library put in the
      // message — never wire that in production. Deliberate 5xx contracts
      // (domain-coded ArcErrors) keep their message; the raw one is logged
      // below either way. See `ErrorHandlerOptions.exposeInternalMessages`.
      if (status >= 500 && wire.code === "arc.internal_error" && !exposeInternalMessages) {
        wire.message = "Internal Server Error";
      }
      if (status >= 500) {
        request.log.error({ err: error, status }, "Server error");
      } else if (status >= 400) {
        request.log.warn({ err: error, status }, "Client error");
      }
      // Log cause chain for ArcErrors that wrap a downstream exception —
      // at the severity of the response itself (a 404 wrapping a lookup
      // miss is not an `error`-level event; a 500 wrapping a driver crash is).
      if (isArcError(error) && error.cause) {
        const causeLevel = status >= 500 ? "error" : "warn";
        request.log[causeLevel]({ cause: error.cause }, "Error cause chain");
      }

      return reply.status(status).send(wire);
    },
  );
}

/**
 * Is `code` a caller-defined DOMAIN error code that is safe to surface on the
 * wire, as opposed to a framework/runtime code that must never leak?
 *
 * Rejects Fastify internals (`FST_*`) and Node system errnos (`ECONNREFUSED`,
 * `ENOENT`, …). Domain codes in the wild use separators (`PURCHASE_NOT_FOUND`,
 * `access.forbidden`) so they pass; a bare all-caps single word that collides
 * with the Node-errno shape (e.g. `EXPIRED`) is conservatively treated as a
 * runtime code — use a separatored code (`TOKEN_EXPIRED`) to surface it, or
 * throw via `createDomainError` which bypasses this heuristic entirely.
 */
function isDomainErrorCode(code: unknown): code is string {
  if (typeof code !== "string" || code.length === 0) return false;
  if (code.startsWith("FST_")) return false; // Fastify internal (FST_ERR_*)
  if (/^E[A-Z]{2,}$/.test(code)) return false; // Node errno (ECONNREFUSED, ENOENT)
  return true;
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
  const fastifyErr = error as FastifyError & {
    code?: string;
    meta?: Record<string, unknown>;
    statusCode?: number;
  };
  if (Array.isArray(fastifyErr.validation)) {
    // Honor a thrown error's own `message` / `code` / `meta` when present —
    // arc internals (e.g. the action router's scoped-validation formatter)
    // construct Fastify-shaped errors with a context-aware `arc.*` code
    // and optional `meta.action`. Fastify's native validation throws
    // carry `code: "FST_ERR_VALIDATION"`, which we DO want to map to the
    // canonical `arc.validation_error` — only `arc.*`-prefixed codes
    // signal arc-internal intent and bypass the default. Without this
    // guard, the Fastify 5.8+ code change leaked the `FST_ERR_*` code
    // into the public response envelope.
    const arcInternalCode =
      typeof fastifyErr.code === "string" && fastifyErr.code.startsWith("arc.")
        ? fastifyErr.code
        : undefined;
    // Native Fastify validation messages ("body must have required property 'x'")
    // belong in `details`, not the user-facing `message` — collapse them to the
    // generic "Validation failed" line. Arc-internal validation errors set
    // `arc.*` codes AND craft context-aware messages (action attribution etc.)
    // we should preserve verbatim.
    const details = fastifyValidationDetails(fastifyErr);
    // Hoist the pagination-cap case so the wire message names the cap
    // — every host that hit "Bad Request" on `?limit=200` had to dig
    // into details to learn the resource's maxLimit.
    const paginationCap = arcInternalCode ? null : describePaginationCap(fastifyErr, details);
    const message =
      paginationCap?.message ??
      (arcInternalCode ? error.message || "Validation failed" : "Validation failed");
    const mergedMeta = {
      ...(fastifyErr.meta ?? {}),
      ...(paginationCap?.meta ?? {}),
    };
    return {
      code: arcInternalCode ?? "arc.validation_error",
      message,
      status: typeof fastifyErr.statusCode === "number" ? fastifyErr.statusCode : 400,
      details,
      ...(Object.keys(mergedMeta).length > 0 ? { meta: mergedMeta } : {}),
    };
  }

  // 4. Fastify-style errors with a numeric statusCode. Honor an explicit
  // DOMAIN code the thrower attached — e.g.
  // `Object.assign(new Error(msg), { statusCode: 404, code: 'PURCHASE_NOT_FOUND' })`
  // — so it reaches the client like `createDomainError` does, instead of being
  // silently replaced by the generic `arc.<status>`. Framework/runtime codes
  // (Fastify `FST_*`, Node errnos like `ECONNREFUSED`) are NEVER surfaced —
  // they carry no client contract. See `isDomainErrorCode`.
  if (typeof fastifyErr.statusCode === "number") {
    const domainCode = isDomainErrorCode(fastifyErr.code) ? fastifyErr.code : undefined;
    return {
      code: domainCode ?? statusToArcCode(fastifyErr.statusCode),
      message: error.message || "Error",
      status: fastifyErr.statusCode,
    };
  }

  // 5. Name-keyed map
  const namedMapping = error.name ? ctx.errorMap[error.name] : undefined;
  if (namedMapping) {
    return {
      code: namedMapping.code,
      message: namedMapping.message ?? error.message,
      status: namedMapping.statusCode,
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
