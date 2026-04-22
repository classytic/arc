/**
 * Fastify Adapter for IController
 *
 * Converts between Fastify's request/reply and framework-agnostic IRequestContext/IControllerResponse.
 * This allows controllers implementing IController to work seamlessly with Fastify.
 */

import type { OffsetPaginationResult } from "@classytic/repo-core/pagination";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { FieldPermissionMap } from "../permissions/fields.js";
import { applyFieldReadPermissions, resolveEffectiveRoles } from "../permissions/fields.js";
import { getUserRoles } from "../permissions/types.js";
import { buildRequestScopeProjection } from "../scope/projection.js";
import type { RequestScope } from "../scope/types.js";
import { isElevated, isMember, PUBLIC_SCOPE } from "../scope/types.js";
import type { ServerAccessor } from "../types/handlers.js";
import type {
  AnyRecord,
  ArcInternalMetadata,
  IController,
  IControllerResponse,
  IRequestContext,
  RequestContext,
  RequestWithExtras,
} from "../types/index.js";

/** Type guard for Mongoose-like documents with toObject() */
function isMongooseDoc(obj: unknown): obj is { toObject(): Record<string, unknown> } {
  return (
    !!obj &&
    typeof obj === "object" &&
    "toObject" in obj &&
    typeof (obj as Record<string, unknown>).toObject === "function"
  );
}

/**
 * Apply field mask to a single object
 * Filters fields based on include/exclude rules
 */
function applyFieldMaskToObject(
  obj: AnyRecord | null | undefined,
  fieldMask: { include?: string[]; exclude?: string[] },
): AnyRecord | null | undefined {
  if (!obj || typeof obj !== "object") return obj;

  // Normalize Mongoose documents to plain objects
  const plain = isMongooseDoc(obj) ? (obj.toObject() as AnyRecord) : obj;

  const { include, exclude } = fieldMask;

  // If include is specified, only include those fields
  if (include && include.length > 0) {
    const filtered: AnyRecord = {};
    for (const field of include) {
      if (field in plain) {
        filtered[field] = plain[field];
      }
    }
    return filtered;
  }

  // If exclude is specified, remove those fields
  if (exclude && exclude.length > 0) {
    const filtered: AnyRecord = { ...plain };
    for (const field of exclude) {
      delete filtered[field];
    }
    return filtered;
  }

  return plain;
}

/**
 * Apply field mask to response data (handles both objects and arrays)
 */
function applyFieldMask<T>(
  data: T,
  fieldMask: { include?: string[]; exclude?: string[] } | undefined,
): T {
  if (!fieldMask) return data;

  // Handle arrays
  if (Array.isArray(data)) {
    return data.map((item) => applyFieldMaskToObject(item as AnyRecord, fieldMask)) as T;
  }

  // Handle single objects
  if (data && typeof data === "object") {
    return applyFieldMaskToObject(data as AnyRecord, fieldMask) as T;
  }

  return data;
}

/**
 * Create IRequestContext from Fastify request
 *
 * Extracts framework-agnostic context from Fastify-specific request object
 */
export function createRequestContext(req: FastifyRequest): IRequestContext {
  const reqWithExtras = req as RequestWithExtras;
  const requestContext = (reqWithExtras.context ?? {}) as RequestContext;

  // Build server accessor — exposes events, audit, and log without wrapHandler switching
  // Use 'in' checks because these decorators are only present when their plugins are registered
  const srv = req.server as unknown as Record<string, unknown> | undefined;
  const serverAccessor: ServerAccessor = {
    events: srv && "events" in srv ? (srv.events as ServerAccessor["events"]) : undefined,
    audit: srv && "audit" in srv ? (srv.audit as ServerAccessor["audit"]) : undefined,
    queryCache:
      srv && "queryCache" in srv ? (srv.queryCache as ServerAccessor["queryCache"]) : undefined,
    log: req.log,
  };

  // Lift the two fields every tenant-scoped controller reaches for into a
  // first-class projection so overrides don't have to dig through
  // `metadata._scope`. Full scope shape still lives on metadata._scope for
  // code that branches on `scope.kind`. See `buildRequestScopeProjection`.
  // (v2.10.8: same projection is shared with `ResourceHookContext.scope`
  // so controllers and hooks read tenant/user the same way.)
  const rawScope = reqWithExtras.scope as RequestScope | undefined;
  const scopeProjection = buildRequestScopeProjection(rawScope);

  return {
    query: (reqWithExtras.query ?? {}) as Record<string, unknown>,
    body: (reqWithExtras.body ?? {}) as Record<string, unknown>,
    params: (reqWithExtras.params ?? {}) as Record<string, string>,
    headers: reqWithExtras.headers as Record<string, string | undefined>,
    user: reqWithExtras.user
      ? (() => {
          const user = reqWithExtras.user as AnyRecord;
          const rawId = user._id ?? user.id;
          const normalizedId = rawId ? String(rawId) : undefined;
          return {
            ...user,
            // Normalize ID for MongoDB compatibility
            id: normalizedId,
            _id: normalizedId,
            // Preserve original role/roles/permissions as-is
            // Devs can define their own authorization structure
          } as import("../permissions/types.js").UserBase;
        })()
      : null,
    // Typed org/auth context — use this in controller overrides
    context: requestContext,
    // First-class scope projection (v2.10.6) — see RequestScopeProjection
    scope: scopeProjection,
    // Internal metadata — includes context + Arc internals
    metadata: {
      ...reqWithExtras.context,
      // Include Arc metadata for hook execution
      arc: reqWithExtras.arc,
      // Include scope for org ID and elevation checks
      _scope: rawScope,
      // Include ownership check for access control
      _ownershipCheck: reqWithExtras._ownershipCheck,
      // Policy filters — ONLY from trusted middleware (req._policyFilters)
      // SECURITY: Never merge user-supplied query._policyFilters — they are untrusted
      _policyFilters: reqWithExtras._policyFilters ?? {},
      // Include logger for logging
      log: reqWithExtras.log,
    },
    // Server accessor — publish events, log, and audit from any handler
    server: serverAccessor,
  };
}

/**
 * Get typed auth context from an IRequestContext.
 * Use this in controller overrides to access request context.
 *
 * For org scope, use `getControllerScope(req)` instead.
 */
export function getControllerContext(req: IRequestContext): RequestContext {
  return (req.context ?? req.metadata ?? {}) as RequestContext;
}

/**
 * Get request scope from an IRequestContext.
 * Returns the RequestScope set by auth adapters.
 */
export function getControllerScope(req: IRequestContext): RequestScope {
  return (req.metadata as ArcInternalMetadata | undefined)?._scope ?? PUBLIC_SCOPE;
}

/**
 * Compute per-field capability metadata for the current user.
 * Only includes fields that have restrictions — unrestricted fields
 * are omitted (frontend defaults to { readable: true, writable: true }).
 */
function computeFieldCapabilities(
  fieldPerms: FieldPermissionMap,
  effectiveRoles: string[],
): Record<string, { readable: boolean; writable: boolean }> {
  const caps: Record<string, { readable: boolean; writable: boolean }> = {};
  for (const [field, perm] of Object.entries(fieldPerms)) {
    let readable = true;
    let writable = true;
    switch (perm._type) {
      case "hidden":
        readable = false;
        writable = false;
        break;
      case "visibleTo":
        readable = perm.roles?.some((r) => effectiveRoles.includes(r)) ?? false;
        break;
      case "writableBy":
        writable = perm.roles?.some((r) => effectiveRoles.includes(r)) ?? false;
        break;
      // redactFor: field is readable (but redacted) and writable — no restriction flags
    }
    caps[field] = { readable, writable };
  }
  return caps;
}

/**
 * Send IControllerResponse via Fastify reply
 *
 * Converts framework-agnostic response to Fastify response
 * Applies field masking if specified in request
 */
export function sendControllerResponse<T>(
  reply: FastifyReply,
  response: IControllerResponse<T>,
  request?: FastifyRequest,
): void {
  // Extract field mask from request if available
  const reqWithExtras = request as RequestWithExtras | undefined;
  const fieldMaskConfig = reqWithExtras?.fieldMask;

  // Extract field-level permissions from arc metadata (set by arcDecorator)
  const arcMeta = (reqWithExtras as unknown as AnyRecord | undefined)?.arc as AnyRecord | undefined;
  const scope = (reqWithExtras?.scope as RequestScope) ?? PUBLIC_SCOPE;

  // Elevated scope (platform admin) skips field restrictions —
  // consistent with requireOrgRole() and _sanitizeBody() bypass logic.
  const fieldPerms = isElevated(scope)
    ? undefined
    : (arcMeta?.fields as FieldPermissionMap | undefined);

  // Only compute roles when field permissions require them
  const effectiveRoles = fieldPerms
    ? resolveEffectiveRoles(
        getUserRoles(reqWithExtras?.user as Record<string, unknown> | undefined),
        isMember(scope) ? scope.orgRoles : [],
      )
    : [];

  // Compute field capabilities metadata for frontend consumption (opt-in per resource)
  // Named `fieldCaps` to avoid variable shadowing with createCrudRouter's `fieldPermissions`
  const fieldCaps = fieldPerms ? computeFieldCapabilities(fieldPerms, effectiveRoles) : undefined;

  // Only create permission applicator when needed
  const hasFieldRestrictions = !!(fieldMaskConfig || fieldPerms);

  /** Apply both field mask and field-level permissions to a data item */
  const applyPermissions = <D>(data: D): D => {
    let result = fieldMaskConfig ? applyFieldMask(data, fieldMaskConfig) : data;
    if (fieldPerms && result && typeof result === "object") {
      if (Array.isArray(result)) {
        result = result.map((item) =>
          applyFieldReadPermissions(item as AnyRecord, fieldPerms, effectiveRoles),
        ) as D;
      } else {
        result = applyFieldReadPermissions(result as AnyRecord, fieldPerms, effectiveRoles) as D;
      }
    }
    return result;
  };

  // Set custom response headers from controller
  if (response.headers) {
    for (const [key, value] of Object.entries(response.headers)) {
      reply.header(key, value);
    }
  }

  // Handle paginated responses specially (flatten to Arc's ApiResponse format)
  if (
    response.success &&
    response.data &&
    typeof response.data === "object" &&
    "docs" in response.data
  ) {
    const paginatedData = response.data as unknown as OffsetPaginationResult<unknown>;
    const filteredDocs = hasFieldRestrictions
      ? applyPermissions(paginatedData.docs)
      : paginatedData.docs;

    reply.code(response.status ?? 200).send({
      success: true,
      docs: filteredDocs,
      page: paginatedData.page,
      limit: paginatedData.limit,
      total: paginatedData.total,
      pages: paginatedData.pages,
      hasNext: paginatedData.hasNext,
      hasPrev: paginatedData.hasPrev,
      ...(response.meta ?? {}),
      ...(fieldCaps ? { fieldPermissions: fieldCaps } : {}),
    });
    return;
  }

  // Handle standard responses
  const filteredData = hasFieldRestrictions ? applyPermissions(response.data) : response.data;

  reply.code(response.status ?? (response.success ? 200 : 400)).send({
    success: response.success,
    data: filteredData,
    error: response.error,
    details: response.details,
    ...(response.meta ?? {}),
    ...(fieldCaps ? { fieldPermissions: fieldCaps } : {}),
  });
}

/**
 * Create Fastify route handler from IController method
 *
 * Wraps framework-agnostic controller method in Fastify-specific handler
 *
 * @example
 * ```typescript
 * const controller = new BaseController(repository);
 *
 * // Create Fastify handler
 * const listHandler = createFastifyHandler(controller.list.bind(controller));
 *
 * // Register route
 * fastify.get('/products', listHandler);
 * ```
 */
export function createFastifyHandler<T>(
  controllerMethod: (req: IRequestContext) => Promise<IControllerResponse<T>>,
) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const requestContext = createRequestContext(req);
    const response = await controllerMethod(requestContext);
    sendControllerResponse(reply, response, req);
  };
}

/**
 * Create Fastify adapters for all CRUD methods of an IController
 *
 * Returns Fastify-compatible handlers for each CRUD operation
 *
 * @example
 * ```typescript
 * const controller = new BaseController(repository);
 * const handlers = createCrudHandlers(controller);
 *
 * fastify.get('/', handlers.list);
 * fastify.get('/:id', handlers.get);
 * fastify.post('/', handlers.create);
 * fastify.patch('/:id', handlers.update);
 * fastify.delete('/:id', handlers.delete);
 * ```
 */
export function createCrudHandlers<TDoc>(controller: IController<TDoc>) {
  return {
    list: createFastifyHandler(controller.list.bind(controller)),
    get: createFastifyHandler(controller.get.bind(controller)),
    create: createFastifyHandler(controller.create.bind(controller)),
    update: createFastifyHandler(controller.update.bind(controller)),
    delete: createFastifyHandler(controller.delete.bind(controller)),
  };
}
