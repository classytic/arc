/**
 * Request-lifecycle plugin middleware selection — pick cacheMw/idempotencyMw
 * by HTTP method and resolve them from Fastify decorators.
 */

import type { RouteHandlerMethod } from "fastify";

import type { FastifyWithDecorators } from "../../types/index.js";

/**
 * Request-lifecycle plugin middlewares exposed by Fastify decorators.
 * Selected per HTTP method by `selectPluginMw`.
 */
export interface RouterPluginMw {
  readonly cacheMw: RouteHandlerMethod | null;
  readonly idempotencyMw: RouteHandlerMethod | null;
}

/**
 * Pick the request-lifecycle plugin middleware for an HTTP method:
 *   - GET / HEAD        → response cache (if present)
 *   - POST / PUT / PATCH → idempotency (if present)
 *   - DELETE            → none
 *
 * Either field may be `null` if the corresponding plugin wasn't registered.
 */
export function selectPluginMw(method: string, mws: RouterPluginMw): RouteHandlerMethod | null {
  const upper = method.toUpperCase();
  if (upper === "GET" || upper === "HEAD") return mws.cacheMw;
  if (upper === "POST" || upper === "PUT" || upper === "PATCH") return mws.idempotencyMw;
  return null;
}

/**
 * Resolve the default cache/idempotency middlewares for a resource.
 *
 * Skips response-cache when the resource has QueryCache active — QueryCache
 * handles caching at the controller level with SWR, so the HTTP-level
 * response-cache would double-cache.
 */
export function resolveRouterPluginMw(
  fastify: FastifyWithDecorators,
  resourceHasQueryCache: boolean,
): RouterPluginMw {
  const cacheMw: RouteHandlerMethod | null =
    !resourceHasQueryCache && fastify.hasDecorator("responseCache")
      ? (fastify.responseCache.middleware as RouteHandlerMethod)
      : null;
  const idempotencyMw: RouteHandlerMethod | null = fastify.hasDecorator("idempotency")
    ? (fastify.idempotency.middleware as RouteHandlerMethod)
    : null;
  return { cacheMw, idempotencyMw };
}
