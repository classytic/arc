/**
 * Handler Types - Controller and Route Handler Definitions
 *
 * Two handler patterns supported:
 * 1. ControllerHandler - Arc's standard pattern (receives context object)
 * 2. FastifyHandler - Fastify native pattern (receives request, reply)
 *
 * Use `raw: false` for ControllerHandler, `raw: true` for FastifyHandler.
 */

import type { FastifyReply, FastifyRequest } from "fastify";
import type { UserBase } from "../permissions/types.js";
import type { RequestContext } from "./index.js";

/**
 * Minimal server accessor — exposes safe, read-only server decorators.
 * Allows controller handlers to publish events, log, and audit
 * without switching to `raw: true`.
 */
export interface ServerAccessor {
  /** Event bus — publish domain events from any handler */
  events?: {
    publish: <T>(
      type: string,
      payload: T,
      meta?: Partial<Record<string, unknown>>,
    ) => Promise<void>;
  };
  /** Audit logger — log custom audit entries */
  audit?: {
    create: (
      resource: string,
      documentId: string,
      data: Record<string, unknown>,
      context?: Record<string, unknown>,
    ) => Promise<void>;
    update: (
      resource: string,
      documentId: string,
      before: Record<string, unknown>,
      after: Record<string, unknown>,
      context?: Record<string, unknown>,
    ) => Promise<void>;
    delete: (
      resource: string,
      documentId: string,
      data: Record<string, unknown>,
      context?: Record<string, unknown>,
    ) => Promise<void>;
    custom: (
      resource: string,
      documentId: string,
      action: string,
      data?: Record<string, unknown>,
      context?: Record<string, unknown>,
    ) => Promise<void>;
  };
  /** Logger — structured logging */
  log?: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
    debug: (...args: unknown[]) => void;
  };
  /** QueryCache — stale-while-revalidate data cache */
  queryCache?: {
    get: <T>(key: string) => Promise<{ data: T; status: "fresh" | "stale" | "miss" }>;
    set: <T>(
      key: string,
      data: T,
      config: { staleTime?: number; gcTime?: number; tags?: string[] },
    ) => Promise<void>;
    getResourceVersion: (resource: string) => Promise<number>;
    bumpResourceVersion: (resource: string) => Promise<void>;
  };
}

/**
 * Request context passed to controller handlers.
 *
 * **Generic parameters** (all default to safe permissive types so existing code keeps working):
 * - `TBody`     — request body shape (default: `unknown`)
 * - `TParams`   — route param shape (default: `Record<string, string>`)
 * - `TQuery`    — query string shape (default: `Record<string, unknown>`)
 * - `TUser`     — authenticated user shape (default: `UserBase`)
 * - `TMetadata` — internal metadata shape (default: `Record<string, unknown>`;
 *   override with `ArcInternalMetadata` or your own augmentation when you
 *   need typed access to `_scope`, `_policyFilters`, custom hook context, etc.)
 *
 * @example
 * ```typescript
 * // Untyped (default) — req.body is `unknown`, must be narrowed
 * async create(req: IRequestContext) {
 *   const data = req.body as Partial<Product>;
 *   return { success: true, data: await productRepo.create(data) };
 * }
 *
 * // Typed body — req.body is `CreateProductInput`, narrowing not needed
 * async create(req: IRequestContext<CreateProductInput>) {
 *   return { success: true, data: await productRepo.create(req.body) };
 * }
 *
 * // Fully typed — body, route params, query, and metadata
 * async update(
 *   req: IRequestContext<
 *     Partial<Product>,
 *     { id: string },
 *     { fields?: string },
 *     ArcInternalMetadata
 *   >,
 * ) {
 *   const fields = req.query.fields?.split(',');
 *   const orgId = req.metadata?._scope ? getOrgId(req.metadata._scope) : undefined;
 *   return { success: true, data: await productRepo.update(req.params.id, req.body) };
 * }
 * ```
 */
/**
 * First-class projection of `request._scope` for controller handlers.
 *
 * **v2.10.6:** previously, pulling tenant/user/role info from inside a
 * controller override meant digging through `req.metadata._scope` and
 * calling `getOrgId(scope)` / `getUserId(user)` manually. This projection
 * lifts the two fields most hosts need directly onto `req` so cross-kit
 * controller code reads:
 *
 * ```ts
 * async create(req: IRequestContext) {
 *   const flowCtx = { organizationId: req.scope?.organizationId, actorId: req.scope?.userId };
 * }
 * ```
 *
 * Full scope shape (discriminated union of `member` / `service` / `elevated` / `public`)
 * still lives on `req.metadata._scope` for code that needs to branch on
 * `scope.kind` — this projection just surfaces the two keys every
 * tenant-scoped resource reaches for.
 */
export interface RequestScopeProjection {
  /** Tenant the caller is scoped to (org member, service key bound to an org, or elevated admin's target org). */
  organizationId?: string;
  /** Caller's user id when authenticated — undefined for public / service-only scopes. */
  userId?: string;
  /** Org-level roles (e.g. `['admin', 'warehouse-manager']`) — separate from global `user.roles`. */
  orgRoles?: string[];
}

export interface IRequestContext<
  TBody = unknown,
  TParams extends Record<string, string> = Record<string, string>,
  TQuery extends Record<string, unknown> = Record<string, unknown>,
  TUser extends UserBase = UserBase,
  TMetadata extends Record<string, unknown> = Record<string, unknown>,
> {
  /** Route parameters (e.g., { id: '123' }) */
  params: TParams;
  /** Query string parameters */
  query: TQuery;
  /** Request body */
  body: TBody;
  /** Authenticated user or null */
  user: TUser | null;
  /** Request headers */
  headers: Record<string, string | undefined>;
  /** Organization ID (for multi-tenant apps) */
  organizationId?: string;
  /** Team ID (for team-scoped resources) */
  teamId?: string;
  /**
   * First-class tenant/user scope projection — lifted from `metadata._scope`
   * so controller overrides don't have to dig through Arc internals.
   * See {@link RequestScopeProjection}. `undefined` for routes that run
   * without auth / scope resolution.
   */
  scope?: RequestScopeProjection;
  /**
   * Organization/auth context from middleware.
   * Contains orgRoles, orgScope, organizationId, and any custom fields
   * set by the auth adapter or org-scope plugin.
   *
   * @example
   * ```typescript
   * async create(req: IRequestContext) {
   *   const roles = req.context?.orgRoles ?? [];
   *   if (roles.includes('manager')) { ... }
   * }
   * ```
   */
  context?: RequestContext;
  /**
   * Internal metadata (includes context + Arc internals like `_policyFilters`,
   * `_scope`, `log`). Type as `ArcInternalMetadata` for typed access to Arc's
   * built-in fields, or supply your own interface to layer custom fields.
   */
  metadata?: TMetadata;
  /**
   * Fastify server accessor — publish events, log, and audit
   * from any handler without switching to `raw: true`.
   *
   * @example
   * ```typescript
   * async reschedule(req: IRequestContext) {
   *   const result = await repo.reschedule(req.params.id, req.body);
   *   await req.server?.events?.publish('interview.rescheduled', { data: result });
   *   return { data: result };
   * }
   * ```
   */
  server?: ServerAccessor;
}

/**
 * Controller response shape — the success-path return from any handler.
 *
 * Errors throw `ArcError` (or any `HttpError`-shaped class); the global
 * error handler catches them and emits an `ErrorContract`. There is no
 * `success` discriminator on the response — HTTP status is the wire
 * discriminator (2xx = data, 4xx/5xx = ErrorContract).
 */
export interface IControllerResponse<T = unknown> {
  /** Response payload — emitted directly to the wire (no envelope wrap). */
  data: T;
  /** HTTP status code. Defaults to 200. */
  status?: number;
  /** Custom response headers (e.g. X-Total-Count, Link, ETag). */
  headers?: Record<string, string>;
  /** Top-level metadata merged into list-shaped responses (e.g. `{ took }`). */
  meta?: Record<string, unknown>;
}

/**
 * Controller handler — Arc's standard pattern.
 *
 * Receives a request context object, returns IControllerResponse.
 * Use with `raw: false` in routes.
 *
 * **Generic parameters:**
 * - `TResponse` — shape of `IControllerResponse.data` (default: `unknown`)
 * - `TBody`     — shape of `req.body` (default: `unknown`)
 * - `TParams`   — shape of `req.params` (default: `Record<string, string>`)
 * - `TQuery`    — shape of `req.query` (default: `Record<string, unknown>`)
 *
 * Backward-compatible: `ControllerHandler<Product>` still works (only the
 * response data is typed); add more generics as needed when you want
 * type-safe access to the request body, params, or query string.
 *
 * @example
 * ```typescript
 * // Untyped req — body is unknown, must be narrowed
 * const createProduct: ControllerHandler<Product> = async (req) => {
 *   const product = await productRepo.create(req.body as Partial<Product>);
 *   return { data: product, status: 201 };
 * };
 *
 * // Fully typed — body, params, query, and response all inferred
 * const updateProduct: ControllerHandler<
 *   Product,
 *   Partial<Product>,
 *   { id: string },
 *   { upsert?: string }
 * > = async (req) => {
 *   const upsert = req.query.upsert === "true";
 *   const product = await productRepo.update(req.params.id, req.body, { upsert });
 *   return { data: product };
 * };
 *
 * routes: [{
 *   method: 'POST',
 *   path: '/products',
 *   handler: createProduct,
 *   permissions: requireAuth(),
 *   raw: false,  // Arc wraps this into Fastify handler
 * }]
 * ```
 */
export type ControllerHandler<
  TResponse = unknown,
  TBody = unknown,
  TParams extends Record<string, string> = Record<string, string>,
  TQuery extends Record<string, unknown> = Record<string, unknown>,
> = (req: IRequestContext<TBody, TParams, TQuery>) => Promise<IControllerResponse<TResponse>>;

/**
 * Fastify native handler
 *
 * Standard Fastify request/reply pattern.
 * Use with `raw: true` in routes.
 *
 * @example
 * ```typescript
 * const downloadFile: FastifyHandler = async (request, reply) => {
 *   const file = await getFile(request.params.id);
 *   reply.header('Content-Type', file.mimeType);
 *   return reply.send(file.buffer);
 * };
 *
 * routes: [{
 *   method: 'GET',
 *   path: '/files/:id/download',
 *   handler: downloadFile,
 *   permissions: requireAuth(),
 *   raw: true,  // Use as-is, no wrapping
 * }]
 * ```
 */
export type FastifyHandler<RouteGeneric extends Record<string, unknown> = Record<string, unknown>> =
  (request: FastifyRequest<RouteGeneric>, reply: FastifyReply) => Promise<unknown> | unknown;

/**
 * Union type for route handlers
 */
export type RouteHandler = ControllerHandler | FastifyHandler;

/**
 * Controller interface for CRUD operations (strict).
 *
 * `list`'s return type aligns with repo-core's `MinimalRepo.getAll()`
 * contract — the kit MAY return an offset envelope, a keyset envelope,
 * or a raw array. Arc's `BaseController` forwards the kit's response
 * verbatim; consumers narrow on shape
 * (`Array.isArray(data)` → bare array, presence of `total` → offset,
 * presence of `nextCursor` → keyset).
 */
export interface IController<TDoc = unknown> {
  list(req: IRequestContext): Promise<IControllerResponse<unknown>>;
  get(req: IRequestContext): Promise<IControllerResponse<TDoc>>;
  create(req: IRequestContext): Promise<IControllerResponse<TDoc>>;
  update(req: IRequestContext): Promise<IControllerResponse<TDoc>>;
  delete(req: IRequestContext): Promise<IControllerResponse<{ message: string }>>;
}

/**
 * Flexible controller interface — accepts controllers with any handler style,
 * including class instances with extra methods / private fields.
 *
 * **v2.10.6:** the previous `[key: string]: unknown` index signature made
 * real class instances fail structural assignment (`new ScrapController()`
 * needed a `as unknown as ControllerLike` cast, because class instances
 * don't have an index signature). Dropped — arc only invokes the CRUD
 * methods at runtime, so the rest of the shape is the caller's concern.
 *
 * The five CRUD slots stay optional so partial controllers (e.g. read-only)
 * assign too. Additional domain methods on the controller are allowed by
 * construction (they're just not part of this contract).
 */
export interface ControllerLike {
  list?: unknown;
  get?: unknown;
  create?: unknown;
  update?: unknown;
  delete?: unknown;
}
