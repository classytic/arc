/**
 * Fastify ↔ arc-controller seam.
 *
 * Arc is Fastify-only on the HTTP edge — this file is the one place where
 * Fastify's `req` / `reply` get translated into arc's `IRequestContext` /
 * `IControllerResponse`. The translation earns its keep on two grounds:
 *
 *   1. **MCP shares the controllers.** `src/integrations/mcp/` invokes
 *      the same `IController.list/get/create/update/delete` methods as
 *      HTTP routes — controllers that spoke `FastifyRequest` directly
 *      would force MCP to fake a request shape. One controller, two
 *      surfaces, no shadow code.
 *   2. **Arc-specific projections** — `req.scope` (RBAC), `req.server`
 *      (events / audit / queryCache decorators), `req.metadata` (hooks +
 *      policy filters). These are arc concepts not native to Fastify;
 *      this is where they get stamped onto the per-request context.
 *
 * Not a "future framework adapter" — arc has no plan to support
 * Express / Hono / etc. The naming sticks for back-compat, but the role
 * is the seam between Fastify and arc's controller call, not portability.
 */

import type { AnyPaginationResult } from "@classytic/repo-core/pagination";
import { isPaginatedResult, toCanonicalList } from "@classytic/repo-core/pagination";
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
 * Project `FastifyRequest` into the curated `IRequestContext` shape that
 * arc's controllers receive. This is a developer-facing facade, not a
 * portability boundary — arc is Fastify-only. The projection lifts the
 * fields tenant-scoped controllers reach for (`organizationId`,
 * `teamId`, `scope`, `context`, server accessor) onto a flat, typed
 * surface so handler code doesn't have to dig through Fastify's
 * decorator surface or `req.metadata._scope` internals.
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
 * Send a controller's `IControllerResponse` through Fastify's reply.
 *
 * The `IControllerResponse<T>` envelope is arc's internal pipeline
 * contract — it's how custom `status`, `meta`, `headers`, and field
 * permissions thread from a handler through interceptors to the wire
 * without each step having to touch `reply` directly. Not a portability
 * abstraction (arc is Fastify-only); a pipeline-internal one.
 *
 * **Auto-envelope of bare returns.** Custom route handlers are
 * expected to return the envelope shape so this function can apply
 * field permissions, attach `fieldCaps`, and flatten paginated lists.
 * A handler that returns raw `T` (array, plain object, primitive) used
 * to silently produce a broken response — `response.data` was
 * `undefined`, the body sent was `undefined`, and any declared
 * `fields:` permission map was bypassed (the leak shape mentora
 * flagged). 2.17 detects bare returns and wraps them into
 * `{ data: response, status: 200 }` before the field-permission
 * pipeline runs, so `fields:` applies to ALL custom routes whether the
 * handler envelopes its return value or not. The envelope shape is
 * still the canonical contract — auto-wrapping is a safety net, not
 * an invitation to drop the envelope.
 */
export function sendControllerResponse<T>(
  reply: FastifyReply,
  response: IControllerResponse<T>,
  request?: FastifyRequest,
): void {
  // Auto-envelope: a bare return (no `.data` slot) gets wrapped so the
  // field-permission + pagination flatten paths below see the canonical
  // shape. Distinguishes an envelope with `data: undefined`/`null` (kept
  // as-is — handler may want to send empty body) from a non-envelope
  // value by checking for the presence of the `data` key.
  if (
    response === null ||
    typeof response !== "object" ||
    !Object.hasOwn(response as object, "data")
  ) {
    response = { data: response as unknown as T, status: 200 } as IControllerResponse<T>;
  }

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

  // List-shaped responses — flatten via repo-core's `toCanonicalList` so
  // the wire shape always matches the typed-client (`@classytic/arc-next`)
  // contract regardless of which kit produced the result.
  //
  // Detection signal: presence of an array `data` field on the response
  // payload. That covers the three shapes kits emit:
  //   1. Modern paginated result — has `method` discriminant + `data: T[]`.
  //   2. Legacy paginated result — has `page`+`limit`+`total` but no
  //      `method` (pre-repo-core-0.2.0 callers / mocks). Back-fill
  //      `method: 'offset'` so clients still see the discriminant.
  //   3. Bare list — `{ data: T[] }` only (no pagination metadata).
  if (
    response.data &&
    typeof response.data === "object" &&
    Array.isArray((response.data as { data?: unknown }).data)
  ) {
    const payload = response.data as unknown as
      | AnyPaginationResult<unknown>
      | { data: unknown[]; page?: number; limit?: number; total?: number };

    // Apply field-level read permissions BEFORE handing to toCanonicalList
    // so the spread on the paginated path keeps the filtered rows.
    const filteredRows = hasFieldRestrictions
      ? (applyPermissions(payload.data) as unknown[])
      : (payload.data as unknown[]);

    let canonical: ReturnType<typeof toCanonicalList>;
    if (isPaginatedResult(payload)) {
      canonical = toCanonicalList({
        ...(payload as AnyPaginationResult<unknown>),
        data: filteredRows,
      });
    } else if (
      typeof (payload as { page?: unknown }).page === "number" &&
      typeof (payload as { limit?: unknown }).limit === "number" &&
      typeof (payload as { total?: unknown }).total === "number"
    ) {
      canonical = toCanonicalList({
        method: "offset" as const,
        data: filteredRows,
        page: (payload as { page: number }).page,
        limit: (payload as { limit: number }).limit,
        total: (payload as { total: number }).total,
        pages:
          (payload as { pages?: number }).pages ??
          Math.ceil(
            (payload as { total: number }).total /
              Math.max(1, (payload as { limit: number }).limit),
          ),
        hasNext: (payload as { hasNext?: boolean }).hasNext ?? false,
        hasPrev: (payload as { hasPrev?: boolean }).hasPrev ?? false,
      });
    } else {
      canonical = toCanonicalList(filteredRows);
    }

    reply.code(response.status ?? 200).send({
      ...canonical,
      ...(response.meta ?? {}),
      ...(fieldCaps ? { fieldPermissions: fieldCaps } : {}),
    });
    return;
  }

  // Single-doc / scalar response — emit data raw (no envelope; HTTP status
  // discriminates success vs error). `fieldCaps`/`meta` merge in only when
  // the data is an object; otherwise they would clobber primitive payloads.
  //
  // Mongoose documents carry framework internals (`$__`, `_doc`, `$isNew`)
  // as enumerable own properties, so a naive `{...doc}` spread leaks them
  // onto the wire. Call `.toJSON()` first (every mongoose doc implements
  // it; it returns the projected `_doc` minus internals + applies any
  // toJSON transforms the schema declares). Plain objects pass through.
  const rawData = hasFieldRestrictions ? applyPermissions(response.data) : response.data;
  const filteredData =
    rawData !== null &&
    typeof rawData === "object" &&
    typeof (rawData as unknown as { toJSON?: () => unknown }).toJSON === "function"
      ? ((rawData as unknown as { toJSON: () => unknown }).toJSON() as typeof rawData)
      : rawData;
  const status = response.status ?? 200;
  const isObject =
    filteredData !== null && typeof filteredData === "object" && !Array.isArray(filteredData);

  if (isObject && (response.meta || fieldCaps)) {
    reply.code(status).send({
      ...(filteredData as object),
      ...(response.meta ?? {}),
      ...(fieldCaps ? { fieldPermissions: fieldCaps } : {}),
    });
    return;
  }
  reply.code(status).send(filteredData);
}

/**
 * Bridge an `IController` method (`(ctx: IRequestContext) => Promise<IControllerResponse<T>>`)
 * into a Fastify route handler. Translates between arc's curated request
 * context surface and Fastify's request/reply, and routes the envelope
 * through `sendControllerResponse` so the pipeline applies field
 * permissions, status, and meta uniformly. Internal plumbing, not a
 * portability layer — arc is Fastify-only.
 *
 * @example
 * ```typescript
 * const controller = new BaseController(repository);
 * const listHandler = createFastifyHandler(controller.list.bind(controller));
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
