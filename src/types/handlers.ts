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
  /** Additional context data */
  context?: Record<string, unknown>;
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
}

/**
 * Controller handler - Arc's standard pattern
 *
 * Receives a context object, returns IControllerResponse.
 * Use with `wrapHandler: true` in additionalRoutes.
 *
 * @example
 * ```typescript
 * const createProduct: ControllerHandler<Product> = async (ctx) => {
 *   const product = await productRepo.create(ctx.body);
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
  context: IRequestContext
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
  list(context: IRequestContext): Promise<IControllerResponse<{ docs: TDoc[]; total: number }>>;
  get(context: IRequestContext): Promise<IControllerResponse<TDoc>>;
  create(context: IRequestContext): Promise<IControllerResponse<TDoc>>;
  update(context: IRequestContext): Promise<IControllerResponse<TDoc>>;
  delete(context: IRequestContext): Promise<IControllerResponse<{ message: string }>>;
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
