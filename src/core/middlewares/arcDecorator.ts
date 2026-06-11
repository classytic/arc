/**
 * Arc metadata decorator — stamps `req.arc` so `sendControllerResponse`
 * knows how to field-mask responses and which hooks/events bus the
 * handler is attached to.
 */

import type { RouteHandlerMethod } from "fastify";

import { requestContext } from "../../context/requestContext.js";

/**
 * Frozen metadata stamped onto `req.arc` by `arcDecorator`. Downstream
 * consumers (`sendControllerResponse`, hook system, event bus) read it to
 * find the resource's wiring without threading config through every layer.
 *
 * `idField` rides on the same frozen object so action / CRUD / custom-route
 * handlers can read the resource's bound entity-handle field via
 * `getEntityIdField(req)` / `getEntityQuery(req)` without touching resource
 * config — a one-time per-route allocation, zero-cost per request.
 */
export interface ArcRouteMeta {
  readonly resourceName: string;
  readonly schemaOptions: unknown;
  readonly permissions: unknown;
  readonly hooks: unknown;
  readonly events: unknown;
  readonly fields: unknown;
  readonly idField?: string;
}

/**
 * Build the `arcDecorator` preHandler for a resource.
 *
 * The decorator is a closure over frozen metadata — allocated once per
 * resource and shared across every request. Stamps `req.arc` with the
 * resource's field permissions, hooks, events bus, and schema options
 * so `sendControllerResponse`, `BaseController.run*`, and custom
 * middleware can read a consistent view.
 *
 * Also populates `requestContext.resourceName` for async-context access
 * in code paths that can't reach `req.arc` directly (e.g. detached logger
 * formatters).
 */
export function buildArcDecorator(meta: ArcRouteMeta): RouteHandlerMethod {
  const frozen = Object.freeze({ ...meta });
  return async (req, _reply) => {
    (req as unknown as { arc?: ArcRouteMeta }).arc = frozen;
    const store = requestContext.get();
    if (store) {
      store.resourceName = frozen.resourceName;
    }
  };
}
