/**
 * PermissionContext accessors (arc 2.30 — transport-neutral evaluation).
 *
 * The goal of the standardized authorization core is that a `PermissionCheck`
 * reads FACTS off its {@link PermissionContext}, never off a raw
 * `FastifyRequest`. That makes evaluation:
 *   - pure (a combinator can hand a child a NEW context with an updated scope
 *     instead of mutating `request.scope` — see `algebra.ts`),
 *   - transport-neutral (MCP / jobs / websockets build a context directly, no
 *     `fakeRequest`),
 *   - unit-testable (no Fastify object required).
 *
 * `scopeOf` is the single seam every primitive uses to read the request scope.
 * It prefers the context's first-class `scope` (set by combinators + adapters)
 * and falls back to the raw request during migration (the `ctx.request` shim
 * removed in the final phase). Once `scope` is populated everywhere, the
 * fallback is dead and drops out.
 */

import { getRequestScope, PUBLIC_SCOPE, type RequestScope } from "../scope/types.js";
import type { PermissionContext } from "./types.js";

/**
 * Resolve the request scope for a permission check. Prefers the context's
 * first-class `scope`; falls back to the raw HTTP `request.scope` when present,
 * else `PUBLIC_SCOPE`. Primitives MUST use this instead of touching
 * `ctx.request` so scope threads through combinators and non-HTTP transports
 * (MCP, jobs) — which have no request — resolve identity correctly.
 */
export function scopeOf(ctx: PermissionContext): RequestScope {
  if (ctx.scope) return ctx.scope;
  return ctx.request ? getRequestScope(ctx.request) : PUBLIC_SCOPE;
}
