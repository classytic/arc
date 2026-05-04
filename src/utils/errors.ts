/**
 * Arc error hierarchy.
 *
 * Throw an `ArcError` (or one of its subclasses) anywhere in a controller
 * or middleware. Arc's global error handler catches it and serializes to
 * the canonical `ErrorContract` wire shape via repo-core's
 * `toErrorContract(err)` — one contract across the org.
 *
 * `ArcError` implements the {@link HttpError} contract from
 * `@classytic/repo-core/errors`, so any host that already speaks that
 * contract (mongokit, sqlitekit, streamline, prismakit) catches and
 * serializes arc errors with the same code path it uses for its own.
 *
 * **Code naming.** Hierarchical, lowercase + dot-separated:
 * `arc.not_found`, `arc.validation_error`, `arc.org.access_denied`. New
 * domain packages should follow the same pattern (`commerce.cart.locked`,
 * `payment.gateway.timeout`). Cross-cutting canonical codes live in
 * `@classytic/repo-core/errors`'s `ERROR_CODES` constant.
 */

import type { HttpError } from "@classytic/repo-core/errors";

export interface ErrorOptions {
  code?: string;
  statusCode?: number;
  details?: Record<string, unknown>;
  cause?: Error;
}

/**
 * Base Arc Error. Implements the canonical `HttpError` contract — `status`
 * mirrors `statusCode` and `meta` mirrors `details`, so consumers reading
 * either name see the same value without adapter glue.
 */
export class ArcError extends Error implements HttpError {
  override name = "ArcError";
  readonly code: string;
  readonly statusCode: number;
  readonly details?: Record<string, unknown>;
  override readonly cause?: Error;

  constructor(message: string, options: ErrorOptions = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.code = options.code ?? "arc.error";
    this.statusCode = options.statusCode ?? 500;
    this.details = options.details;
    this.cause = options.cause;
    if (Error.captureStackTrace) Error.captureStackTrace(this, this.constructor);
  }

  /** `HttpError.status` mirror — repo-core's `toErrorContract` reads this. */
  get status(): number {
    return this.statusCode;
  }

  /** `HttpError.meta` mirror — `details` under the canonical name. */
  get meta(): Record<string, unknown> | undefined {
    return this.details;
  }
}

export class NotFoundError extends ArcError {
  constructor(resource: string, identifier?: string) {
    const message = identifier
      ? `${resource} with identifier '${identifier}' not found`
      : `${resource} not found`;
    super(message, {
      code: "arc.not_found",
      statusCode: 404,
      details: { resource, ...(identifier ? { identifier } : {}) },
    });
    this.name = "NotFoundError";
  }
}

export class ValidationError extends ArcError {
  readonly errors: ReadonlyArray<{ field: string; message: string }>;

  constructor(message: string, errors: Array<{ field: string; message: string }> = []) {
    super(message, {
      code: "arc.validation_error",
      statusCode: 400,
      details: { errors },
    });
    this.name = "ValidationError";
    this.errors = errors;
  }
}

export class UnauthorizedError extends ArcError {
  constructor(message = "Authentication required") {
    super(message, { code: "arc.unauthorized", statusCode: 401 });
    this.name = "UnauthorizedError";
  }
}

export class ForbiddenError extends ArcError {
  constructor(message = "Access denied") {
    super(message, { code: "arc.forbidden", statusCode: 403 });
    this.name = "ForbiddenError";
  }
}

export class ConflictError extends ArcError {
  constructor(message: string, field?: string) {
    super(message, {
      code: "arc.conflict",
      statusCode: 409,
      ...(field ? { details: { field } } : {}),
    });
    this.name = "ConflictError";
  }
}

export class OrgRequiredError extends ArcError {
  readonly organizations?: ReadonlyArray<{ id: string; roles?: string[] }>;

  constructor(message: string, organizations?: Array<{ id: string; roles?: string[] }>) {
    super(message, {
      code: "arc.org.selection_required",
      statusCode: 403,
      ...(organizations ? { details: { organizations } } : {}),
    });
    this.name = "OrgRequiredError";
    this.organizations = organizations;
  }
}

export class OrgAccessDeniedError extends ArcError {
  constructor(orgId?: string) {
    super("Organization access denied", {
      code: "arc.org.access_denied",
      statusCode: 403,
      ...(orgId ? { details: { organizationId: orgId } } : {}),
    });
    this.name = "OrgAccessDeniedError";
  }
}

export class RateLimitError extends ArcError {
  readonly retryAfter?: number;

  constructor(message = "Too many requests", retryAfter?: number) {
    super(message, {
      code: "arc.rate_limited",
      statusCode: 429,
      ...(retryAfter ? { details: { retryAfter } } : {}),
    });
    this.name = "RateLimitError";
    this.retryAfter = retryAfter;
  }
}

export class ServiceUnavailableError extends ArcError {
  constructor(message = "Service temporarily unavailable") {
    super(message, { code: "arc.service_unavailable", statusCode: 503 });
    this.name = "ServiceUnavailableError";
  }
}

/**
 * Status-code → canonical `arc.*` code mapping. Used by {@link createError}
 * and the global error handler when no explicit code is supplied.
 */
const STATUS_CODE_MAP: Readonly<Record<number, string>> = {
  400: "arc.bad_request",
  401: "arc.unauthorized",
  403: "arc.forbidden",
  404: "arc.not_found",
  409: "arc.conflict",
  422: "arc.unprocessable_entity",
  429: "arc.rate_limited",
  500: "arc.internal_error",
  502: "arc.bad_gateway",
  503: "arc.service_unavailable",
  504: "arc.gateway_timeout",
};

/** Status → canonical arc code, falling back to `arc.error`. */
export function statusToArcCode(status: number): string {
  return STATUS_CODE_MAP[status] ?? "arc.error";
}

/** Quick `ArcError` constructor when the bundled subclasses don't fit. */
export function createError(
  statusCode: number,
  message: string,
  details?: Record<string, unknown>,
): ArcError {
  return new ArcError(message, {
    code: statusToArcCode(statusCode),
    statusCode,
    ...(details ? { details } : {}),
  });
}

/**
 * Domain-error escape hatch. Use a hierarchical code that scopes the error
 * to your package (`'commerce.cart.locked'`, `'payment.gateway.timeout'`).
 */
export function createDomainError(
  code: string,
  message: string,
  statusCode = 400,
  details?: Record<string, unknown>,
): ArcError {
  return new ArcError(message, { code, statusCode, ...(details ? { details } : {}) });
}

/** Type guard. */
export function isArcError(error: unknown): error is ArcError {
  return error instanceof ArcError;
}
