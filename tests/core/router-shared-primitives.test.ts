/**
 * Shared router primitives — unit tests
 *
 * Locks in the v2.11.x split that factored CRUD + Action router duplication
 * into `src/core/routerShared.ts`. Before the split these behaviours existed
 * inside `createCrudRouter.ts` and silently diverged from their in-handler
 * equivalents in `createActionRouter.ts` — field masking, permission context
 * construction, and preHandler ordering all had two implementations. These
 * tests treat the shared primitives as a stable contract so regressions
 * between the two routers surface as a unit-test failure, not a late-stage
 * integration bug.
 */

import type { FastifyReply, FastifyRequest } from "fastify";
import { describe, expect, it, vi } from "vitest";
import {
  buildArcDecorator,
  buildAuthMiddleware,
  buildAuthMiddlewareForPermissions,
  buildPermissionContext,
  buildPreHandlerChain,
  buildRateLimitConfig,
  requiresAuthentication,
  resolvePipelineSteps,
  resolveRoutePreHandlers,
  resolveRouterPluginMw,
  selectPluginMw,
} from "../../src/core/routerShared.js";
import { allowPublic, requireAuth, requireRoles } from "../../src/permissions/index.js";
import type { PermissionCheck } from "../../src/permissions/types.js";
import type { FastifyWithDecorators } from "../../src/types/index.js";

// ============================================================================
// Fastify fakes — minimal stand-ins that expose only what the primitives read
// ============================================================================

function makeFastify(overrides: Partial<Record<string, unknown>> = {}): FastifyWithDecorators {
  const authenticate = vi.fn();
  const optionalAuthenticate = vi.fn();
  const decorators = new Set<string>();
  const f = {
    authenticate,
    optionalAuthenticate,
    hasDecorator: (name: string) => decorators.has(name),
    responseCache: { middleware: vi.fn() },
    idempotency: { middleware: vi.fn() },
    arc: { hooks: { _id: "hooks" } },
    events: { _id: "events" },
    ...overrides,
  } as unknown as FastifyWithDecorators & { __decorators: Set<string> };
  (f as unknown as { __decorators: Set<string> }).__decorators = decorators;
  return f;
}

function fakeRequest(body: Record<string, unknown> = {}): FastifyRequest {
  return {
    body,
    params: { id: "doc-42" },
    headers: {},
  } as unknown as FastifyRequest;
}

// ============================================================================
// requiresAuthentication
// ============================================================================

describe("requiresAuthentication", () => {
  it("treats absent permission as public (no auth)", () => {
    expect(requiresAuthentication(undefined)).toBe(false);
  });

  it("respects _isPublic marker set by allowPublic()", () => {
    expect(requiresAuthentication(allowPublic())).toBe(false);
  });

  it("requires auth for requireAuth / requireRoles", () => {
    expect(requiresAuthentication(requireAuth())).toBe(true);
    expect(requiresAuthentication(requireRoles(["admin"]))).toBe(true);
  });
});

// ============================================================================
// buildAuthMiddleware (single-permission route — CRUD shape)
// ============================================================================

describe("buildAuthMiddleware", () => {
  it("protected route → fastify.authenticate", () => {
    const fastify = makeFastify();
    const mw = buildAuthMiddleware(fastify, requireAuth());
    expect(mw).toBe(fastify.authenticate);
  });

  it("public route → fastify.optionalAuthenticate (still parses Bearer if present)", () => {
    const fastify = makeFastify();
    const mw = buildAuthMiddleware(fastify, allowPublic());
    expect(mw).toBe(fastify.optionalAuthenticate);
  });

  it("no permission → fastify.optionalAuthenticate (treat as public)", () => {
    const fastify = makeFastify();
    const mw = buildAuthMiddleware(fastify, undefined);
    expect(mw).toBe(fastify.optionalAuthenticate);
  });
});

// ============================================================================
// buildAuthMiddlewareForPermissions (multi-permission route — Action shape)
// ============================================================================

describe("buildAuthMiddlewareForPermissions", () => {
  it("all protected → fastify.authenticate (fail-fast on missing token)", () => {
    const fastify = makeFastify();
    const mw = buildAuthMiddlewareForPermissions(fastify, [requireAuth(), requireRoles(["admin"])]);
    expect(mw).toBe(fastify.authenticate);
  });

  it("all public → fastify.optionalAuthenticate", () => {
    const fastify = makeFastify();
    const mw = buildAuthMiddlewareForPermissions(fastify, [allowPublic(), allowPublic()]);
    expect(mw).toBe(fastify.optionalAuthenticate);
  });

  it("mixed public + protected → fastify.optionalAuthenticate (per-action check fails-closed)", () => {
    const fastify = makeFastify();
    const mw = buildAuthMiddlewareForPermissions(fastify, [allowPublic(), requireRoles(["admin"])]);
    expect(mw).toBe(fastify.optionalAuthenticate);
  });

  it("empty permissions list → fastify.optionalAuthenticate (public-by-default)", () => {
    // An action endpoint with zero resolved permissions (no per-action checks,
    // no globalAuth) is treated as public. This is a degenerate case — action
    // config validation at defineResource throws before we reach the router —
    // but the primitive stays defensive.
    const fastify = makeFastify();
    const mw = buildAuthMiddlewareForPermissions(fastify, []);
    expect(mw).toBe(fastify.optionalAuthenticate);
  });

  it("undefined slot → public by omission (paired with protected action → optionalAuthenticate)", () => {
    // Regression guard: an action registered with no explicit permission AND
    // no globalAuth fallback resolves to `undefined` in the per-action array.
    // `buildActionPermissionMw` treats that slot as public (it skips the
    // permission evaluation); the route-level auth must treat it the same
    // way, otherwise `fastify.authenticate` fires first and 401s the request
    // before the permission prehandler can let it through.
    //
    // Previous behavior: an earlier revision filtered undefineds out of the
    // permissions array, so `{ ping: undefined, promote: requireRoles(...) }`
    // collapsed to `[requireRoles(...)]` → treated as all-protected → wrong.
    const fastify = makeFastify();
    const mw = buildAuthMiddlewareForPermissions(fastify, [undefined, requireRoles(["admin"])]);
    expect(mw).toBe(fastify.optionalAuthenticate);
  });

  it("all undefined slots → fastify.optionalAuthenticate (fully public by omission)", () => {
    const fastify = makeFastify();
    const mw = buildAuthMiddlewareForPermissions(fastify, [undefined, undefined]);
    expect(mw).toBe(fastify.optionalAuthenticate);
  });
});

// ============================================================================
// selectPluginMw — HTTP method → middleware mapping
// ============================================================================

describe("selectPluginMw", () => {
  const cacheMw = vi.fn();
  const idempotencyMw = vi.fn();
  const mws = { cacheMw, idempotencyMw };

  it("GET → cache middleware", () => {
    expect(selectPluginMw("GET", mws)).toBe(cacheMw);
  });

  it("HEAD → cache middleware (same read-side semantics as GET)", () => {
    expect(selectPluginMw("HEAD", mws)).toBe(cacheMw);
  });

  it.each(["POST", "PUT", "PATCH"])("%s → idempotency middleware (mutation)", (method) => {
    expect(selectPluginMw(method, mws)).toBe(idempotencyMw);
  });

  it("DELETE → no plugin middleware", () => {
    expect(selectPluginMw("DELETE", mws)).toBeNull();
  });

  it("OPTIONS → no plugin middleware (not a cacheable read, not an idempotent mutation)", () => {
    expect(selectPluginMw("OPTIONS", mws)).toBeNull();
  });

  it("accepts lowercase method (Fastify normalizes, but the helper should be defensive)", () => {
    expect(selectPluginMw("get", mws)).toBe(cacheMw);
    expect(selectPluginMw("post", mws)).toBe(idempotencyMw);
  });
});

// ============================================================================
// resolveRouterPluginMw — decorator-based plugin selection
// ============================================================================

describe("resolveRouterPluginMw", () => {
  it("returns nulls when no plugins are registered", () => {
    const fastify = makeFastify();
    const mws = resolveRouterPluginMw(fastify, false);
    expect(mws.cacheMw).toBeNull();
    expect(mws.idempotencyMw).toBeNull();
  });

  it("picks up responseCache / idempotency when their decorators exist", () => {
    const fastify = makeFastify();
    (fastify as unknown as { __decorators: Set<string> }).__decorators.add("responseCache");
    (fastify as unknown as { __decorators: Set<string> }).__decorators.add("idempotency");
    const mws = resolveRouterPluginMw(fastify, false);
    expect(mws.cacheMw).toBe(fastify.responseCache.middleware);
    expect(mws.idempotencyMw).toBe(fastify.idempotency.middleware);
  });

  it("skips response-cache when the resource uses QueryCache (prevents double-caching)", () => {
    const fastify = makeFastify();
    (fastify as unknown as { __decorators: Set<string> }).__decorators.add("responseCache");
    (fastify as unknown as { __decorators: Set<string> }).__decorators.add("idempotency");
    const mws = resolveRouterPluginMw(fastify, /* resourceHasQueryCache */ true);
    expect(mws.cacheMw).toBeNull();
    // Idempotency still wires — it's independent of caching strategy
    expect(mws.idempotencyMw).toBe(fastify.idempotency.middleware);
  });
});

// ============================================================================
// buildPreHandlerChain — canonical order
// ============================================================================

describe("buildPreHandlerChain — canonical order", () => {
  const arcDecorator = vi.fn(() => Promise.resolve());
  const authMw = vi.fn();
  const permissionMw = vi.fn();
  const pluginMw = vi.fn();
  const guard1 = vi.fn();
  const guard2 = vi.fn();
  const custom1 = vi.fn();
  const preAuth1 = vi.fn();

  it("emits canonical order: preAuth → arc → auth → perm → plugin → guards → custom", () => {
    const chain = buildPreHandlerChain({
      preAuth: [preAuth1],
      arcDecorator,
      authMw,
      permissionMw,
      pluginMw,
      routeGuards: [guard1, guard2],
      customMws: [custom1],
    });
    expect(chain).toEqual([
      preAuth1,
      arcDecorator,
      authMw,
      permissionMw,
      pluginMw,
      guard1,
      guard2,
      custom1,
    ]);
  });

  it("drops null and undefined slots (no stray slots in the chain)", () => {
    const chain = buildPreHandlerChain({
      arcDecorator,
      authMw: null,
      permissionMw: undefined,
      pluginMw: null,
      routeGuards: [guard1, null, undefined],
      customMws: [undefined, custom1],
    });
    expect(chain).toEqual([arcDecorator, guard1, custom1]);
  });

  it("arcDecorator is always present — it is the contract that stamps req.arc", () => {
    const chain = buildPreHandlerChain({ arcDecorator });
    expect(chain).toEqual([arcDecorator]);
  });

  it("enforces that auth runs AFTER arcDecorator but BEFORE plugin middleware", () => {
    // Regression: cache/idempotency middleware MUST run AFTER auth so
    // user-scoped cache keys and idempotency fingerprints incorporate
    // `request.user`. Before the split, a future refactor could have
    // reordered this pair without a test noticing.
    const chain = buildPreHandlerChain({
      arcDecorator,
      authMw,
      pluginMw,
    });
    const arcIdx = chain.indexOf(arcDecorator);
    const authIdx = chain.indexOf(authMw);
    const pluginIdx = chain.indexOf(pluginMw);
    expect(arcIdx).toBeLessThan(authIdx);
    expect(authIdx).toBeLessThan(pluginIdx);
  });
});

// ============================================================================
// buildArcDecorator — stamps req.arc with frozen metadata
// ============================================================================

describe("buildArcDecorator", () => {
  it("stamps req.arc with the supplied metadata fields", async () => {
    const meta = {
      resourceName: "product",
      schemaOptions: { fieldRules: {} },
      permissions: {},
      hooks: { id: "hooks" },
      events: { id: "events" },
      fields: { password: { _type: "hidden" } },
    };
    const decorator = buildArcDecorator(meta);
    const req = {} as Record<string, unknown>;
    await decorator(req as FastifyRequest, {} as FastifyReply);
    expect(req.arc).toMatchObject(meta);
  });

  it("the stamped metadata is frozen — handlers can't mutate it after the fact", async () => {
    const decorator = buildArcDecorator({
      resourceName: "p",
      schemaOptions: {},
      permissions: {},
      hooks: null,
      events: null,
      fields: null,
    });
    const req = {} as Record<string, unknown>;
    await decorator(req as FastifyRequest, {} as FastifyReply);
    const arc = req.arc as Record<string, unknown>;
    expect(Object.isFrozen(arc)).toBe(true);
  });

  it("shares the same frozen object across requests (allocated once per resource)", async () => {
    const decorator = buildArcDecorator({
      resourceName: "p",
      schemaOptions: {},
      permissions: {},
      hooks: null,
      events: null,
      fields: null,
    });
    const reqA = {} as Record<string, unknown>;
    const reqB = {} as Record<string, unknown>;
    await decorator(reqA as FastifyRequest, {} as FastifyReply);
    await decorator(reqB as FastifyRequest, {} as FastifyReply);
    expect(reqA.arc).toBe(reqB.arc);
  });
});

// ============================================================================
// buildPermissionContext — unified shape between CRUD and Action routers
// ============================================================================

describe("buildPermissionContext", () => {
  it("pulls resourceId from params.id when not explicitly provided", () => {
    const ctx = buildPermissionContext(fakeRequest(), {
      resource: "order",
      action: "update",
    });
    expect(ctx.resourceId).toBe("doc-42");
    expect(ctx.resource).toBe("order");
    expect(ctx.action).toBe("update");
  });

  it("explicit resourceId overrides params.id (action router path)", () => {
    // Actions pass the id from the route param explicitly so the context
    // matches even if middleware chains mutate req.params.
    const ctx = buildPermissionContext(fakeRequest(), {
      resource: "order",
      action: "approve",
      resourceId: "explicit-id",
    });
    expect(ctx.resourceId).toBe("explicit-id");
  });

  it("explicit data overrides req.body (action router strips `action` discriminator)", () => {
    const ctx = buildPermissionContext(fakeRequest({ action: "approve", amount: 100 }), {
      resource: "order",
      action: "approve",
      data: { amount: 100 },
    });
    expect(ctx.data).toEqual({ amount: 100 });
    // Note: `action` discriminator is deliberately stripped by the action router
    expect((ctx.data as Record<string, unknown>).action).toBeUndefined();
  });

  it("falls back to req.body when no explicit data supplied (CRUD path)", () => {
    const ctx = buildPermissionContext(fakeRequest({ name: "Widget" }), {
      resource: "product",
      action: "create",
    });
    expect(ctx.data).toEqual({ name: "Widget" });
  });

  it("user is null when request is unauthenticated (no request.user decorator)", () => {
    const ctx = buildPermissionContext(fakeRequest(), {
      resource: "order",
      action: "get",
    });
    expect(ctx.user).toBeNull();
  });
});

// ============================================================================
// resolvePipelineSteps — flat array vs per-op map
// ============================================================================

describe("resolvePipelineSteps", () => {
  const step1 = { _type: "guard" as const, name: "g1", handler: () => true };
  const step2 = {
    _type: "transform" as const,
    name: "t1",
    handler: (ctx: unknown) => ctx as never,
  };

  it("empty when pipeline is undefined", () => {
    expect(resolvePipelineSteps(undefined, "create")).toEqual([]);
  });

  it("flat array → all steps for every op", () => {
    const pipeline = [step1, step2];
    expect(resolvePipelineSteps(pipeline, "create")).toEqual([step1, step2]);
    expect(resolvePipelineSteps(pipeline, "approve")).toEqual([step1, step2]);
  });

  it("per-op map → only matching op's steps", () => {
    const pipeline = { create: [step1], approve: [step2] };
    expect(resolvePipelineSteps(pipeline, "create")).toEqual([step1]);
    expect(resolvePipelineSteps(pipeline, "approve")).toEqual([step2]);
    expect(resolvePipelineSteps(pipeline, "list")).toEqual([]);
  });
});

// ============================================================================
// buildRateLimitConfig
// ============================================================================

describe("buildRateLimitConfig", () => {
  it("undefined → no override (inherits instance config)", () => {
    expect(buildRateLimitConfig(undefined)).toBeUndefined();
  });

  it("false → explicit disable (per-route override)", () => {
    expect(buildRateLimitConfig(false)).toEqual({ rateLimit: false });
  });

  it("config object → passes through max/timeWindow", () => {
    expect(buildRateLimitConfig({ max: 10, timeWindow: "1 minute" })).toEqual({
      rateLimit: { max: 10, timeWindow: "1 minute" },
    });
  });
});

// ============================================================================
// Type-level: PermissionCheck._isPublic marker contract
// ============================================================================

describe("PermissionCheck contract (_isPublic marker)", () => {
  it("allowPublic() sets _isPublic = true so buildAuthMiddleware picks optionalAuthenticate", () => {
    const check: PermissionCheck = allowPublic();
    expect(check._isPublic).toBe(true);
  });

  it("requireAuth() / requireRoles() do NOT set _isPublic", () => {
    expect(requireAuth()._isPublic).toBeUndefined();
    expect(requireRoles(["admin"])._isPublic).toBeUndefined();
  });
});

// ============================================================================
// resolveRoutePreHandlers — turn `route.preHandler` into a flat array (2.11.3)
// ============================================================================
//
// Pre-2.11.3, custom routes silently failed when a host wrote
// `preHandler: multipartBody({...})` instead of `preHandler: [multipartBody({...})]`.
// arc invoked the bare handler as a factory (`fn(fastify)`), passing the
// Fastify instance where the handler expected a request — failing later
// with `Cannot read properties of undefined (reading 'content-type')`. The
// resolver discriminates the two valid shapes and rejects the mistake at
// route-registration time with an actionable error message.

describe("resolveRoutePreHandlers", () => {
  const fastify = makeFastify();
  const routeId = "POST /todos/:id/attach";

  it("undefined / null → empty array", () => {
    expect(resolveRoutePreHandlers(undefined, fastify, routeId)).toEqual([]);
    expect(resolveRoutePreHandlers(null, fastify, routeId)).toEqual([]);
  });

  it("array form — returns the array unchanged (filtered to functions)", () => {
    const a = vi.fn();
    const b = vi.fn();
    const result = resolveRoutePreHandlers([a, b], fastify, routeId);
    expect(result).toEqual([a, b]);
  });

  it("array form — drops null/undefined slots without throwing", () => {
    const a = vi.fn();
    const result = resolveRoutePreHandlers([a, null, undefined], fastify, routeId);
    expect(result).toEqual([a]);
  });

  it("factory form — calls with fastify, returns the produced array", () => {
    const handler = vi.fn();
    const factory = vi.fn().mockReturnValue([handler]);
    const result = resolveRoutePreHandlers(factory, fastify, routeId);
    expect(factory).toHaveBeenCalledWith(fastify);
    expect(result).toEqual([handler]);
  });

  it("factory form — return must be an array; single function throws actionable TypeError", () => {
    // The exact mistake hosts make: passing `multipartBody({...})` (a
    // RouteHandlerMethod) where an array was expected. Pre-2.11.3 this
    // surfaced as a Fastify "undefined.content-type" later; now it
    // throws at route registration with the canonical fix in the message.
    const bareHandler = vi.fn();
    expect(() => resolveRoutePreHandlers(bareHandler, fastify, routeId)).toThrow(
      /preHandler: \[yourHandler\]/,
    );
    expect(() => resolveRoutePreHandlers(bareHandler, fastify, routeId)).toThrow(
      new RegExp(`Route ${routeId.replace(/[/]/g, "/")}`),
    );
  });

  it("factory form — throws when factory returns a non-array (object, string, etc.)", () => {
    const factory = (() => ({ not: "an array" })) as unknown as (...args: unknown[]) => unknown;
    expect(() => resolveRoutePreHandlers(factory, fastify, routeId)).toThrow(
      /must return an array/,
    );
  });

  it("factory form — surfaces the original error via `cause` when factory throws", () => {
    const original = new Error("DB not initialized");
    const factory = vi.fn().mockImplementation(() => {
      throw original;
    });
    try {
      resolveRoutePreHandlers(factory, fastify, routeId);
    } catch (err) {
      expect(err).toBeInstanceOf(TypeError);
      expect((err as Error).message).toContain("threw during route registration");
      // `cause` preserved so the original stack is reachable
      expect((err as Error & { cause?: unknown }).cause).toBe(original);
    }
  });

  it("non-array, non-function → TypeError with the bad value described", () => {
    expect(() => resolveRoutePreHandlers("hello" as unknown, fastify, routeId)).toThrow(
      /preHandler must be an array/,
    );
    expect(() => resolveRoutePreHandlers(42 as unknown, fastify, routeId)).toThrow(
      /preHandler must be an array/,
    );
  });

  it("error message names the offending route + the canonical fix", () => {
    const bareHandler = vi.fn();
    let caught: Error | null = null;
    try {
      resolveRoutePreHandlers(bareHandler, fastify, "POST /uploads/photos");
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught!.message).toContain("POST /uploads/photos");
    expect(caught!.message).toContain("preHandler: [yourHandler]");
    expect(caught!.message).toContain("multipartBody"); // points at the common offender
  });
});
