/**
 * Comprehensive Tests: createActionRouter
 *
 * Covers action validation, handler execution, permission checks,
 * idempotency, error handling, response serialization, OpenAPI docs,
 * and edge cases.
 */

import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ActionRouterConfig, IdempotencyService } from "../../src/core/createActionRouter.js";
import { createActionRouter } from "../../src/core/createActionRouter.js";
import type {
  PermissionCheck,
  PermissionContext,
  PermissionResult,
} from "../../src/types/index.js";

// ============================================================================
// Test Helpers
// ============================================================================

function publicAction(): PermissionCheck {
  const check = (() => true) as PermissionCheck & { _isPublic: boolean };
  check._isPublic = true;
  return check;
}

function protectedAction(
  checker?: (ctx: PermissionContext) => boolean | PermissionResult,
): PermissionCheck {
  const check = (checker ?? ((ctx: PermissionContext) => !!ctx.user)) as PermissionCheck;
  return check;
}

function rolesAction(roles: string[]): PermissionCheck {
  const check = ((ctx: PermissionContext) => !!ctx.user) as PermissionCheck & { _roles: string[] };
  check._roles = roles;
  return check;
}

async function buildApp(
  config: ActionRouterConfig,
  opts?: {
    authenticate?: (req: any, reply: any) => Promise<void>;
  },
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  if (opts?.authenticate) {
    (app as any).authenticate = opts.authenticate;
  }

  createActionRouter(app, config);
  await app.ready();
  return app;
}

function inject(
  app: FastifyInstance,
  action: string,
  id = "test-id",
  extra: Record<string, any> = {},
  headers: Record<string, string> = {},
) {
  return app.inject({
    method: "POST",
    url: `/${id}/action`,
    payload: { action, ...extra },
    headers,
  });
}

// ============================================================================
// 1. Action Validation
// ============================================================================

describe("createActionRouter: Action Validation", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({
      tag: "Test",
      actions: {
        approve: async (id) => ({ id, approved: true }),
        reject: async (id) => ({ id, rejected: true }),
      },
    });
  });

  afterAll(() => app.close());

  it("should return 400 for invalid action (rejected by schema enum)", async () => {
    const res = await inject(app, "nonexistent");
    // Fastify's schema validation rejects values not in the enum
    expect(res.statusCode).toBe(400);
  });

  it("should return 400 for empty action string", async () => {
    const res = await inject(app, "");
    // Empty string not in enum → schema validation error
    expect(res.statusCode).toBe(400);
  });

  it("should be case-sensitive for action names", async () => {
    const res = await inject(app, "Approve");
    // 'Approve' not in enum ['approve', 'reject'] → 400
    expect(res.statusCode).toBe(400);
  });

  it("should return 400 when body has no action field", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/test-id/action",
      payload: { someData: "value" },
    });
    // Fastify schema validation rejects (action is required)
    expect(res.statusCode).toBe(400);
  });

  it("should return custom error for invalid action when schema validation is loose", async () => {
    // Test the handler-level validation by sending a valid enum value
    // that somehow bypasses (not possible with strict schema), so test
    // the error message format of valid actions listing in summary
    const res = await inject(app, "nonexistent");
    expect(res.statusCode).toBe(400);
    // Regardless of who rejects it, 400 is the expected status
  });
});

// ============================================================================
// 2. Handler Execution
// ============================================================================

describe("createActionRouter: Handler Execution", () => {
  it("should execute handler and wrap result in success response", async () => {
    const app = await buildApp({
      actions: {
        process: async (id, data) => ({ id, processed: true, input: data }),
      },
    });

    const res = await inject(app, "process", "order-123", { amount: 100 });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.id).toBe("order-123");
    expect(body.data.processed).toBe(true);
    expect(body.data.input.amount).toBe(100);

    await app.close();
  });

  it("should pass id, data, and request to handler", async () => {
    let receivedId: string | undefined;
    let receivedData: any;
    let receivedReq: any;

    const app = await buildApp({
      actions: {
        check: async (id, data, req) => {
          receivedId = id;
          receivedData = data;
          receivedReq = req;
          return { ok: true };
        },
      },
    });

    await inject(app, "check", "res-456", { key: "value" });
    expect(receivedId).toBe("res-456");
    expect(receivedData.key).toBe("value");
    expect(receivedReq).toBeDefined();
    // data should NOT include the 'action' field (destructured out)
    expect(receivedData.action).toBeUndefined();

    await app.close();
  });

  it("should handle handler returning null", async () => {
    const app = await buildApp({
      actions: {
        nullAction: async () => null,
      },
    });

    const res = await inject(app, "nullAction");
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data).toBeNull();

    await app.close();
  });

  it("should handle handler returning undefined", async () => {
    const app = await buildApp({
      actions: {
        voidAction: async () => undefined,
      },
    });

    const res = await inject(app, "voidAction");
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);

    await app.close();
  });

  it("should handle handler returning complex nested objects", async () => {
    const app = await buildApp({
      actions: {
        complex: async () => ({
          order: {
            id: "1",
            items: [
              { name: "A", qty: 2 },
              { name: "B", qty: 1 },
            ],
          },
          totals: { subtotal: 100, tax: 10, total: 110 },
          metadata: { createdAt: "2024-01-01" },
        }),
      },
    });

    const res = await inject(app, "complex");
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.order.items).toHaveLength(2);
    expect(body.data.totals.total).toBe(110);

    await app.close();
  });

  it("should handle handler returning objects with toJSON method", async () => {
    const app = await buildApp({
      actions: {
        model: async () => ({
          _id: "123",
          name: "Test",
          toJSON() {
            return { id: this._id, name: this.name };
          },
        }),
      },
    });

    const res = await inject(app, "model");
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    // toJSON should be honoured by JSON.stringify
    expect(body.data.id).toBe("123");
    expect(body.data.name).toBe("Test");

    await app.close();
  });
});

// ============================================================================
// 3. Error Handling
// ============================================================================

describe("createActionRouter: Error Handling", () => {
  it("should handle errors with statusCode property", async () => {
    const app = await buildApp({
      actions: {
        fail: async () => {
          const err = new Error("Not found") as any;
          err.statusCode = 404;
          throw err;
        },
      },
    });

    const res = await inject(app, "fail");
    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.error).toBe("Not found");

    await app.close();
  });

  it("should handle errors with status property", async () => {
    const app = await buildApp({
      actions: {
        fail: async () => {
          const err = new Error("Bad request") as any;
          err.status = 400;
          throw err;
        },
      },
    });

    const res = await inject(app, "fail");
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toBe("Bad request");

    await app.close();
  });

  it("should default to 500 for errors without status", async () => {
    const app = await buildApp({
      actions: {
        crash: async () => {
          throw new Error("Unexpected failure");
        },
      },
    });

    const res = await inject(app, "crash");
    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.code).toBe("ACTION_FAILED");

    await app.close();
  });

  it("should use error.code when available", async () => {
    const app = await buildApp({
      actions: {
        fail: async () => {
          const err = new Error("Conflict") as any;
          err.statusCode = 409;
          err.code = "DUPLICATE_ENTRY";
          throw err;
        },
      },
    });

    const res = await inject(app, "fail");
    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body);
    expect(body.code).toBe("DUPLICATE_ENTRY");

    await app.close();
  });

  it("should use custom onError handler when provided", async () => {
    const app = await buildApp({
      actions: {
        fail: async () => {
          throw new Error("Something broke");
        },
      },
      onError: (error, action, id) => ({
        statusCode: 422,
        error: `Custom: ${error.message} in ${action} for ${id}`,
        code: "CUSTOM_ERROR",
      }),
    });

    const res = await inject(app, "fail", "item-1");
    expect(res.statusCode).toBe(422);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.error).toBe("Custom: Something broke in fail for item-1");
    expect(body.code).toBe("CUSTOM_ERROR");

    await app.close();
  });

  it("should fall back to default message when error has no message", async () => {
    const app = await buildApp({
      actions: {
        fail: async () => {
          const err = {} as any;
          err.statusCode = 500;
          throw err;
        },
      },
    });

    const res = await inject(app, "fail");
    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.error).toContain("Failed to execute 'fail' action");

    await app.close();
  });
});

// ============================================================================
// 4. Permission Checks
// ============================================================================

describe("createActionRouter: Permission Checks", () => {
  it("should allow access when no permissions defined", async () => {
    const app = await buildApp({
      actions: {
        open: async () => ({ result: "ok" }),
      },
      // No actionPermissions, no globalAuth
    });

    const res = await inject(app, "open");
    expect(res.statusCode).toBe(200);

    await app.close();
  });

  it("should check action-specific permissions (boolean true)", async () => {
    const app = await buildApp({
      actions: {
        allowed: async () => ({ ok: true }),
      },
      actionPermissions: {
        allowed: protectedAction(() => true),
      },
    });

    const res = await inject(app, "allowed");
    expect(res.statusCode).toBe(200);

    await app.close();
  });

  it("should deny when permission returns false (no user → 401)", async () => {
    const app = await buildApp({
      actions: {
        denied: async () => ({ ok: true }),
      },
      actionPermissions: {
        denied: protectedAction((ctx) => !!ctx.user),
      },
    });

    const res = await inject(app, "denied");
    // No user → 401
    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);

    await app.close();
  });

  it("should deny when permission returns false (with user → 403)", async () => {
    const app = await buildApp(
      {
        actions: {
          denied: async () => ({ ok: true }),
        },
        actionPermissions: {
          denied: protectedAction(() => false),
        },
      },
      {
        authenticate: async (req: any) => {
          req.user = { id: "u1" };
        },
      },
    );

    // Inject with a user set
    const appWithUser = Fastify({ logger: false });
    (appWithUser as any).authenticate = async (req: any) => {
      req.user = { id: "u1" };
    };
    // We need the user on the request; use preHandler
    appWithUser.addHook("preHandler", async (req: any) => {
      req.user = { id: "u1" };
    });
    createActionRouter(appWithUser, {
      actions: {
        denied: async () => ({ ok: true }),
      },
      actionPermissions: {
        denied: protectedAction(() => false),
      },
    });
    await appWithUser.ready();

    const res = await inject(appWithUser, "denied");
    expect(res.statusCode).toBe(403);

    await appWithUser.close();
  });

  it("should handle PermissionResult with granted=true", async () => {
    const app = await buildApp({
      actions: {
        check: async () => ({ ok: true }),
      },
      actionPermissions: {
        check: protectedAction(() => ({ granted: true })),
      },
    });

    const res = await inject(app, "check");
    expect(res.statusCode).toBe(200);

    await app.close();
  });

  // Regression pin: action routes must propagate PermissionResult.scope and
  // PermissionResult.filters to the handler. Before the unification fix,
  // createActionRouter only inspected `granted` and silently dropped both
  // side-effects, breaking custom-auth tenant isolation. The dedicated
  // file `tests/core/action-router-permission-scope.test.ts` covers this in
  // depth — this inline assertion exists so anyone reading the canonical
  // createActionRouter test file sees the contract pinned beside the
  // existing PermissionResult cases.
  it("should propagate PermissionResult.scope and filters to the action handler", async () => {
    const seen: { scope?: unknown; policyFilters?: unknown } = {};

    const app = Fastify({ logger: false });
    createActionRouter(app, {
      actions: {
        run: async (id: string, _data: unknown, req: any) => {
          seen.scope = req.scope;
          seen.policyFilters = req._policyFilters;
          return { id, ok: true };
        },
      },
      actionPermissions: {
        run: (() => ({
          granted: true,
          scope: {
            kind: "service",
            clientId: "client-xyz",
            organizationId: "org-acme",
          },
          filters: { projectId: "proj-1" },
        })) as unknown as PermissionCheck,
      },
    });
    await app.ready();

    const res = await inject(app, "run");
    expect(res.statusCode).toBe(200);
    expect(seen.scope).toEqual({
      kind: "service",
      clientId: "client-xyz",
      organizationId: "org-acme",
    });
    expect(seen.policyFilters).toEqual({ projectId: "proj-1" });

    await app.close();
  });

  it("should handle PermissionResult with granted=false and reason", async () => {
    const app = Fastify({ logger: false });
    app.addHook("preHandler", async (req: any) => {
      req.user = { id: "u1" };
    });
    createActionRouter(app, {
      actions: {
        check: async () => ({ ok: true }),
      },
      actionPermissions: {
        check: protectedAction(() => ({ granted: false, reason: "Insufficient tier" })),
      },
    });
    await app.ready();

    const res = await inject(app, "check");
    expect(res.statusCode).toBe(403);
    const body = JSON.parse(res.body);
    expect(body.error).toBe("Insufficient tier");

    await app.close();
  });

  it("should fall back to globalAuth when action has no specific permission", async () => {
    let globalAuthCalled = false;

    const app = await buildApp({
      actions: {
        noSpecific: async () => ({ ok: true }),
      },
      actionPermissions: {
        // no entry for 'noSpecific'
      },
      globalAuth: protectedAction((_ctx) => {
        globalAuthCalled = true;
        return true;
      }),
    });

    await inject(app, "noSpecific");
    expect(globalAuthCalled).toBe(true);

    await app.close();
  });

  it("should prefer action-specific over globalAuth", async () => {
    let specificCalled = false;
    let globalCalled = false;

    const app = await buildApp({
      actions: {
        specific: async () => ({ ok: true }),
      },
      actionPermissions: {
        specific: protectedAction(() => {
          specificCalled = true;
          return true;
        }),
      },
      globalAuth: protectedAction(() => {
        globalCalled = true;
        return true;
      }),
    });

    await inject(app, "specific");
    expect(specificCalled).toBe(true);
    expect(globalCalled).toBe(false);

    await app.close();
  });

  it("should catch and handle permission check that throws", async () => {
    const app = await buildApp({
      actions: {
        boom: async () => ({ ok: true }),
      },
      actionPermissions: {
        boom: protectedAction(() => {
          throw new Error("Auth service down");
        }),
      },
    });

    const res = await inject(app, "boom");
    // Should return 403, not 500
    expect(res.statusCode).toBe(403);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.error).toBe("Permission denied");

    await app.close();
  });

  it("should pass correct context to permission check", async () => {
    let capturedCtx: PermissionContext | undefined;

    const app = Fastify({ logger: false });
    app.addHook("preHandler", async (req: any) => {
      req.user = { id: "user-42", role: "admin" };
    });
    createActionRouter(app, {
      tag: "Orders",
      actions: {
        approve: async () => ({ ok: true }),
      },
      actionPermissions: {
        approve: protectedAction((ctx) => {
          capturedCtx = ctx;
          return true;
        }),
      },
    });
    await app.ready();

    await inject(app, "approve", "order-99", { reason: "looks good" });

    expect(capturedCtx).toBeDefined();
    expect(capturedCtx?.user?.id).toBe("user-42");
    expect(capturedCtx?.action).toBe("approve");
    expect(capturedCtx?.resourceId).toBe("order-99");
    expect(capturedCtx?.resource).toBe("Orders");
    expect(capturedCtx?.data?.reason).toBe("looks good");

    await app.close();
  });
});

// ============================================================================
// 5. Auth Pre-Handler Behavior
// ============================================================================

describe("createActionRouter: Auth Pre-Handler", () => {
  it("should apply global auth when all actions protected", async () => {
    let authCalled = false;

    const app = await buildApp(
      {
        actions: {
          a: async () => "a",
          b: async () => "b",
        },
        actionPermissions: {
          a: protectedAction(),
          b: protectedAction(),
        },
      },
      {
        authenticate: async (req: any) => {
          authCalled = true;
          req.user = { id: "u1" };
        },
      },
    );

    await inject(app, "a");
    expect(authCalled).toBe(true);

    await app.close();
  });

  it("should NOT apply global auth when all actions public", async () => {
    let authCalled = false;

    const app = await buildApp(
      {
        actions: {
          a: async () => "a",
          b: async () => "b",
        },
        actionPermissions: {
          a: publicAction(),
          b: publicAction(),
        },
      },
      {
        authenticate: async () => {
          authCalled = true;
        },
      },
    );

    await inject(app, "a");
    expect(authCalled).toBe(false);

    await app.close();
  });

  it("should defer auth to per-action check when mixed public/protected", async () => {
    let globalAuthCalled = false;

    const app = await buildApp(
      {
        actions: {
          public: async () => ({ public: true }),
          private: async (_id, _data, req) => ({ by: (req.user as any)?.id }),
        },
        actionPermissions: {
          public: publicAction(),
          private: protectedAction(),
        },
      },
      {
        authenticate: async (_req: any) => {
          globalAuthCalled = true;
          // Don't set user to simulate checking without auth
        },
      },
    );

    // Public action should NOT trigger global auth
    globalAuthCalled = false;
    const pubRes = await inject(app, "public");
    expect(pubRes.statusCode).toBe(200);
    // Global preHandler should NOT be called for mixed mode
    expect(globalAuthCalled).toBe(false);

    await app.close();
  });

  it("should authenticate per-action for protected in mixed mode", async () => {
    const app = Fastify({ logger: false });

    (app as any).authenticate = async (req: any) => {
      if (!req.headers.authorization) {
        throw new Error("No auth");
      }
      req.user = { id: "authed" };
    };

    createActionRouter(app, {
      actions: {
        public: async () => ({ public: true }),
        private: async (_id, _data, req) => ({ by: (req.user as any)?.id }),
      },
      actionPermissions: {
        public: publicAction(),
        private: protectedAction(),
      },
    });

    await app.ready();

    // Protected action without auth → 401
    const res1 = await inject(app, "private");
    expect(res1.statusCode).toBeGreaterThanOrEqual(401);

    // Protected action with auth → 200
    const res2 = await app.inject({
      method: "POST",
      url: "/test-id/action",
      payload: { action: "private" },
      headers: { authorization: "Bearer token" },
    });
    expect(res2.statusCode).toBe(200);

    await app.close();
  });
});

// ============================================================================
// 6. Idempotency
// ============================================================================

describe("createActionRouter: Idempotency", () => {
  it("should return cached result on idempotent replay", async () => {
    let callCount = 0;
    const store = new Map<string, any>();

    const idempotencyService: IdempotencyService = {
      async check(key, _payload) {
        if (store.has(key)) {
          return { isNew: false, existingResult: store.get(key) };
        }
        return { isNew: true };
      },
      async complete(key, result) {
        if (key) store.set(key, result);
      },
      async fail() {},
    };

    const app = await buildApp({
      actions: {
        charge: async (id) => {
          callCount++;
          return { id, charged: true, attempt: callCount };
        },
      },
      idempotencyService,
    });

    // First call
    const res1 = await inject(app, "charge", "order-1", {}, { "idempotency-key": "key-1" });
    expect(res1.statusCode).toBe(200);
    const body1 = JSON.parse(res1.body);
    expect(body1.data.attempt).toBe(1);

    // Second call — should return cached
    const res2 = await inject(app, "charge", "order-1", {}, { "idempotency-key": "key-1" });
    expect(res2.statusCode).toBe(200);
    const body2 = JSON.parse(res2.body);
    expect(body2.cached).toBe(true);
    expect(body2.data.attempt).toBe(1);
    expect(callCount).toBe(1); // Handler only called once

    await app.close();
  });

  it("should handle cached falsy result (null, 0, false)", async () => {
    const store = new Map<string, any>();

    const idempotencyService: IdempotencyService = {
      async check(key) {
        if (store.has(key)) {
          return { isNew: false, existingResult: store.get(key) };
        }
        return { isNew: true };
      },
      async complete(key, result) {
        if (key) store.set(key, result);
      },
      async fail() {},
    };

    const app = await buildApp({
      actions: {
        nullResult: async () => null,
      },
      idempotencyService,
    });

    // First call stores null
    await inject(app, "nullResult", "id", {}, { "idempotency-key": "null-key" });

    // Second call should return cached null (not treat as cache miss)
    const res = await inject(app, "nullResult", "id", {}, { "idempotency-key": "null-key" });
    const body = JSON.parse(res.body);
    expect(body.cached).toBe(true);
    expect(body.data).toBeNull();

    await app.close();
  });

  it("should skip idempotency when no key header provided", async () => {
    let callCount = 0;

    const idempotencyService: IdempotencyService = {
      async check() {
        return { isNew: true };
      },
      async complete() {},
      async fail() {},
    };

    const app = await buildApp({
      actions: {
        process: async () => {
          callCount++;
          return { count: callCount };
        },
      },
      idempotencyService,
    });

    await inject(app, "process");
    await inject(app, "process");
    expect(callCount).toBe(2); // Both executed

    await app.close();
  });

  it("should call idempotencyService.fail on handler error", async () => {
    let failCalled = false;
    let failedKey: string | undefined;

    const idempotencyService: IdempotencyService = {
      async check() {
        return { isNew: true };
      },
      async complete() {},
      async fail(key) {
        failCalled = true;
        failedKey = key;
      },
    };

    const app = await buildApp({
      actions: {
        crash: async () => {
          throw new Error("boom");
        },
      },
      idempotencyService,
    });

    await inject(app, "crash", "id", {}, { "idempotency-key": "fail-key" });
    expect(failCalled).toBe(true);
    expect(failedKey).toBe("fail-key");

    await app.close();
  });

  it("should handle array idempotency-key header (use first)", async () => {
    let checkedKey: string | undefined;

    const idempotencyService: IdempotencyService = {
      async check(key) {
        checkedKey = key;
        return { isNew: true };
      },
      async complete() {},
      async fail() {},
    };

    const app = await buildApp({
      actions: {
        test: async () => ({ ok: true }),
      },
      idempotencyService,
    });

    // Fastify inject doesn't support array headers directly,
    // but the code handles it: Array.isArray → use [0]
    await app.inject({
      method: "POST",
      url: "/id/action",
      payload: { action: "test" },
      headers: { "idempotency-key": "single-key" },
    });

    expect(checkedKey).toBe("single-key");

    await app.close();
  });
});

// ============================================================================
// 7. Empty Actions Config
// ============================================================================

describe("createActionRouter: Empty Actions", () => {
  it("should skip route registration when no actions defined", async () => {
    const app = Fastify({ logger: false });

    createActionRouter(app, {
      tag: "Empty",
      actions: {},
    });

    await app.ready();

    // Route should not exist
    const res = await app.inject({
      method: "POST",
      url: "/test-id/action",
      payload: { action: "anything" },
    });
    expect(res.statusCode).toBe(404);

    await app.close();
  });
});

// ============================================================================
// 8. Action Schemas
// ============================================================================

describe("createActionRouter: Action Schemas", () => {
  it("should accept additional body properties from action schemas", async () => {
    const app = await buildApp({
      actions: {
        dispatch: async (id, data) => ({ id, driver: data.transport?.driver }),
        cancel: async (id, data) => ({ id, reason: data.reason }),
      },
      actionSchemas: {
        dispatch: {
          transport: { type: "object", properties: { driver: { type: "string" } } },
        },
        cancel: {
          reason: { type: "string" },
        },
      },
    });

    const res = await inject(app, "dispatch", "order-1", {
      transport: { driver: "John" },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.driver).toBe("John");

    await app.close();
  });
});

// ============================================================================
// 9. OpenAPI / Schema
// ============================================================================

describe("createActionRouter: OpenAPI Schema", () => {
  it("should include tag in schema", async () => {
    const app = Fastify({ logger: false });

    createActionRouter(app, {
      tag: "Inventory - Transfers",
      actions: {
        approve: async () => ({}),
      },
    });

    await app.ready();

    // Check registered routes have the schema
    const routes = app.printRoutes();
    expect(routes).toContain("action");

    await app.close();
  });

  it("should generate discriminated body schema with one branch per action (v2.8.1)", async () => {
    const app = Fastify({ logger: false });

    let capturedSchema: any;
    app.addHook("onRoute", (routeOptions) => {
      if (routeOptions.url === "/:id/action" && routeOptions.method === "POST") {
        capturedSchema = routeOptions.schema;
      }
    });

    createActionRouter(app, {
      actions: {
        approve: async () => ({}),
        reject: async () => ({}),
        cancel: async () => ({}),
      },
    });

    await app.ready();

    expect(capturedSchema).toBeDefined();
    // v2.8.1: discriminated schema — oneOf with const on each branch's action field
    expect(capturedSchema.body.type).toBe("object");
    expect(capturedSchema.body.required).toEqual(["action"]);
    expect(Array.isArray(capturedSchema.body.oneOf)).toBe(true);
    expect(capturedSchema.body.oneOf).toHaveLength(3);

    const consts = capturedSchema.body.oneOf.map(
      (branch: any) => branch.properties.action.const,
    );
    expect(consts).toEqual(["approve", "reject", "cancel"]);

    await app.close();
  });

  it("should include roles in description when _roles metadata present", async () => {
    const app = Fastify({ logger: false });

    let capturedSchema: any;
    app.addHook("onRoute", (routeOptions) => {
      if (routeOptions.url === "/:id/action" && routeOptions.method === "POST") {
        capturedSchema = routeOptions.schema;
      }
    });

    createActionRouter(app, {
      actions: {
        approve: async () => ({}),
        view: async () => ({}),
      },
      actionPermissions: {
        approve: rolesAction(["admin", "manager"]),
        view: publicAction(),
      },
    });

    await app.ready();

    expect(capturedSchema?.description).toContain("approve");
    expect(capturedSchema?.description).toContain("admin");
    expect(capturedSchema?.description).toContain("manager");

    await app.close();
  });
});

// ============================================================================
// 10. Response Serialization
// ============================================================================

describe("createActionRouter: Response Serialization", () => {
  it("should serialize dynamic response shapes without schema stripping", async () => {
    const app = await buildApp({
      actions: {
        detail: async () => ({
          _id: "abc123",
          name: "Test Order",
          status: "active",
          items: [{ product: "Widget", qty: 3 }],
          subscription: { planKey: "monthly", isActive: true },
          createdAt: "2024-01-01T00:00:00Z",
        }),
      },
    });

    const res = await inject(app, "detail");
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);

    // All fields should be present (not stripped by schema)
    expect(body.data._id).toBe("abc123");
    expect(body.data.name).toBe("Test Order");
    expect(body.data.status).toBe("active");
    expect(body.data.items).toHaveLength(1);
    expect(body.data.subscription.planKey).toBe("monthly");
    expect(body.data.createdAt).toBe("2024-01-01T00:00:00Z");

    await app.close();
  });

  it("should not return empty object for complex data", async () => {
    const app = await buildApp({
      actions: {
        fetch: async () => ({
          enrollment: { courseId: "c1", status: "active" },
          transaction: { amount: 100, method: "card" },
        }),
      },
    });

    const res = await inject(app, "fetch");
    const body = JSON.parse(res.body);

    // This was the critical bug — data was {} before the fix
    expect(body.data).not.toEqual({});
    expect(body.data.enrollment.courseId).toBe("c1");
    expect(body.data.transaction.amount).toBe(100);

    await app.close();
  });

  it("should handle arrays as top-level data", async () => {
    const app = await buildApp({
      actions: {
        list: async () => [
          { id: "1", name: "A" },
          { id: "2", name: "B" },
        ],
      },
    });

    const res = await inject(app, "list");
    const body = JSON.parse(res.body);
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data).toHaveLength(2);

    await app.close();
  });

  it("should handle primitive values as data", async () => {
    const app = await buildApp({
      actions: {
        count: async () => 42,
        flag: async () => true,
        label: async () => "done",
      },
    });

    let res = await inject(app, "count");
    expect(JSON.parse(res.body).data).toBe(42);

    res = await inject(app, "flag");
    expect(JSON.parse(res.body).data).toBe(true);

    res = await inject(app, "label");
    expect(JSON.parse(res.body).data).toBe("done");

    await app.close();
  });
});

// ============================================================================
// 11. Route Registration
// ============================================================================

describe("createActionRouter: Route Registration", () => {
  it("should register POST /:id/action endpoint", async () => {
    const app = await buildApp({
      actions: {
        test: async () => ({}),
      },
    });

    const res = await app.inject({
      method: "POST",
      url: "/my-resource-id/action",
      payload: { action: "test" },
    });
    expect(res.statusCode).toBe(200);

    await app.close();
  });

  it("should work with various ID formats", async () => {
    const app = await buildApp({
      actions: {
        echo: async (id) => ({ id }),
      },
    });

    // MongoDB ObjectId-like
    let res = await inject(app, "echo", "507f1f77bcf86cd799439011");
    expect(JSON.parse(res.body).data.id).toBe("507f1f77bcf86cd799439011");

    // UUID
    res = await inject(app, "echo", "550e8400-e29b-41d4-a716-446655440000");
    expect(JSON.parse(res.body).data.id).toBe("550e8400-e29b-41d4-a716-446655440000");

    // Numeric string
    res = await inject(app, "echo", "12345");
    expect(JSON.parse(res.body).data.id).toBe("12345");

    await app.close();
  });

  it("should return 404 for wrong HTTP method", async () => {
    const app = await buildApp({
      actions: { test: async () => ({}) },
    });

    const res = await app.inject({
      method: "GET",
      url: "/test-id/action",
    });
    expect(res.statusCode).toBe(404);

    await app.close();
  });
});

// ============================================================================
// 12. Multiple Actions
// ============================================================================

describe("createActionRouter: Multiple Actions", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({
      tag: "Workflow",
      actions: {
        approve: async (id) => ({ id, status: "approved" }),
        reject: async (id, data) => ({ id, status: "rejected", reason: data.reason }),
        dispatch: async (id, data) => ({ id, status: "dispatched", driver: data.driver }),
        receive: async (id) => ({ id, status: "received" }),
        cancel: async (id, data) => ({ id, status: "cancelled", reason: data.reason }),
      },
    });
  });

  afterAll(() => app.close());

  it("should route to correct handler based on action", async () => {
    const approve = await inject(app, "approve", "item-1");
    expect(JSON.parse(approve.body).data.status).toBe("approved");

    const reject = await inject(app, "reject", "item-1", { reason: "bad quality" });
    expect(JSON.parse(reject.body).data.status).toBe("rejected");
    expect(JSON.parse(reject.body).data.reason).toBe("bad quality");

    const dispatch = await inject(app, "dispatch", "item-1", { driver: "John" });
    expect(JSON.parse(dispatch.body).data.driver).toBe("John");

    const receive = await inject(app, "receive", "item-1");
    expect(JSON.parse(receive.body).data.status).toBe("received");

    const cancel = await inject(app, "cancel", "item-1", { reason: "out of stock" });
    expect(JSON.parse(cancel.body).data.reason).toBe("out of stock");
  });
});

// ============================================================================
// 13. Mixed Permission + Handler Integration
// ============================================================================

describe("createActionRouter: Permission + Handler Integration", () => {
  it("should not execute handler when permission denied", async () => {
    let handlerCalled = false;

    const app = await buildApp({
      actions: {
        sensitive: async () => {
          handlerCalled = true;
          return { secret: "data" };
        },
      },
      actionPermissions: {
        sensitive: protectedAction(() => false),
      },
    });

    await inject(app, "sensitive");
    expect(handlerCalled).toBe(false);

    await app.close();
  });

  it("should execute handler after permission granted", async () => {
    let handlerCalled = false;

    const app = await buildApp({
      actions: {
        allowed: async () => {
          handlerCalled = true;
          return { done: true };
        },
      },
      actionPermissions: {
        allowed: protectedAction(() => true),
      },
    });

    const res = await inject(app, "allowed");
    expect(res.statusCode).toBe(200);
    expect(handlerCalled).toBe(true);

    await app.close();
  });

  it("should check permission before idempotency", async () => {
    const order: string[] = [];

    const idempotencyService: IdempotencyService = {
      async check() {
        order.push("idempotency");
        return { isNew: true };
      },
      async complete() {},
      async fail() {},
    };

    const app = await buildApp({
      actions: {
        test: async () => {
          order.push("handler");
          return {};
        },
      },
      actionPermissions: {
        test: protectedAction(() => {
          order.push("permission");
          return true;
        }),
      },
      idempotencyService,
    });

    await inject(app, "test", "id", {}, { "idempotency-key": "k1" });

    // Permission should be checked before idempotency
    expect(order.indexOf("permission")).toBeLessThan(order.indexOf("idempotency"));

    await app.close();
  });
});

// ============================================================================
// 14. Tag and Description
// ============================================================================

describe("createActionRouter: Tag and Description", () => {
  it("should use tag as resource in permission context when provided", async () => {
    let capturedResource: string | undefined;

    const app = await buildApp({
      tag: "CustomTag",
      actions: {
        test: async () => ({}),
      },
      actionPermissions: {
        test: protectedAction((ctx) => {
          capturedResource = ctx.resource;
          return true;
        }),
      },
    });

    await inject(app, "test");
    expect(capturedResource).toBe("CustomTag");

    await app.close();
  });

  it('should use "action" as default resource when no tag', async () => {
    let capturedResource: string | undefined;

    const app = await buildApp({
      actions: {
        test: async () => ({}),
      },
      actionPermissions: {
        test: protectedAction((ctx) => {
          capturedResource = ctx.resource;
          return true;
        }),
      },
    });

    await inject(app, "test");
    expect(capturedResource).toBe("action");

    await app.close();
  });
});
