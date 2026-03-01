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
 * Request context passed to controller handlers
 */
export interface IRequestContext {
  /** Route parameters (e.g., { id: '123' }) */
  params: Record<string, string>;
  /** Query string parameters */
  query: Record<string, unknown>;
  /** Request body */
  body: unknown;
  /** Authenticated user or null */
  user: UserBase | null;
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
  /** Internal metadata (includes context + Arc internals like _policyFilters, log) */
  metadata?: Record<string, unknown>;
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
 * Controller handler - Arc's standard pattern
 *
 * Receives a request context object, returns IControllerResponse.
 * Use with `wrapHandler: true` in additionalRoutes.
 *
 * @example
 * ```typescript
 * const createProduct: ControllerHandler<Product> = async (req) => {
 *   const product = await productRepo.create(req.body);
 *   return { success: true, data: product, status: 201 };
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
export type ControllerHandler<T = unknown> = (
  req: IRequestContext
) => Promise<IControllerResponse<T>>;

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
export type FastifyHandler = (
  request: FastifyRequest,
  reply: FastifyReply
) => Promise<void> | void;

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
