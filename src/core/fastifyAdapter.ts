/**
 * Fastify ↔ arc-controller seam: the one place Fastify's `req` / `reply` are
 * translated into `IRequestContext` / `IControllerResponse`.
 *
 * Why the translation exists: MCP invokes the same controller methods as HTTP
 * routes without a `FastifyRequest`, and arc-specific projections (`scope`,
 * `server` decorators, `metadata` hooks + policy filters) are stamped here.
 * Not a portability layer — arc is Fastify-only.
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

/** Apply an include/exclude field mask to a single object. */
function applyFieldMaskToObject(
  obj: AnyRecord | null | undefined,
  fieldMask: { include?: string[]; exclude?: string[] },
): AnyRecord | null | undefined {
  if (!obj || typeof obj !== "object") return obj;

  const plain = isMongooseDoc(obj) ? (obj.toObject() as AnyRecord) : obj;

  const { include, exclude } = fieldMask;

  if (include && include.length > 0) {
    const filtered: AnyRecord = {};
    for (const field of include) {
      if (field in plain) {
        filtered[field] = plain[field];
      }
    }
    return filtered;
  }

  if (exclude && exclude.length > 0) {
    const filtered: AnyRecord = { ...plain };
    for (const field of exclude) {
      delete filtered[field];
    }
    return filtered;
  }

  return plain;
}

/** Apply a field mask to an object or array of objects. */
function applyFieldMask<T>(
  data: T,
  fieldMask: { include?: string[]; exclude?: string[] } | undefined,
): T {
  if (!fieldMask) return data;

  if (Array.isArray(data)) {
    return data.map((item) => applyFieldMaskToObject(item as AnyRecord, fieldMask)) as T;
  }

  if (data && typeof data === "object") {
    return applyFieldMaskToObject(data as AnyRecord, fieldMask) as T;
  }

  return data;
}

/**
 * Project `FastifyRequest` into the `IRequestContext` controllers receive,
 * lifting scope, context, and a server accessor onto a flat, typed surface.
 */
export function createRequestContext(req: FastifyRequest): IRequestContext {
  const reqWithExtras = req as RequestWithExtras;
  const requestContext = (reqWithExtras.context ?? {}) as RequestContext;

  // `in` checks: these decorators exist only when their plugins are registered.
  const srv = req.server as unknown as Record<string, unknown> | undefined;
  const serverAccessor: ServerAccessor = {
    events: srv && "events" in srv ? (srv.events as ServerAccessor["events"]) : undefined,
    audit: srv && "audit" in srv ? (srv.audit as ServerAccessor["audit"]) : undefined,
    queryCache:
      srv && "queryCache" in srv ? (srv.queryCache as ServerAccessor["queryCache"]) : undefined,
    log: req.log,
  };

  // Same projection as `ResourceHookContext.scope`; the full scope stays on `metadata._scope`.
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
            // `id` and `_id` both set, as strings; role fields pass through untouched.
            id: normalizedId,
            _id: normalizedId,
          } as import("../permissions/types.js").UserBase;
        })()
      : null,
    context: requestContext,
    scope: scopeProjection,
    metadata: {
      ...reqWithExtras.context,
      arc: reqWithExtras.arc,
      _scope: rawScope,
      _ownershipCheck: reqWithExtras._ownershipCheck,
      // A cross-tenant read decided by the preset; the layers below re-derive
      // tenancy from the scope and would otherwise each undo that decision.
      _crossTenantRead: reqWithExtras._crossTenantRead,
      // SECURITY: only from trusted middleware — never merge user-supplied query._policyFilters.
      _policyFilters: reqWithExtras._policyFilters ?? {},
      log: reqWithExtras.log,
    },
    server: serverAccessor,
  };
}

/**
 * Typed auth context from an IRequestContext, for controller overrides.
 * For org scope, use `getControllerScope(req)`.
 */
export function getControllerContext(req: IRequestContext): RequestContext {
  return (req.context ?? req.metadata ?? {}) as RequestContext;
}

/** The RequestScope set by auth adapters (`PUBLIC_SCOPE` when absent). */
export function getControllerScope(req: IRequestContext): RequestScope {
  return (req.metadata as ArcInternalMetadata | undefined)?._scope ?? PUBLIC_SCOPE;
}

/**
 * Per-field capability metadata for the current user. Only restricted fields
 * appear; clients default the rest to `{ readable: true, writable: true }`.
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
 * Send a controller's `IControllerResponse` envelope (status, meta, headers)
 * through Fastify's reply, applying field masks and field read permissions.
 *
 * A bare return (no `data` key) is wrapped as `{ data, status: 200 }` so
 * `fields:` permissions still apply — otherwise restricted fields would leak.
 * The envelope remains the canonical contract.
 */
export function sendControllerResponse<T>(
  reply: FastifyReply,
  response: IControllerResponse<T>,
  request?: FastifyRequest,
): void {
  // Key presence, not value: `{ data: undefined }` is a real envelope (empty body).
  if (
    response === null ||
    typeof response !== "object" ||
    !Object.hasOwn(response as object, "data")
  ) {
    response = { data: response as T, status: 200 } as IControllerResponse<T>;
  }

  const reqWithExtras = request as RequestWithExtras | undefined;
  const fieldMaskConfig = reqWithExtras?.fieldMask;

  const arcMeta = (reqWithExtras as AnyRecord | undefined)?.arc as AnyRecord | undefined;
  const scope = (reqWithExtras?.scope as RequestScope) ?? PUBLIC_SCOPE;

  // Elevated scope (platform admin) skips field restrictions, like the write-side sanitizer.
  const fieldPerms = isElevated(scope)
    ? undefined
    : (arcMeta?.fields as FieldPermissionMap | undefined);

  const effectiveRoles = fieldPerms
    ? resolveEffectiveRoles(
        getUserRoles(reqWithExtras?.user as Record<string, unknown> | undefined),
        isMember(scope) ? scope.orgRoles : [],
      )
    : [];

  const fieldCaps = fieldPerms ? computeFieldCapabilities(fieldPerms, effectiveRoles) : undefined;

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

  if (response.headers) {
    for (const [key, value] of Object.entries(response.headers)) {
      reply.header(key, value);
    }
  }

  // List-shaped (array `data`) → `toCanonicalList`, so the wire shape is kit-independent.
  // Shapes: paginated with `method`; offset-style `page`/`limit`/`total` without `method`
  // (back-filled as 'offset'); bare `{ data: T[] }`.
  if (
    response.data &&
    typeof response.data === "object" &&
    Array.isArray((response.data as { data?: unknown }).data)
  ) {
    const payload = response.data as unknown as
      | AnyPaginationResult<unknown>
      | { data: unknown[]; page?: number; limit?: number; total?: number };

    // Filter BEFORE toCanonicalList so the paginated spread keeps the filtered rows.
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

  // Single-doc / scalar: data raw, no envelope. `meta`/`fieldCaps` merge only into objects.
  // `.toJSON()` first — a `{...doc}` spread of a Mongoose doc leaks `$__`, `_doc`, etc.
  const rawData = hasFieldRestrictions ? applyPermissions(response.data) : response.data;
  const filteredData =
    rawData !== null &&
    typeof rawData === "object" &&
    typeof (rawData as { toJSON?: () => unknown }).toJSON === "function"
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
 * Bridge an `IController` method into a Fastify route handler, sending the
 * envelope through `sendControllerResponse`.
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
  return async (req: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
    const requestContext = createRequestContext(req);
    const response = await controllerMethod(requestContext);
    sendControllerResponse(reply, response, req);
    // Return `reply` ("response owned"): resolving `undefined` lets Fastify flush an
    // empty body while an async `preSerialization`/`onSend` hook is still running,
    // then the real body hits ERR_HTTP_HEADERS_SENT.
    return reply;
  };
}

/**
 * Fastify handlers for each CRUD method of an IController.
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
