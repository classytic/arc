/**
 * Route hook composition — the canonical lifecycle placement of every arc
 * middleware ingredient, plus the resolver that turns
 * `RouteDefinition.preHandler` into a flat array.
 *
 * Canonical order (CRUD + Actions + Aggregations must agree), split across
 * TWO Fastify lifecycle stages (2.22):
 *
 *   onRequest:  preAuth → arcDecorator → authMw
 *   preHandler: permissionMw → pluginMw → routeGuards → customMws
 *
 * WHY the split: Fastify parses the body and runs schema validation BETWEEN
 * onRequest and preHandler. Auth belongs at `onRequest` (the Fastify
 * best-practice placement) so unauthenticated requests are rejected with a
 * 401 BEFORE arc pays body-parse + AJV cost for them — and before a 400
 * validation error leaks schema shape to anonymous callers (schema-probing
 * surface). Everything auth needs exists at onRequest: headers, cookies,
 * params, query. Everything body-shaped stays at preHandler: permission
 * checks (may read parsed data), idempotency (fingerprints the body),
 * response-cache (keys on the authed user), field-write filters, and
 * host middlewares.
 */

import type { onRequestHookHandler, preHandlerHookHandler, RouteHandlerMethod } from "fastify";

import type { FastifyWithDecorators } from "../../types/index.js";

/**
 * Fastify 5.8+ tightened hook types. `RouteHandlerMethod` returns
 * `unknown` but hooks expect `void | Promise<unknown>`. This alias bridges
 * the gap — all arc middleware conforms at runtime.
 */
export type PreHandlerHook = preHandlerHookHandler | RouteHandlerMethod;

/** The two route-level hook arrays every arc router registers. */
export interface RouteHookChains {
  /** `preAuth → arcDecorator → authMw` — headers/cookies/params only; body does not exist yet. */
  onRequest: PreHandlerHook[];
  /** `permissionMw → pluginMw → routeGuards → customMws` — body-aware stage. */
  preHandler: PreHandlerHook[];
}

/**
 * Compose the route-level `onRequest` + `preHandler` arrays in the canonical
 * order. Every null/undefined entry is dropped. Keeps the three routers from
 * accidentally ordering the same ingredients differently (regression risk:
 * cache before auth → user-scoped cache keys leak across users; auth after
 * body parse → anonymous schema probing).
 *
 * onRequest constraints (Fastify lifecycle): `request.body` is undefined —
 * everything placed there must be header/cookie/param/query-driven. arc's
 * `authenticate` / `optionalAuthenticate` qualify by contract (Bearer
 * header, session cookie, api-key header); `preAuth` handlers exist
 * precisely to promote query tokens into headers (SSE `?token=`); the arc
 * decorator stamps static route metadata.
 */
export function buildRouteHooks(parts: {
  preAuth?: ReadonlyArray<PreHandlerHook | null | undefined>;
  arcDecorator: RouteHandlerMethod;
  authMw?: RouteHandlerMethod | null;
  permissionMw?: RouteHandlerMethod | null;
  pluginMw?: RouteHandlerMethod | null;
  routeGuards?: ReadonlyArray<RouteHandlerMethod | null | undefined>;
  customMws?: ReadonlyArray<PreHandlerHook | null | undefined>;
}): RouteHookChains {
  return {
    onRequest: [...(parts.preAuth ?? []), parts.arcDecorator, parts.authMw ?? null].filter(
      Boolean,
    ) as PreHandlerHook[],
    preHandler: [
      parts.permissionMw ?? null,
      parts.pluginMw ?? null,
      ...(parts.routeGuards ?? []),
      ...(parts.customMws ?? []),
    ].filter(Boolean) as PreHandlerHook[],
  };
}

/**
 * Spread helper — turns `RouteHookChains` into the two Fastify route-option
 * fields, omitting empty arrays so routes without middleware stay
 * option-free (Fastify skips absent hooks faster than empty arrays).
 */
export function routeHookOptions(hooks: RouteHookChains): {
  onRequest?: onRequestHookHandler[];
  preHandler?: preHandlerHookHandler[];
} {
  return {
    ...(hooks.onRequest.length > 0 ? { onRequest: hooks.onRequest as onRequestHookHandler[] } : {}),
    ...(hooks.preHandler.length > 0
      ? { preHandler: hooks.preHandler as preHandlerHookHandler[] }
      : {}),
  };
}

/**
 * `RouteDefinition.preHandler` accepts two shapes:
 *
 *   1. **Array form** — `RouteHandlerMethod[]`. Used directly.
 *   2. **Factory form** — `(fastify) => RouteHandlerMethod[]`. Called once at
 *      route-registration time with the Fastify instance, so handlers can
 *      capture decorators (`fastify.authenticate`, `fastify.events`, etc.)
 *      that aren't on the request.
 *
 * The two forms are equally idiomatic, but the discrimination is by
 * `typeof preHandler === "function"`. Single-function shapes such as
 * `multipartBody({...})` (a `RouteHandlerMethod`) **structurally satisfy
 * the factory branch** at the call site, then fail with a cryptic
 * `Cannot read properties of undefined (reading 'content-type')` once the
 * handler runs with `fastify` in the request slot.
 *
 * This resolver:
 *   1. Distinguishes the two valid shapes.
 *   2. Validates the factory's RETURN — must be an array of functions.
 *   3. Throws an actionable error pointing at the route + the fix when
 *      a single `RouteHandlerMethod` was passed instead of an array, OR
 *      when a factory returned the wrong shape.
 *
 * The error message names the route (`{method} {path}`) and the
 * canonical fix (`preHandler: [yourHandler]`) so the failure mode is
 * obvious instead of debug-archaeology.
 *
 * @param preHandler  The `route.preHandler` value (any of the valid shapes
 *                    plus the common bare-handler mistake).
 * @param fastify     Passed to factory-form preHandlers.
 * @param routeId     `"GET /todos/:id/attach"` (or similar) — used in the
 *                    error message so a multi-route file points at the
 *                    actual offender.
 */
export function resolveRoutePreHandlers(
  preHandler: unknown,
  fastify: FastifyWithDecorators,
  routeId: string,
): PreHandlerHook[] {
  if (preHandler === undefined || preHandler === null) return [];

  // Array form — wrap each entry through a presence filter to drop nulls
  if (Array.isArray(preHandler)) {
    return preHandler.filter((h): h is PreHandlerHook => typeof h === "function");
  }

  // Factory form — call with fastify, validate the return shape
  if (typeof preHandler === "function") {
    let result: unknown;
    try {
      result = (preHandler as (f: FastifyWithDecorators) => unknown)(fastify);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new TypeError(
        `Route ${routeId}: preHandler factory threw during route registration: ${msg}.\n` +
          `If you intended to pass a single handler (e.g. \`multipartBody({...})\`), ` +
          `wrap it in an array: \`preHandler: [yourHandler]\`. ` +
          `The factory form is \`(fastify) => RouteHandlerMethod[]\` — it must return an array.`,
        { cause: err instanceof Error ? err : undefined },
      );
    }
    // Async preHandlers (`async function (req, reply) {...}`) return a Promise
    // when invoked here — the body would crash on `request.headers` since we
    // passed `fastify` as the first arg. Swallow that rejection BEFORE we
    // throw the actionable TypeError below; otherwise it surfaces as an
    // unhandled rejection in a separate microtask and pollutes test logs /
    // process.unhandledRejection listeners.
    if (result && typeof (result as { then?: unknown }).then === "function") {
      (result as Promise<unknown>).catch(() => undefined);
    }
    if (!Array.isArray(result)) {
      throw new TypeError(
        `Route ${routeId}: preHandler factory must return an array of handlers, got ${describeValue(
          result,
        )}.\n` +
          `Common cause: passing a single \`RouteHandlerMethod\` (e.g. \`multipartBody({...})\`) ` +
          `where an array was expected. Wrap it: \`preHandler: [yourHandler]\`. ` +
          `The factory form \`(fastify) => RouteHandlerMethod[]\` is for cases that need the ` +
          `Fastify instance — e.g. \`(fastify) => [fastify.authenticate, myHandler]\`.`,
      );
    }
    return result.filter((h): h is PreHandlerHook => typeof h === "function");
  }

  // Anything else is a programming error — not a string, not an object.
  throw new TypeError(
    `Route ${routeId}: preHandler must be an array of handlers OR a factory ` +
      `\`(fastify) => RouteHandlerMethod[]\`. Got ${describeValue(preHandler)}.`,
  );
}

function describeValue(v: unknown): string {
  if (v === null) return "null";
  if (v === undefined) return "undefined";
  if (typeof v === "function") return "a function (single handler — wrap in array)";
  if (Array.isArray(v)) return `an array of length ${v.length}`;
  return `${typeof v} (${JSON.stringify(v).slice(0, 80)})`;
}
