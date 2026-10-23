/**
 * Route hook composition — the canonical lifecycle placement of every arc
 * middleware ingredient, plus the resolver that turns
 * `RouteDefinition.preHandler` into a flat array.
 *
 * Canonical order (CRUD + Actions + Aggregations must agree):
 *
 *   onRequest:  preAuth → arcDecorator → authMw
 *   preHandler: prePermission → permissionMw → validationGate → tenantPreparation → routeGuards → pluginMw → customMws
 *
 * Auth runs before body parse; the permission gate runs before a schema error is
 * surfaced, so a refused caller gets 401/403 and never a 400 that leaks the schema.
 * A gated route registers with `attachValidation: true` and the gate rethrows the
 * parked error. Pinned by `tests/core/authorize-before-validate.test.ts`.
 */

import type {
  FastifyRequest,
  onRequestHookHandler,
  preHandlerHookHandler,
  RouteHandlerMethod,
} from "fastify";

import { isTenantPreparation } from "../../permissions/tenantPreparation.js";
import type { FastifyWithDecorators } from "../../types/index.js";

/**
 * Fastify 5.8+ tightened hook types. `RouteHandlerMethod` returns
 * `unknown` but hooks expect `void | Promise<unknown>`. This alias bridges
 * the gap — all arc middleware conforms at runtime.
 */
export type PreHandlerHook = preHandlerHookHandler | RouteHandlerMethod;

/** The route-level hook arrays every arc router registers. */
export interface RouteHookChains {
  /** `preAuth → arcDecorator → authMw` — headers/cookies/params only; body does not exist yet. */
  onRequest: PreHandlerHook[];
  /** `prePermission → permissionMw → validationGate → tenantPreparation → routeGuards → pluginMw → customMws`. */
  preHandler: PreHandlerHook[];
  /** True iff `preHandler` carries a validation gate — the route must park AJV errors. */
  attachValidation: boolean;
}

const validationGates = new WeakSet<PreHandlerHook>();
const replayBoundaries = new WeakSet<PreHandlerHook>();

/** Rate limiting belongs before a response cache or idempotency replay can return. */
export function isReplayBoundary(hook: unknown): boolean {
  return typeof hook === "function" && replayBoundaries.has(hook as PreHandlerHook);
}

/** True iff `hook` is a validation gate built by `buildRouteHooks`. */
export function isValidationGate(hook: unknown): boolean {
  return typeof hook === "function" && validationGates.has(hook as PreHandlerHook);
}

/**
 * Build the gate that surfaces a parked validation error. `format` may rethrow it in a
 * route-specific shape; whatever it does, a still-parked error is rethrown verbatim, so
 * invalid input never reaches a later hook or the handler.
 */
function buildValidationGate(format?: RouteHandlerMethod | null): PreHandlerHook {
  const gate: RouteHandlerMethod = async function arcValidationGate(req, reply) {
    const parked = (req as FastifyRequest & { validationError?: Error }).validationError;
    if (!parked) return;
    if (format) {
      const result = await format.call(this, req, reply);
      if (result === reply) return reply;
    }
    if (reply.sent) return;
    throw parked;
  };
  validationGates.add(gate);
  return gate;
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
  /** Runs before the permission gate; must not surface schema detail (action dispatch check). */
  prePermission?: RouteHandlerMethod | null;
  permissionMw?: RouteHandlerMethod | null;
  /** Shapes the parked validation error after the gate; the error is rethrown regardless. */
  validationFormatter?: RouteHandlerMethod | null;
  pluginMw?: RouteHandlerMethod | null;
  routeGuards?: ReadonlyArray<RouteHandlerMethod | null | undefined>;
  customMws?: ReadonlyArray<PreHandlerHook | null | undefined>;
}): RouteHookChains {
  // No permission gate = public route: Fastify rejects invalid input at preValidation as before.
  const gated = Boolean(parts.permissionMw);
  const customMws = parts.customMws ?? [];
  const tenancy = customMws.filter(isTenantPreparation);
  const remaining = customMws.filter((middleware) => !isTenantPreparation(middleware));
  if (parts.pluginMw) replayBoundaries.add(parts.pluginMw);
  return {
    onRequest: [...(parts.preAuth ?? []), parts.arcDecorator, parts.authMw ?? null].filter(
      Boolean,
    ) as PreHandlerHook[],
    preHandler: [
      gated ? (parts.prePermission ?? null) : null,
      parts.permissionMw ?? null,
      gated ? buildValidationGate(parts.validationFormatter) : null,
      ...tenancy,
      ...(parts.routeGuards ?? []),
      parts.pluginMw ?? null,
      ...remaining,
    ].filter(Boolean) as PreHandlerHook[],
    attachValidation: gated,
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
  attachValidation?: true;
} {
  return {
    ...(hooks.attachValidation ? { attachValidation: true as const } : {}),
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
