/**
 * Action router parity — regression tests for v2.11.x router unification
 *
 * Before the unification, `createActionRouter` hardcoded `reply.send({success, data})`
 * and never set `req.arc.fields`, so action responses silently bypassed field-level
 * read permissions that CRUD responses honored. Actions also had no pipeline
 * integration and used an in-handler `fastify.authenticate()` call for mixed
 * public/protected cases (bypassing the preHandler chain).
 *
 * These tests lock the invariants:
 *   1. **Field-masking parity** — actions honor `fields.hidden()` /
 *      `fields.visibleTo()` / `fields.redactFor()` the same way CRUD does.
 *   2. **Pipeline integration** — `pipe: { actionName: [...] }` steps run
 *      around action handlers (guards, transforms, interceptors).
 *   3. **Custom-routes-only resource** — `disableDefaultRoutes: true` with
 *      `routes: [...]` produces a working resource with no CRUD endpoints
 *      (404 for the standard CRUD URLs, 200 for custom ones).
 *   4. **Action preHandler auth chain** — protected actions in a mixed
 *      public/protected endpoint fail-closed when no token is supplied
 *      (the permission check rejects; no in-handler `fastify.authenticate()`).
 *   5. **Live preHandler ordering** — a real request flows through the
 *      canonical preHandler chain in the documented order.
 *   6. **Pipeline failure fidelity** — a pipeline interceptor that returns a
 *      structured `{ success:false, status, error, details, meta }` reaches
 *      the client with every field intact (not collapsed to a generic
 *      `ACTION_FAILED`).
 *   7. **Idempotency parity** — the shared `fastify.idempotency.middleware`
 *      decorator replays action responses for the same key + body.
 */

import { createMongooseAdapter } from "@classytic/mongokit/adapter";
import Fastify, { type FastifyInstance } from "fastify";
import mongoose from "mongoose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BaseController } from "../../src/core/BaseController.js";
import { defineResource } from "../../src/core/defineResource.js";
import { createApp } from "../../src/factory/createApp.js";
import { idempotencyPlugin } from "../../src/idempotency/idempotencyPlugin.js";
import { fields } from "../../src/permissions/fields.js";
import { allowPublic, requireRoles } from "../../src/permissions/index.js";
import type { Guard, Interceptor, Transform } from "../../src/pipeline/types.js";
import { ArcError } from "../../src/utils/errors.js";
import {
  createMockModel,
  createMockRepository,
  setupTestDatabase,
  teardownTestDatabase,
} from "../setup.js";

// ============================================================================
// 1. Action field-masking parity — actions honor fields.hidden() like CRUD
// ============================================================================

describe("Action router — field-masking parity with CRUD", () => {
  let app: FastifyInstance;
  let userId: string;

  beforeAll(async () => {
    await setupTestDatabase();
    // Use a Mongoose model with fields we'll mask. `description` stands in
    // for a secret/password-like field — we'll declare it hidden at the
    // resource level so it should disappear from BOTH CRUD AND action
    // responses.
    const Model = createMockModel("ActionMaskUser");
    const repo = createMockRepository(Model);

    const [u] = await Model.create([
      { name: "Alice", description: "super-secret-hash", price: 100, isActive: true },
    ]);
    userId = String(u._id);

    const resource = defineResource({
      name: "maskuser",
      prefix: "/maskusers",
      adapter: createMongooseAdapter(Model, repo),
      controller: new BaseController(repo, { resourceName: "maskuser", tenantField: false }),
      permissions: {
        list: allowPublic(),
        get: allowPublic(),
        create: allowPublic(),
        update: allowPublic(),
        delete: allowPublic(),
      },
      // Field-level permissions — apply to BOTH CRUD and action responses
      fields: {
        description: fields.hidden(),
      },
      actions: {
        // Action that echoes the user's own document; we'll verify `description`
        // is NOT present in the response (field masking applied).
        reveal: {
          handler: async (id, _data, req) => {
            const doc = await repo.getOne({ _id: new mongoose.Types.ObjectId(id) });
            // Controllers / action handlers return raw data — field masking
            // is applied at the response layer via `sendControllerResponse`
            // (which reads `req.arc.fields` stamped by `arcDecorator`).
            void req;
            return doc;
          },
          permissions: allowPublic(),
        },
      },
      actionPermissions: allowPublic(),
    });

    app = await createApp({
      preset: "testing",
      auth: false,
      logger: false,
      plugins: async (f) => {
        await f.register(resource.toPlugin());
      },
    });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await teardownTestDatabase();
  });

  it("CRUD GET /:id → `description` is stripped (fields.hidden)", async () => {
    const res = await app.inject({ method: "GET", url: `/maskusers/${userId}` });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toBeDefined();
    expect(body.name).toBe("Alice");
    expect(body).not.toHaveProperty("description");
  });

  it("Action POST /:id/action → `description` is stripped (same masking as CRUD)", async () => {
    // This is the regression the refactor fixes — before v2.11.x the action
    // response returned `{success, data: {...description: 'super-secret-hash'}}`
    // because the action router bypassed `sendControllerResponse`.
    const res = await app.inject({
      method: "POST",
      url: `/maskusers/${userId}/action`,
      payload: { action: "reveal" },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toBeDefined();
    expect(body.name).toBe("Alice");
    // The critical assertion: field masking applied on the action path too.
    expect(body).not.toHaveProperty("description");
  });
});

// ============================================================================
// 2. Action pipeline integration — guards, transforms, interceptors run
// ============================================================================

describe("Action router — pipeline integration", () => {
  let app: FastifyInstance;
  let itemId: string;
  let guardCalls: string[];
  let transformCalls: string[];
  let interceptorCalls: string[];

  beforeAll(async () => {
    await setupTestDatabase();
    const Model = createMockModel("ActionPipelineItem");
    const repo = createMockRepository(Model);

    const [u] = await Model.create([{ name: "Pipeline-test", isActive: true }]);
    itemId = String(u._id);

    guardCalls = [];
    transformCalls = [];
    interceptorCalls = [];

    const recordingGuard: Guard = {
      _type: "guard",
      name: "recordingGuard",
      handler: (_ctx) => {
        guardCalls.push("guard:ran");
        return true;
      },
    };
    const recordingTransform: Transform = {
      _type: "transform",
      name: "recordingTransform",
      handler: (ctx) => {
        transformCalls.push("transform:ran");
        return ctx;
      },
    };
    const recordingInterceptor: Interceptor = {
      _type: "interceptor",
      name: "recordingInterceptor",
      handler: async (_ctx, next) => {
        interceptorCalls.push("interceptor:before");
        const result = await next();
        // Post-migration: interceptors see the raw handler return value
        // directly (no `success`/`data` envelope). Tag the after-hook
        // with whether the result is non-null — the canonical signal.
        interceptorCalls.push(`interceptor:after:${result != null}`);
        return result;
      },
    };

    const resource = defineResource({
      name: "pipeitem",
      prefix: "/pipeitems",
      adapter: createMongooseAdapter(Model, repo),
      controller: new BaseController(repo, { resourceName: "pipeitem", tenantField: false }),
      permissions: {
        list: allowPublic(),
        get: allowPublic(),
        create: allowPublic(),
        update: allowPublic(),
        delete: allowPublic(),
      },
      actions: {
        approve: {
          handler: async (id) => ({ id, status: "approved" }),
          permissions: allowPublic(),
        },
      },
      actionPermissions: allowPublic(),
      // Per-op pipeline config — the action name `approve` is the key,
      // same as CRUD ops (`create`, `update`, etc). This confirms actions
      // use the same pipeline-resolution path CRUD does.
      pipe: {
        approve: [recordingGuard, recordingTransform, recordingInterceptor],
      },
    });

    app = await createApp({
      preset: "testing",
      auth: false,
      logger: false,
      plugins: async (f) => {
        await f.register(resource.toPlugin());
      },
    });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await teardownTestDatabase();
  });

  it("action runs guard + transform + interceptor from pipeline config", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/pipeitems/${itemId}/action`,
      payload: { action: "approve" },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).status).toBe("approved");

    // All three pipeline steps fired once for this request
    expect(guardCalls).toEqual(["guard:ran"]);
    expect(transformCalls).toEqual(["transform:ran"]);
    expect(interceptorCalls).toEqual(["interceptor:before", "interceptor:after:true"]);
  });
});

// ============================================================================
// 3. Custom-routes-only resource (disableDefaultRoutes: true)
// ============================================================================

describe("disableDefaultRoutes — custom-routes-only resource", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    await setupTestDatabase();
    // Create a mongoose model but intentionally DON'T expose any CRUD routes.
    // The resource has only a custom GET /stats route — no controller on the
    // defineResource call, and `disableDefaultRoutes: true` so no CRUD
    // handlers are mounted.
    const Model = createMockModel("CustomOnly");
    await Model.create([
      { name: "A", isActive: true },
      { name: "B", isActive: true },
    ]);

    const resource = defineResource({
      name: "customonly",
      prefix: "/customonly",
      // No adapter / controller — nothing to CRUD. Custom routes only.
      disableDefaultRoutes: true,
      routes: [
        {
          method: "GET",
          path: "/stats",
          summary: "Custom stats endpoint",
          permissions: allowPublic(),
          handler: async (_req, reply) => reply.send({ count: await Model.countDocuments() }),
          raw: true,
        },
        {
          method: "POST",
          path: "/broadcast",
          summary: "Custom broadcast endpoint",
          permissions: requireRoles(["admin"]),
          handler: async (_req, reply) => reply.send({ success: true, data: { sent: true } }),
          raw: true,
        },
      ],
    });

    app = await createApp({
      preset: "testing",
      auth: false,
      logger: false,
      plugins: async (f) => {
        await f.register(resource.toPlugin());
      },
    });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await teardownTestDatabase();
  });

  it("custom GET /stats route works", async () => {
    const res = await app.inject({ method: "GET", url: "/customonly/stats" });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).count).toBe(2);
  });

  it("CRUD GET / returns 404 (default route not mounted)", async () => {
    const res = await app.inject({ method: "GET", url: "/customonly" });
    // When disableDefaultRoutes: true, the list endpoint doesn't exist.
    expect(res.statusCode).toBe(404);
  });

  it("CRUD POST / returns 404 (default route not mounted)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/customonly",
      payload: { name: "new" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("CRUD GET /:id returns 404 (default route not mounted)", async () => {
    const res = await app.inject({ method: "GET", url: "/customonly/any-id" });
    expect(res.statusCode).toBe(404);
  });

  it("protected custom route still enforces permissions (401 without token)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/customonly/broadcast",
      payload: {},
    });
    // With auth: false in createApp, `fastify.authenticate` is a no-op that
    // doesn't set request.user. The permission check (requireRoles) fails
    // because user is null → 401 Authentication required.
    expect(res.statusCode).toBe(401);
  });
});

// ============================================================================
// 4. Action preHandler auth chain — mixed public/protected fails-closed
// ============================================================================

describe("Action router — mixed public/protected preHandler auth chain", () => {
  let app: FastifyInstance;
  let itemId: string;

  beforeAll(async () => {
    await setupTestDatabase();
    const Model = createMockModel("MixedAuthItem");
    const repo = createMockRepository(Model);

    const [u] = await Model.create([{ name: "mixed-auth-test", isActive: true }]);
    itemId = String(u._id);

    const resource = defineResource({
      name: "mixedauth",
      prefix: "/mixedauth",
      adapter: createMongooseAdapter(Model, repo),
      controller: new BaseController(repo, { resourceName: "mixedauth", tenantField: false }),
      permissions: {
        list: allowPublic(),
        get: allowPublic(),
        create: allowPublic(),
        update: allowPublic(),
        delete: allowPublic(),
      },
      actions: {
        // Public action — no token required
        ping: {
          handler: async (id) => ({ id, pong: true }),
          permissions: allowPublic(),
        },
        // Protected action — requires admin role. With the refactored auth
        // chain (optionalAuthenticate at preHandler + per-action permission
        // check), missing/invalid tokens MUST produce 401 via the permission
        // evaluator, not 200.
        promote: {
          handler: async (id) => ({ id, promoted: true }),
          permissions: requireRoles(["admin"]),
        },
      },
      // No resource-level actionPermissions — each action carries its own
    });

    app = await createApp({
      preset: "testing",
      auth: false,
      logger: false,
      plugins: async (f) => {
        await f.register(resource.toPlugin());
      },
    });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await teardownTestDatabase();
  });

  it("public action `ping` works without a token", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/mixedauth/${itemId}/action`,
      payload: { action: "ping" },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).pong).toBe(true);
  });

  it("protected action `promote` rejects without a token (permission check fails-closed)", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/mixedauth/${itemId}/action`,
      payload: { action: "promote" },
    });
    // The preHandler used `optionalAuthenticate` (because `ping` is public),
    // so no 401 at the auth layer. The per-action permission check
    // (`requireRoles(['admin'])`) THEN sees `user: null` and returns 401
    // "Authentication required" via `evaluateAndApplyPermission`.
    expect(res.statusCode).toBe(401);
  });
});

// ============================================================================
// 5. Live preHandler chain ordering — real Fastify request
// ============================================================================
//
// The `router-shared-primitives.test.ts` unit test locks the order that
// `buildPreHandlerChain` *emits*. This test proves that when Fastify actually
// dispatches those handlers on a live request, they run in the same order
// end-to-end: `arcDecorator → permissionMw → routeGuards → handler`. If a
// future change reorders the chain (e.g. puts permission check AFTER a guard
// that already saw unfiltered scope), this e2e catches it.

describe("Action router — live preHandler chain ordering", () => {
  let app: FastifyInstance;
  let itemId: string;
  let callOrder: string[];

  beforeAll(async () => {
    await setupTestDatabase();
    const Model = createMockModel("ChainOrderItem");
    const repo = createMockRepository(Model);
    const [u] = await Model.create([{ name: "order-test", isActive: true }]);
    itemId = String(u._id);

    callOrder = [];

    // Inline permission check that records ordering — proves the permission
    // stage has already stamped `_policyFilters`/`scope` before routeGuards run.
    const recordingPermission = (() => {
      callOrder.push("permission");
      return true;
    }) as ReturnType<typeof allowPublic>;
    (recordingPermission as { _isPublic?: boolean })._isPublic = true;

    const recordingGuard = async () => {
      callOrder.push("routeGuard");
    };

    const recordingInterceptor: Interceptor = {
      _type: "interceptor",
      name: "orderRecorder",
      handler: async (_ctx, next) => {
        callOrder.push("pipeline:before");
        const result = await next();
        callOrder.push("pipeline:after");
        return result;
      },
    };

    const resource = defineResource({
      name: "chainorder",
      prefix: "/chainorder",
      adapter: createMongooseAdapter(Model, repo),
      controller: new BaseController(repo, { resourceName: "chainorder", tenantField: false }),
      permissions: {
        list: allowPublic(),
        get: allowPublic(),
        create: allowPublic(),
        update: allowPublic(),
        delete: allowPublic(),
      },
      routeGuards: [recordingGuard],
      actions: {
        run: {
          handler: async (id) => {
            callOrder.push("handler");
            return { id, ok: true };
          },
          permissions: recordingPermission,
        },
      },
      actionPermissions: allowPublic(),
      pipe: { run: [recordingInterceptor] },
    });

    app = await createApp({
      preset: "testing",
      auth: false,
      logger: false,
      plugins: async (f) => {
        await f.register(resource.toPlugin());
      },
    });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await teardownTestDatabase();
  });

  it("dispatches preHandler stages in canonical order: permission → routeGuard → pipeline:before → handler → pipeline:after", async () => {
    callOrder.length = 0;
    const res = await app.inject({
      method: "POST",
      url: `/chainorder/${itemId}/action`,
      payload: { action: "run" },
    });
    expect(res.statusCode).toBe(200);
    // Permission is evaluated in the `permissionMw` slot of the preHandler
    // chain, BEFORE routeGuards. Then the handler runs inside the pipeline
    // interceptor's before/after brackets. This is the exact contract the
    // unit tests describe — proven end-to-end here.
    expect(callOrder).toEqual([
      "permission",
      "routeGuard",
      "pipeline:before",
      "handler",
      "pipeline:after",
    ]);
  });
});

// ============================================================================
// 6. Pipeline failure fidelity — structured error shape reaches the client
// ============================================================================
//
// Before v2.11.x the action router caught pipeline-returned `{success:false,
// status, error, details, meta}` and collapsed it into a generic 500
// `ACTION_FAILED`. The new router feeds the pipeline result straight into
// `sendControllerResponse`, so `status`, `details`, and `meta` all survive.
// This matches the CRUD router — the "structured rejection" pattern works
// identically on both paths.

describe("Action router — pipeline failure fidelity", () => {
  let app: FastifyInstance;
  let itemId: string;

  beforeAll(async () => {
    await setupTestDatabase();
    const Model = createMockModel("PipelineFailItem");
    const repo = createMockRepository(Model);
    const [u] = await Model.create([{ name: "fail-test", isActive: true }]);
    itemId = String(u._id);

    // Interceptor that rejects by THROWING an `ArcError` (post-2.12
    // contract). The action router rethrows ArcError instances; the
    // global error handler runs them through `toErrorContract()` from
    // `@classytic/repo-core/errors` to emit the canonical wire shape:
    //   `{ code, message, status, details?, meta? }`
    //
    // Domain-specific diagnostics (quota limits, retryability) ride
    // through the `meta` slot — `details` is reserved for field-scoped
    // failures (validation errors, duplicate-key fields).
    const rejectingInterceptor: Interceptor = {
      _type: "interceptor",
      name: "quotaCheck",
      handler: async (_ctx, _next) => {
        // Short-circuit — don't call next(). Throwing surfaces a
        // structured rejection identical to the CRUD pipeline path.
        throw new ArcError("Quota exceeded", {
          statusCode: 422,
          code: "QUOTA_EXCEEDED",
          details: { limit: 100, used: 150 },
        });
      },
    };

    const resource = defineResource({
      name: "pipelinefail",
      prefix: "/pipelinefail",
      adapter: createMongooseAdapter(Model, repo),
      controller: new BaseController(repo, { resourceName: "pipelinefail", tenantField: false }),
      permissions: {
        list: allowPublic(),
        get: allowPublic(),
        create: allowPublic(),
        update: allowPublic(),
        delete: allowPublic(),
      },
      actions: {
        charge: {
          handler: async (id) => ({ id, charged: true }),
          permissions: allowPublic(),
        },
      },
      actionPermissions: allowPublic(),
      pipe: { charge: [rejectingInterceptor] },
    });

    app = await createApp({
      preset: "testing",
      auth: false,
      logger: false,
      plugins: async (f) => {
        await f.register(resource.toPlugin());
      },
    });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await teardownTestDatabase();
  });

  it("pipeline rejection propagates status, code, message, and details to the client", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/pipelinefail/${itemId}/action`,
      payload: { action: "charge" },
    });
    // Status code honored — NOT collapsed to 500.
    expect(res.statusCode).toBe(422);
    const body = JSON.parse(res.body);
    // Canonical ErrorContract wire shape:
    //   `code` is the machine-readable identifier consumers branch on
    //   `message` is the human-readable string preserved verbatim
    //   `status` mirrors the HTTP status for clients that read body-only
    //   `details` carries the structured domain payload the throw set
    expect(body.code).toBe("QUOTA_EXCEEDED");
    expect(body.message).toBe("Quota exceeded");
    expect(body.status).toBe(422);
    // Use `toMatchObject` because the global error handler's
    // development-mode shaper attaches a `stack` field to `meta` for
    // 4xx errors. The domain payload is what matters here.
    expect(body.meta).toMatchObject({ limit: 100, used: 150 });
  });
});

// ============================================================================
// 7. Idempotency wiring parity — same middleware path as CRUD
// ============================================================================
//
// Action routes wire `fastify.idempotency.middleware` into the preHandler
// chain via `selectPluginMw("POST", pluginMw)` — structurally identical to
// how CRUD mutations are wired. The full round-trip behaviour (replay on
// repeat key, fingerprint scoping, store concurrency) is already covered by
// `tests/idempotency/plugin-integration.test.ts` against a plain Fastify
// handler; what this test locks is that the ACTION router reaches for the
// same decorator and threads it into its preHandler chain. If a future
// refactor forgets to call `resolveRouterPluginMw` or drops the middleware
// from the chain, this test fails.
//
// Rationale for not doing the full replay e2e here: `light-my-request` +
// the idempotency plugin's preSerialization capture race produces spurious
// `ERR_HTTP_HEADERS_SENT` unhandled rejections (CLAUDE.md gotcha #15) —
// the behaviour works in production but is hard to assert cleanly in-process.
// The structural check below gives us the parity guarantee without the
// flaky moving parts.

describe("Action router — idempotency middleware wired into preHandler chain", () => {
  let app: FastifyInstance;

  afterAll(async () => {
    await app?.close();
  });

  it("calls fastify.idempotency.middleware on every action POST request", async () => {
    // Stand-alone Fastify instance with ONLY the idempotency plugin
    // registered — no other arc pieces. We swap the middleware with a spy
    // before the action router is registered. If the action router reaches
    // for `fastify.idempotency.middleware` and threads it into the preHandler
    // chain, the spy fires exactly once per request. If a refactor forgets
    // to call `resolveRouterPluginMw` or drops the middleware from the chain,
    // this spy stays at zero and the test fails.
    const { createActionRouter } = await import("../../src/core/createActionRouter.js");

    app = Fastify({ logger: false });
    await app.register(idempotencyPlugin, { enabled: true, ttlMs: 60_000 });
    expect(app.hasDecorator("idempotency")).toBe(true);

    // Replace the idempotency middleware with a pass-through spy so we can
    // observe it being called from the action route's preHandler chain
    // without triggering the plugin's preSerialization body-capture path.
    let idempotencyMwCalls = 0;
    const originalMw = (app as unknown as { idempotency: { middleware: unknown } }).idempotency
      .middleware;
    expect(typeof originalMw).toBe("function");
    (app as unknown as { idempotency: { middleware: unknown } }).idempotency.middleware = async (
      _req: unknown,
      _reply: unknown,
    ) => {
      idempotencyMwCalls++;
      // No-op: don't call the real middleware, we only need to observe that
      // arc's chain reaches for this slot.
    };

    createActionRouter(app as unknown as import("../../src/types/index.js").FastifyWithDecorators, {
      tag: "Test",
      resourceName: "idempwiring",
      actions: {
        charge: async (id) => ({ id, ok: true }),
      },
      actionPermissions: { charge: allowPublic() },
    });
    await app.ready();

    const res = await app.inject({
      method: "POST",
      url: "/any-id/action",
      payload: { action: "charge" },
    });
    expect(res.statusCode).toBe(200);
    // The action router wired the idempotency middleware into the preHandler
    // chain via `selectPluginMw("POST", ...)`. Proven by observation.
    expect(idempotencyMwCalls).toBe(1);
  });
});
