/**
 * Handler Types - Controller and Route Handler Definitions
 *
 * Two handler patterns supported:
 * 1. ControllerHandler - Arc's standard pattern (receives context object)
 * 2. FastifyHandler - Fastify native pattern (receives request, reply)
 *
 * Use `wrapHandler: true` for ControllerHandler, `wrapHandler: false` for FastifyHandler.
 */

import type { FastifyRequest, FastifyReply } from 'fastify';
import type { UserBase } from '../permissions/types.js';
import type { RequestContext } from './index.js';

/**
 * Minimal server accessor — exposes safe, read-only server decorators.
 * Allows controller handlers to publish events, log, and audit
 * without switching to `wrapHandler: false`.
 */
export interface ServerAccessor {
  /** Event bus — publish domain events from any handler */
  events?: {
    publish: <T>(type: string, payload: T, meta?: Partial<Record<string, unknown>>) => Promise<void>;
  };
  /** Audit logger — log custom audit entries */
  audit?: {
    create: (resource: string, documentId: string, data: Record<string, unknown>, context?: Record<string, unknown>) => Promise<void>;
    update: (resource: string, documentId: string, before: Record<string, unknown>, after: Record<string, unknown>, context?: Record<string, unknown>) => Promise<void>;
    delete: (resource: string, documentId: string, data: Record<string, unknown>, context?: Record<string, unknown>) => Promise<void>;
    custom: (resource: string, documentId: string, action: string, data?: Record<string, unknown>, context?: Record<string, unknown>) => Promise<void>;
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
    get: <T>(key: string) => Promise<{ data: T; status: 'fresh' | 'stale' | 'miss' }>;
    set: <T>(key: string, data: T, config: { staleTime?: number; gcTime?: number; tags?: string[] }) => Promise<void>;
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
   * from any handler without switching to `wrapHandler: false`.
   *
   * @example
   * ```typescript
   * async reschedule(req: IRequestContext) {
   *   const result = await repo.reschedule(req.params.id, req.body);
   *   await req.server?.events?.publish('interview.rescheduled', { data: result });
   *   return { success: true, data: result };
   * }
   * ```
   */
  server?: ServerAccessor;
}

/**
 * Standard response from controller handlers
 */
export interface IControllerResponse<T = unknown> {
  /** Operation success status */
  success: boolean;
  /** Response data */
  data?: T;
  /** Error message (when success is false) */
  error?: string;
  /** HTTP status code (default: 200 for success, 400 for error) */
  status?: number;
  /** Additional metadata */
  meta?: Record<string, unknown>;
  /** Error details (for debugging) */
  details?: Record<string, unknown>;
  /** Custom response headers (e.g., X-Total-Count, Link, ETag) */
  headers?: Record<string, string>;
}

/**
 * Controller handler — Arc's standard pattern.
 *
 * Receives a request context object, returns IControllerResponse.
 * Use with `wrapHandler: true` in additionalRoutes.
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
 *   return { success: true, data: product, status: 201 };
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
 *   return { success: true, data: product };
 * };
 *
 * additionalRoutes: [{
 *   method: 'POST',
 *   path: '/products',
 *   handler: createProduct,
 *   permissions: requireAuth(),
 *   wrapHandler: true,  // Arc wraps this into Fastify handler
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
 * Use with `wrapHandler: false` in additionalRoutes.
 *
 * @example
 * ```typescript
 * const downloadFile: FastifyHandler = async (request, reply) => {
 *   const file = await getFile(request.params.id);
 *   reply.header('Content-Type', file.mimeType);
 *   return reply.send(file.buffer);
 * };
 *
 * additionalRoutes: [{
 *   method: 'GET',
 *   path: '/files/:id/download',
 *   handler: downloadFile,
 *   permissions: requireAuth(),
 *   wrapHandler: false,  // Use as-is, no wrapping
 * }]
 * ```
 */
export type FastifyHandler<
  RouteGeneric extends Record<string, unknown> = Record<string, unknown>,
> = (
  request: FastifyRequest<RouteGeneric>,
  reply: FastifyReply
) => Promise<unknown> | unknown;

/**
 * Union type for route handlers
 */
export type RouteHandler = ControllerHandler | FastifyHandler;

/**
 * Controller interface for CRUD operations (strict)
 */
export interface IController<TDoc = unknown> {
  list(req: IRequestContext): Promise<IControllerResponse<{ docs: TDoc[]; total: number }>>;
  get(req: IRequestContext): Promise<IControllerResponse<TDoc>>;
  create(req: IRequestContext): Promise<IControllerResponse<TDoc>>;
  update(req: IRequestContext): Promise<IControllerResponse<TDoc>>;
  delete(req: IRequestContext): Promise<IControllerResponse<{ message: string }>>;
}

/**
 * Flexible controller interface - accepts controllers with any handler style
 * Use this when your controller uses Fastify native handlers
 */
export interface ControllerLike {
  list?: unknown;
  get?: unknown;
  create?: unknown;
  update?: unknown;
  delete?: unknown;
  [key: string]: unknown; // Allow additional methods
}
