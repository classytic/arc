/**
 * Per-request entity helpers — read the resource binding (idField + the
 * URL `:id` value) off `req.arc`.
 *
 * Action handlers receive their `id` argument as the raw URL `:id` value.
 * When the resource declares a custom `idField` (`slug`, `reportId`, …)
 * that's NOT the document `_id`, a naive `Model.findById(id)` silently
 * returns null. The historical footgun was a `findById(id)` typo where
 * the handler author hadn't realised that `:id` resolves to the friendly
 * handle.
 *
 * `getEntityQuery(req)` produces the canonical filter shape so handlers
 * compose lookups with no resource-config recall:
 *
 * ```ts
 * actions: {
 *   archive: {
 *     handler: async (id, data, req) => {
 *       const doc = await Model.findOne(getEntityQuery(req));
 *       if (!doc) throw new NotFoundError("Order");
 *       // ...
 *     },
 *   },
 * }
 * ```
 *
 * The router populates `req.arc.idField` and `req.arc.entityId` before
 * invoking the handler — these helpers are zero-cost reads.
 */

import { DEFAULT_ID_FIELD } from "../constants.js";
import type { RequestWithExtras } from "../types/index.js";

/**
 * Read the resource's configured `idField` for the current request.
 * Falls back to the framework default (`_id`) when the route hasn't
 * bound an idField — keeps handlers safe to author without checking
 * the resource config.
 */
export function getEntityIdField(req: RequestWithExtras): string {
  return req.arc?.idField ?? DEFAULT_ID_FIELD;
}

/**
 * Read the URL `:id` path param value as the resource handle.
 * Returns `undefined` when the route has no `:id` segment (collection
 * routes) — handlers that need the entity must be on row routes.
 */
export function getEntityId(req: RequestWithExtras): string | undefined {
  if (req.arc?.entityId !== undefined) return req.arc.entityId;
  // Fall back to `req.params.id` for routes that don't surface arc
  // metadata (custom routes calling internal helpers directly).
  const params = req.params as { id?: string } | undefined;
  return params?.id;
}

/**
 * Compose a `findOne` filter that resolves the current request's
 * entity, regardless of whether the resource binds `_id` or a custom
 * field. Idiomatic shape for arc action handlers.
 *
 * ```ts
 * const doc = await Model.findOne(getEntityQuery(req));
 * ```
 *
 * Returns `{}` when the route has no entity context (collection routes
 * or tests bypassing the router) — caller decides what that means.
 */
export function getEntityQuery(req: RequestWithExtras): Record<string, string> {
  const id = getEntityId(req);
  if (id === undefined) return {};
  return { [getEntityIdField(req)]: id };
}
