/**
 * Fastify Adapter for IController
 *
 * Converts between Fastify's request/reply and framework-agnostic IRequestContext/IControllerResponse.
 * This allows controllers implementing IController to work seamlessly with Fastify.
 */

import type { FastifyRequest, FastifyReply } from 'fastify';
import type {
  IController,
  IControllerResponse,
  IRequestContext,
  RequestWithExtras,
  PaginatedResult,
  AnyRecord,
} from '../types/index.js';

/**
 * Apply field mask to a single object
 * Filters fields based on include/exclude rules
 */
function applyFieldMaskToObject(
  obj: AnyRecord | null | undefined,
  fieldMask: { include?: string[]; exclude?: string[] }
): AnyRecord | null | undefined {
  if (!obj || typeof obj !== 'object') return obj;

  const { include, exclude } = fieldMask;

  // If include is specified, only include those fields
  if (include && include.length > 0) {
    const filtered: AnyRecord = {};
    for (const field of include) {
      if (field in obj) {
        filtered[field] = obj[field];
      }
    }
    return filtered;
  }

  // If exclude is specified, remove those fields
  if (exclude && exclude.length > 0) {
    const filtered: AnyRecord = { ...obj };
    for (const field of exclude) {
      delete filtered[field];
    }
    return filtered;
  }

  return obj;
}

/**
 * Apply field mask to response data (handles both objects and arrays)
 */
function applyFieldMask<T>(
  data: T,
  fieldMask: { include?: string[]; exclude?: string[] } | undefined
): T {
  if (!fieldMask) return data;

  // Handle arrays
  if (Array.isArray(data)) {
    return data.map((item) => applyFieldMaskToObject(item as AnyRecord, fieldMask)) as T;
  }

  // Handle single objects
  if (data && typeof data === 'object') {
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

  return {
    query: (reqWithExtras.query ?? {}) as Record<string, unknown>,
    body: (reqWithExtras.body ?? {}) as Record<string, unknown>,
    params: (reqWithExtras.params ?? {}) as Record<string, string>,
    headers: reqWithExtras.headers as Record<string, string | undefined>,
    user: reqWithExtras.user
      ? (() => {
          const user = reqWithExtras.user as any;
          return {
            ...user,
            id: String(user._id ?? user.id),
            _id: user._id ?? user.id,
            // Normalize role: handle both string and array formats
            role: Array.isArray(user.roles)
              ? user.roles[0]
              : typeof user.roles === 'string'
              ? user.roles
              : undefined,
          };
        })()
      : undefined,
    context: {
      ...reqWithExtras.context,
      // Include Arc metadata for hook execution
      arc: reqWithExtras.arc,
      // Include ownership check for access control
      _ownershipCheck: reqWithExtras._ownershipCheck,
      // Merge policy filters - TRUSTED sources override user input
      // Order matters: query (can be user-injected) FIRST, then trusted middleware LAST
      _policyFilters: {
        ...((reqWithExtras.query as AnyRecord)?._policyFilters as AnyRecord ?? {}),
        ...(reqWithExtras._policyFilters ?? {}),
      },
      // Include logger for logging
      log: reqWithExtras.log,
    },
  };
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
  request?: FastifyRequest
): void {
  // Extract field mask from request if available
  const reqWithExtras = request as RequestWithExtras | undefined;
  const fieldMask = reqWithExtras?.fieldMask;
  const fieldMaskConfig = fieldMask ? { include: fieldMask } : undefined;

  // Handle paginated responses specially (flatten to Arc's ApiResponse format)
  if (response.success && response.data && typeof response.data === 'object' && 'docs' in response.data) {
    const paginatedData = response.data as unknown as PaginatedResult<any>;

    // Apply field mask to docs array
    const filteredDocs = fieldMaskConfig
      ? applyFieldMask(paginatedData.docs, fieldMaskConfig)
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
    });
    return;
  }

  // Handle standard responses - apply field mask to data
  const filteredData = fieldMaskConfig
    ? applyFieldMask(response.data, fieldMaskConfig)
    : response.data;

  reply.code(response.status ?? (response.success ? 200 : 400)).send({
    success: response.success,
    data: filteredData,
    error: response.error,
    details: response.details,
    ...( response.meta ?? {}),
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
  controllerMethod: (context: IRequestContext) => Promise<IControllerResponse<T>>
) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const context = createRequestContext(req);
    const response = await controllerMethod(context);
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
