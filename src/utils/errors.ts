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
 * **Codes are catalogued in `@classytic/repo-core/errors`** (`ARC_ERROR_CODES`,
 * `ARC_REASON_CODES`) so client SDKs read the wire vocabulary without
 * depending on arc. Emit from those constants; `tests/utils/error-code-catalog.test.ts`
 * fails on an uncatalogued `arc.*` literal. Domain packages use their own
 * namespace (`commerce.cart.locked`).
 */

import { ARC_ERROR_CODES as C, type HttpError } from "@classytic/repo-core/errors";

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
    this.code = options.code ?? C.ERROR;
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
      code: C.NOT_FOUND,
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
      code: C.VALIDATION_ERROR,
      statusCode: 400,
      details: { errors },
    });
    this.name = "ValidationError";
    this.errors = errors;
  }

  /**
   * `HttpError.validationErrors` — what `toErrorContract` turns into the wire's
   * `details[]`, the one place clients (arc-next `fieldErrors`) read field errors.
   */
  get validationErrors(): Array<{ path: string; validator: string; error: string }> {
    return this.errors.map((e) => ({
      path: e.field,
      validator: "validation_error",
      error: e.message,
    }));
  }
}

export class UnauthorizedError extends ArcError {
  constructor(message = "Authentication required") {
    super(message, { code: C.UNAUTHORIZED, statusCode: 401 });
    this.name = "UnauthorizedError";
  }
}

export class ForbiddenError extends ArcError {
  constructor(message = "Access denied") {
    super(message, { code: C.FORBIDDEN, statusCode: 403 });
    this.name = "ForbiddenError";
  }
}

export class ConflictError extends ArcError {
  constructor(message: string, field?: string) {
    super(message, {
      code: C.CONFLICT,
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
      code: C.ORG_SELECTION_REQUIRED,
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
      code: C.ORG_ACCESS_DENIED,
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
      code: C.RATE_LIMITED,
      statusCode: 429,
      ...(retryAfter ? { details: { retryAfter } } : {}),
    });
    this.name = "RateLimitError";
    this.retryAfter = retryAfter;
  }
}

export class ServiceUnavailableError extends ArcError {
  constructor(message = "Service temporarily unavailable") {
    super(message, { code: C.SERVICE_UNAVAILABLE, statusCode: 503 });
    this.name = "ServiceUnavailableError";
  }
}

/**
 * Status-code → canonical `arc.*` code mapping. Used by {@link createError}
 * and the global error handler when no explicit code is supplied.
 */
const STATUS_CODE_MAP: Readonly<Record<number, string>> = {
  400: C.BAD_REQUEST,
  401: C.UNAUTHORIZED,
  403: C.FORBIDDEN,
  404: C.NOT_FOUND,
  409: C.CONFLICT,
  412: C.PRECONDITION_FAILED,
  413: C.PAYLOAD_TOO_LARGE,
  415: C.UNSUPPORTED_MEDIA_TYPE,
  422: C.UNPROCESSABLE_ENTITY,
  429: C.RATE_LIMITED,
  500: C.INTERNAL_ERROR,
  501: C.NOT_IMPLEMENTED,
  502: C.BAD_GATEWAY,
  503: C.SERVICE_UNAVAILABLE,
  504: C.GATEWAY_TIMEOUT,
};

/** Status → canonical arc code, falling back to `arc.error`. */
export function statusToArcCode(status: number): string {
  return STATUS_CODE_MAP[status] ?? C.ERROR;
}

/**
 * Quick `ArcError` constructor when the bundled subclasses don't fit.
 *
 * If `details.code` is a string, it's lifted to the top-level `error.code`
 * (the canonical wire slot for business signals — `'ORG_CONTEXT_REQUIRED'`,
 * `'ALL_FIELDS_STRIPPED'`, etc). The same code stays in `details` so
 * in-process consumers reading `error.details.code` still work. Without
 * this lift, business codes get buried in `details` and the wire envelope
 * carries only the status-derived `arc.forbidden` / `arc.bad_request`
 * fallback — `repo-core`'s `toErrorContract` doesn't surface free-form
 * `details` objects (its `details[]` array is reserved for validation /
 * duplicate-key items).
 */
export function createError(
  statusCode: number,
  message: string,
  details?: Record<string, unknown>,
): ArcError {
  const businessCode = typeof details?.code === "string" ? details.code : undefined;
  return new ArcError(message, {
    code: businessCode ?? statusToArcCode(statusCode),
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
