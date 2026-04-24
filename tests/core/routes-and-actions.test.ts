/**
 * Tests: v2.8 `routes` + `actions` on defineResource
 *
 * Validates:
 * - `routes` replaces `routes` with cleaner API
 * - `actions` creates POST /:id/action endpoint declaratively
 * - Per-action permissions and schemas
 * - MCP tool generation from actions
 * - Cannot mix `routes` + `routes`
 * - Action name cannot collide with CRUD operations
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mongoose from "mongoose";
import type { FastifyInstance } from "fastify";
import { setupTestDatabase, teardownTestDatabase, createMockModel, createMockRepository } from "../setup.js";
import { defineResource } from "../../src/core/defineResource.js";
import { createMongooseAdapter } from "../../src/adapters/mongoose.js";
import { BaseController } from "../../src/core/BaseController.js";
import { createApp } from "../../src/factory/createApp.js";
import { allowPublic, requireAuth, requireRoles } from "../../src/permissions/index.js";

describe("v2.8: routes + actions", () => {
  let app: FastifyInstance;
  let productId: string;

  beforeAll(async () => {
    await setupTestDatabase();

    const Model = createMockModel("RoutesTest");
    const repo = createMockRepository(Model);

    await Model.create([
      { name: "Item A", description: "Draft", isActive: true },
      { name: "Item B", description: "Approved", isActive: true },
    ]);

    const resource = defineResource({
      name: "item",
      displayName: "Items",
      prefix: "/items",
      adapter: createMongooseAdapter(Model, repo),
      controller: new BaseController(repo, { resourceName: "item", tenantField: false }),
      permissions: {
        list: allowPublic(),
        get: allowPublic(),
        create: allowPublic(),
        update: allowPublic(),
        delete: allowPublic(),
      },

      // v2.8 routes (replaces routes)
      routes: [
        {
          method: "GET",
          path: "/stats",
          summary: "Item statistics",
          permissions: allowPublic(),
          handler: async (_req, reply) => reply.send({ success: true, data: { total: 99 } }),
          raw: true,
        },
        {
          method: "POST",
          path: "/bulk-activate",
          summary: "Activate all items",
          permissions: allowPublic(),
          handler: async (_req, reply) => reply.send({ success: true, activated: 5 }),
          raw: true,
        },
      ],

      // v2.8 actions (replaces onRegister + createActionRouter)
      actions: {
        // Bare handler shorthand
        approve: async (id) => ({ id, status: "approved" }),
        // Full config
        dispatch: {
          handler: async (id, data) => ({
            id,
            status: "dispatched",
            transport: data.transport,
          }),
          permissions: allowPublic(),
          schema: {
            type: "object",
            properties: {
              transport: { type: "object", description: "Transport details" },
            },
          },
        },
        cancel: {
          handler: async (id, data) => ({
            id,
            status: "cancelled",
            reason: data.reason,
          }),
          permissions: allowPublic(),
          schema: {
            type: "object",
            properties: {
              reason: { type: "string", description: "Cancellation reason" },
            },
          },
          description: "Cancel an item",
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

    // Get an ID for action tests
    const list = await app.inject({ method: "GET", url: "/items" });
    productId = JSON.parse(list.body).docs[0]._id;
  });

  afterAll(async () => {
    await app?.close();
    await teardownTestDatabase();
  });

  // ── CRUD (auto-generated, unaffected) ──

  it("CRUD list works", async () => {
    const res = await app.inject({ method: "GET", url: "/items" });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).docs.length).toBe(2);
  });

  it("CRUD get works", async () => {
    const res = await app.inject({ method: "GET", url: `/items/${productId}` });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data._id).toBe(productId);
  });

  it("CRUD create works", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/items",
      payload: { name: "Item C" },
    });
    expect(res.statusCode).toBe(201);
  });

  // ── Routes (v2.8) ──

  it("custom route GET /stats works", async () => {
    const res = await app.inject({ method: "GET", url: "/items/stats" });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data.total).toBe(99);
  });

  it("custom route POST /bulk-activate works", async () => {
    const res = await app.inject({ method: "POST", url: "/items/bulk-activate" });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).activated).toBe(5);
  });

  // ── Actions (v2.8) ──

  it("action: approve (bare handler shorthand)", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/items/${productId}/action`,
      payload: { action: "approve" },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data).toMatchObject({ id: productId, status: "approved" });
  });

  it("action: dispatch (full config with data)", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/items/${productId}/action`,
      payload: { action: "dispatch", transport: { driver: "John" } },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.transport).toEqual({ driver: "John" });
  });

  it("action: cancel (full config with schema)", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/items/${productId}/action`,
      payload: { action: "cancel", reason: "No longer needed" },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data.reason).toBe("No longer needed");
  });

  it("action: invalid action returns 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/items/${productId}/action`,
      payload: { action: "nonexistent" },
    });
    expect(res.statusCode).toBe(400);
  });

  // ── Validation ──

  it("action name cannot collide with CRUD operation", () => {
    expect(() =>
      defineResource({
        name: "bad2",
        disableDefaultRoutes: true,
        actions: {
          create: async () => ({}),
        },
      }),
    ).toThrow("conflicts with CRUD");
  });

  it("action handler must be a function", () => {
    expect(() =>
      defineResource({
        name: "bad3",
        disableDefaultRoutes: true,
        actions: {
          approve: { handler: "not a function" as unknown as () => Promise<unknown> },
        },
      }),
    ).toThrow("handler must be a function");
  });
});

// ============================================================================
// Extended Route + Action Tests
// ============================================================================

describe("v2.8: routes — extended", () => {
  let app: FastifyInstance;
  let itemId: string;

  beforeAll(async () => {
    await setupTestDatabase();

    const Model = createMockModel("RoutesExtTest");
    const repo = createMockRepository(Model);

    await Model.create([{ name: "Widget", description: "A widget", isActive: true }]);

    const controller = new BaseController(repo, { resourceName: "routeExt", tenantField: false });

    // Add a custom method on the controller for string handler test
    (controller as Record<string, unknown>).getStats = async () => ({
      success: true,
      data: { total: 42 },
    });

    const resource = defineResource({
      name: "routeExt",
      displayName: "Route Ext Items",
      prefix: "/route-ext",
      adapter: createMongooseAdapter(Model, repo),
      controller,
      permissions: {
        list: allowPublic(),
        get: allowPublic(),
        create: allowPublic(),
        update: allowPublic(),
        delete: allowPublic(),
      },
      routes: [
        {
          method: "GET",
          path: "/stats",
          summary: "Get stats",
          permissions: allowPublic(),
          handler: "getStats",
        },
        {
          method: "GET",
          path: "/raw-info",
          summary: "Raw info",
          permissions: allowPublic(),
          handler: async (_req, reply) => reply.send({ rawField: "rawValue" }),
          raw: true,
        },
        {
          method: "GET",
          path: "/pipeline-info",
          summary: "Pipeline info",
          permissions: allowPublic(),
          handler: async () => ({ success: true, data: { pipelined: true } }),
        },
        {
          method: "GET",
          path: "/protected",
          summary: "Protected route",
          permissions: requireRoles(["admin"]),
          handler: async (_req, reply) => reply.send({ secret: true }),
          raw: true,
        },
        {
          method: "POST",
          path: "/other",
          summary: "Another route",
          permissions: allowPublic(),
          handler: async (_req, reply) => reply.send({ other: true }),
          raw: true,
        },
        {
          method: "GET",
          path: "/stream-test",
          summary: "Stream endpoint",
          permissions: allowPublic(),
          handler: async (_req, reply) => {
            reply.raw.write("data: hello\n\n");
            reply.raw.end();
          },
          raw: true,
          streamResponse: true,
        },
        {
          method: "GET",
          path: "/no-mcp",
          summary: "No MCP",
          permissions: allowPublic(),
          handler: async (_req, reply) => reply.send({ ok: true }),
          raw: true,
          mcp: false,
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

    const list = await app.inject({ method: "GET", url: "/route-ext" });
    itemId = JSON.parse(list.body).docs[0]._id;
  });

  afterAll(async () => {
    await app?.close();
    await teardownTestDatabase();
  });

  // 1. Route with string handler (controller method name)
  it("route with string handler (controller method name) works", async () => {
    const res = await app.inject({ method: "GET", url: "/route-ext/stats" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.total).toBe(42);
  });

  // 2. Route with raw: true bypasses pipeline
  it("route with raw: true returns raw response (no wrapper)", async () => {
    const res = await app.inject({ method: "GET", url: "/route-ext/raw-info" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.rawField).toBe("rawValue");
    // Raw mode: no { success, data } wrapper
    expect(body.success).toBeUndefined();
  });

  // 3. Route without raw defaults to pipeline mode
  it("route without raw defaults to pipeline mode", async () => {
    const res = await app.inject({ method: "GET", url: "/route-ext/pipeline-info" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.pipelined).toBe(true);
  });

  // 4. Route permissions are enforced
  it("route permissions are enforced (rejected when unauthorized)", async () => {
    const res = await app.inject({ method: "GET", url: "/route-ext/protected" });
    // No auth → 401 or 403 depending on auth config
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
  });

  // 5. Multiple routes on same resource don't conflict
  it("multiple routes on same resource don't conflict", async () => {
    const [statsRes, rawRes, otherRes] = await Promise.all([
      app.inject({ method: "GET", url: "/route-ext/stats" }),
      app.inject({ method: "GET", url: "/route-ext/raw-info" }),
      app.inject({ method: "POST", url: "/route-ext/other" }),
    ]);
    expect(statsRes.statusCode).toBe(200);
    expect(rawRes.statusCode).toBe(200);
    expect(otherRes.statusCode).toBe(200);
  });

  // 6. Route with streamResponse: true sets correct headers
  it("route with streamResponse: true sets correct headers", async () => {
    const res = await app.inject({ method: "GET", url: "/route-ext/stream-test" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
  });

  // 16. Route mcp: false is stored correctly
  it("route mcp: false is stored correctly on resource definition", () => {
    const resource = defineResource({
      name: "mcpTest",
      disableDefaultRoutes: true,
      routes: [
        {
          method: "GET",
          path: "/hidden",
          summary: "Hidden from MCP",
          permissions: allowPublic(),
          handler: async (_req, reply) => reply.send({ ok: true }),
          raw: true,
          mcp: false,
        },
      ],
    });
    // Verify the resource retained routes with mcp: false preserved
    expect(resource.routes).toBeDefined();
    expect(resource.routes!.length).toBe(1);
    expect(resource.routes![0].mcp).toBe(false);
  });
});

describe("v2.8: actions — extended", () => {
  let app: FastifyInstance;
  let itemId: string;

  beforeAll(async () => {
    await setupTestDatabase();

    const Model = createMockModel("ActionsExtTest");
    const repo = createMockRepository(Model);

    await Model.create([{ name: "Order A", description: "Pending", isActive: true }]);

    const resource = defineResource({
      name: "order",
      displayName: "Orders",
      prefix: "/orders",
      adapter: createMongooseAdapter(Model, repo),
      controller: new BaseController(repo, { resourceName: "order", tenantField: false }),
      permissions: {
        list: allowPublic(),
        get: allowPublic(),
        create: allowPublic(),
        update: allowPublic(),
        delete: allowPublic(),
      },
      routes: [
        {
          method: "GET",
          path: "/summary",
          summary: "Order summary",
          permissions: allowPublic(),
          handler: async (_req, reply) => reply.send({ success: true, data: { total: 10 } }),
          raw: true,
        },
      ],
      actions: {
        approve: async (id) => ({ id, status: "approved" }),
        dispatch: {
          handler: async (id, data) => ({
            id,
            status: "dispatched",
            carrier: data.carrier,
          }),
          permissions: allowPublic(),
          schema: {
            type: "object",
            properties: { carrier: { type: "string", description: "Carrier name" } },
            required: ["carrier"],
          },
        },
        reject: {
          handler: async (id, data) => ({
            id,
            status: "rejected",
            reason: data.reason,
          }),
          permissions: allowPublic(),
          schema: {
            type: "object",
            properties: { reason: { type: "string", description: "Rejection reason" } },
          },
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

    const list = await app.inject({ method: "GET", url: "/orders" });
    itemId = JSON.parse(list.body).docs[0]._id;
  });

  afterAll(async () => {
    await app?.close();
    await teardownTestDatabase();
  });

  // 7. Multiple actions in sequence
  it("multiple actions in sequence work correctly", async () => {
    const approveRes = await app.inject({
      method: "POST",
      url: `/orders/${itemId}/action`,
      payload: { action: "approve" },
    });
    expect(approveRes.statusCode).toBe(200);
    expect(JSON.parse(approveRes.body).data.status).toBe("approved");

    const dispatchRes = await app.inject({
      method: "POST",
      url: `/orders/${itemId}/action`,
      payload: { action: "dispatch", carrier: "FedEx" },
    });
    expect(dispatchRes.statusCode).toBe(200);
    expect(JSON.parse(dispatchRes.body).data.status).toBe("dispatched");
  });

  // 8. Per-action discriminated body schema enforcement (v2.8.1)
  // Previously: all action fields flattened into one body schema with only `action` required,
  //             so { action: 'dispatch' } without carrier passed validation.
  // Now: each action gets its own branch in a `oneOf` discriminator; AJV enforces per-action
  //      required fields at the HTTP layer. Missing required fields → 400.
  it("action with missing required schema field is rejected with 400 (discriminated body schema)", async () => {
    // dispatch expects carrier — omit it, should be rejected
    const res = await app.inject({
      method: "POST",
      url: `/orders/${itemId}/action`,
      payload: { action: "dispatch" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("action with correct required field passes validation", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/orders/${itemId}/action`,
      payload: { action: "dispatch", carrier: "FedEx" },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.carrier).toBe("FedEx");
  });

  it("action with no schema (bare handler) accepts empty body", async () => {
    // 'approve' is a bare function — no schema means no required fields beyond 'action'
    const res = await app.inject({
      method: "POST",
      url: `/orders/${itemId}/action`,
      payload: { action: "approve" },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
  });

  it("wrong action name is rejected by discriminator (not just by enum)", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/orders/${itemId}/action`,
      payload: { action: "nonexistent" },
    });
    expect(res.statusCode).toBe(400);
  });

  // 9. actionPermissions fallback
  it("actionPermissions fallback is used when action has no per-action permissions", async () => {
    // 'approve' is a bare handler (no per-action permissions) → falls back to actionPermissions: allowPublic()
    const res = await app.inject({
      method: "POST",
      url: `/orders/${itemId}/action`,
      payload: { action: "approve" },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).success).toBe(true);
  });

  // 10. Action handler receives correct id from URL params
  it("action handler receives correct id from URL params", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/orders/${itemId}/action`,
      payload: { action: "approve" },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.id).toBe(itemId);
  });

  // 11. Action handler receives correct data from body (without the action field)
  it("action handler receives correct data from body (without action field)", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/orders/${itemId}/action`,
      payload: { action: "reject", reason: "Quality issues" },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.reason).toBe("Quality issues");
    // The `action` field should NOT be passed to handler as data
    expect(body.data.action).toBeUndefined();
  });

  // 12. Actions work alongside CRUD and routes on same resource
  it("actions work alongside CRUD and routes on same resource", async () => {
    // CRUD list
    const listRes = await app.inject({ method: "GET", url: "/orders" });
    expect(listRes.statusCode).toBe(200);

    // Custom route
    const summaryRes = await app.inject({ method: "GET", url: "/orders/summary" });
    expect(summaryRes.statusCode).toBe(200);
    expect(JSON.parse(summaryRes.body).data.total).toBe(10);

    // Action
    const actionRes = await app.inject({
      method: "POST",
      url: `/orders/${itemId}/action`,
      payload: { action: "approve" },
    });
    expect(actionRes.statusCode).toBe(200);
    expect(JSON.parse(actionRes.body).data.status).toBe("approved");
  });
});

describe("v2.8: edge cases", () => {
  // 13. Resource with only actions (no routes, no CRUD adapter)
  it("resource with only actions (no routes, no CRUD adapter) works", async () => {
    await setupTestDatabase();

    const resource = defineResource({
      name: "workflow",
      displayName: "Workflows",
      prefix: "/workflows",
      disableDefaultRoutes: true,
      actions: {
        start: async (id) => ({ id, started: true }),
        stop: async (id) => ({ id, stopped: true }),
      },
      actionPermissions: allowPublic(),
    });

    const app = await createApp({
      preset: "testing",
      auth: false,
      logger: false,
      plugins: async (f) => {
        await f.register(resource.toPlugin());
      },
    });

    await app.ready();

    // We need a fake ID since there's no CRUD
    const fakeId = "507f1f77bcf86cd799439099";
    const res = await app.inject({
      method: "POST",
      url: `/workflows/${fakeId}/action`,
      payload: { action: "start" },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data.started).toBe(true);

    await app.close();
    await teardownTestDatabase();
  });

  // 14. Resource with only routes (no actions)
  it("resource with only routes (no actions) works", async () => {
    await setupTestDatabase();

    const resource = defineResource({
      name: "health",
      displayName: "Health",
      prefix: "/health",
      disableDefaultRoutes: true,
      routes: [
        {
          method: "GET",
          path: "/status",
          summary: "Health status",
          permissions: allowPublic(),
          handler: async (_req, reply) => reply.send({ status: "ok" }),
          raw: true,
        },
      ],
    });

    const app = await createApp({
      preset: "testing",
      auth: false,
      logger: false,
      plugins: async (f) => {
        await f.register(resource.toPlugin());
      },
    });

    await app.ready();

    const res = await app.inject({ method: "GET", url: "/health/status" });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).status).toBe("ok");

    // No action endpoint should exist
    const actionRes = await app.inject({
      method: "POST",
      url: "/health/123/action",
      payload: { action: "test" },
    });
    expect(actionRes.statusCode).toBe(404);

    await app.close();
    await teardownTestDatabase();
  });

  // 15. Empty actions: {} doesn't register action endpoint
  it("empty actions: {} doesn't register action endpoint", async () => {
    await setupTestDatabase();

    const resource = defineResource({
      name: "emptyAct",
      displayName: "Empty Actions",
      prefix: "/empty-act",
      disableDefaultRoutes: true,
      actions: {},
    });

    const app = await createApp({
      preset: "testing",
      auth: false,
      logger: false,
      plugins: async (f) => {
        await f.register(resource.toPlugin());
      },
    });

    await app.ready();

    const res = await app.inject({
      method: "POST",
      url: "/empty-act/123/action",
      payload: { action: "anything" },
    });
    expect(res.statusCode).toBe(404);

    await app.close();
    await teardownTestDatabase();
  });
});

describe("v2.10.5: action permission fallback chain (security)", () => {
  /**
   * Pre-2.10.5, `actions: { send: async (...) => ... }` on a resource with
   * no `actionPermissions` fell through to auth-only (silent authz hole).
   * Now: fall back to `permissions.update` when nothing else is set, throw
   * at boot when nothing to fall back to.
   */

  it("shorthand action inherits resource's permissions.update when nothing else is set", async () => {
    await setupTestDatabase();

    const Model = createMockModel("PermFallbackA");
    const repo = createMockRepository(Model);
    const [seeded] = await Model.create([{ name: "Invoice-1" }]);

    // Capture the warning the normalizer emits when the fallback kicks in.
    const warnings: unknown[] = [];

    const resource = defineResource({
      name: "invoicePermFallback",
      displayName: "Invoice (perm fallback)",
      prefix: "/invoice-pf",
      adapter: createMongooseAdapter({ model: Model as unknown as mongoose.Model<unknown>, repository: repo }),
      permissions: {
        list: allowPublic(),
        get: allowPublic(),
        create: allowPublic(),
        // update gate — must be inherited by the shorthand `send` action
        update: requireRoles(["admin"]),
        delete: requireRoles(["admin"]),
      },
      actions: {
        // Function shorthand — no per-action permissions, no actionPermissions.
        // Should inherit `permissions.update` via the new fallback chain.
        send: async (id) => ({ id, sent: true }),
      },
    });

    const app = await createApp({
      preset: "testing",
      auth: false,
      logger: {
        level: "warn",
        // Pino's dest can be a Writable; use a minimal object sink.
        stream: {
          write: (chunk: string) => {
            try {
              warnings.push(JSON.parse(chunk));
            } catch {
              warnings.push(chunk);
            }
          },
        } as unknown as NodeJS.WritableStream,
      },
      plugins: async (f) => {
        await f.register(resource.toPlugin());
      },
    });
    await app.ready();

    // Unauthenticated call should be rejected (fallback made this
    // admin-gated, not auth-only).
    const anon = await app.inject({
      method: "POST",
      url: `/invoice-pf/${seeded._id}/action`,
      payload: { action: "send" },
    });
    expect(anon.statusCode).toBe(401);

    // The normalizer emitted a fallback warning.
    const sawFallbackWarn = warnings.some(
      (w) =>
        typeof w === "object" &&
        w !== null &&
        (w as { fallback?: string }).fallback === "permissions.update",
    );
    expect(sawFallbackWarn).toBe(true);

    await app.close();
    await teardownTestDatabase();
  });

  it("throws at boot when a shorthand action has nothing to fall back to", async () => {
    await setupTestDatabase();

    const Model = createMockModel("PermFallbackB");
    const repo = createMockRepository(Model);

    // Build the resource — should throw when .toPlugin() registers because
    // there's no per-action perm, no actionPermissions, and no
    // permissions.update to inherit from.
    const resource = defineResource({
      name: "noGateAction",
      displayName: "No-gate action",
      prefix: "/no-gate",
      adapter: createMongooseAdapter({ model: Model as unknown as mongoose.Model<unknown>, repository: repo }),
      permissions: {
        list: allowPublic(),
        get: allowPublic(),
      },
      actions: {
        unsafeSend: async (id) => ({ id, sent: true }),
      },
    });

    await expect(async () => {
      const app = await createApp({
        preset: "testing",
        auth: false,
        logger: false,
        plugins: async (f) => {
          await f.register(resource.toPlugin());
        },
      });
      await app.ready();
      await app.close();
    }).rejects.toThrow(/no permission gate/i);

    await teardownTestDatabase();
  });

  it("explicit per-action permissions suppress the fallback (no warn)", async () => {
    await setupTestDatabase();

    const Model = createMockModel("PermFallbackC");
    const repo = createMockRepository(Model);
    const [seeded] = await Model.create([{ name: "Explicit" }]);

    const warnings: unknown[] = [];

    const resource = defineResource({
      name: "explicitGate",
      displayName: "Explicit gate",
      prefix: "/explicit",
      adapter: createMongooseAdapter({ model: Model as unknown as mongoose.Model<unknown>, repository: repo }),
      permissions: {
        list: allowPublic(),
        get: allowPublic(),
        create: allowPublic(),
        update: requireRoles(["admin"]),
        delete: requireRoles(["admin"]),
      },
      actions: {
        send: {
          handler: async (id) => ({ id, sent: true }),
          permissions: allowPublic(),
        },
      },
    });

    const app = await createApp({
      preset: "testing",
      auth: false,
      logger: {
        level: "warn",
        stream: {
          write: (chunk: string) => {
            try {
              warnings.push(JSON.parse(chunk));
            } catch {
              warnings.push(chunk);
            }
          },
        } as unknown as NodeJS.WritableStream,
      },
      plugins: async (f) => {
        await f.register(resource.toPlugin());
      },
    });
    await app.ready();

    const res = await app.inject({
      method: "POST",
      url: `/explicit/${seeded._id}/action`,
      payload: { action: "send" },
    });
    expect(res.statusCode).toBe(200);

    const sawFallbackWarn = warnings.some(
      (w) =>
        typeof w === "object" &&
        w !== null &&
        (w as { fallback?: string }).fallback === "permissions.update",
    );
    expect(sawFallbackWarn).toBe(false);

    await app.close();
    await teardownTestDatabase();
  });
});

describe("v2.8: type safety", () => {
  // 17. ActionHandlerFn type accepts proper function signatures
  it("ActionHandlerFn type accepts proper function signatures", () => {
    // This is a compile-time test — if it compiles, it passes
    const handler: import("../../src/types/index.js").ActionHandlerFn = async (
      id: string,
      data: Record<string, unknown>,
      _req,
    ) => {
      return { id, processed: true, extra: data.extra };
    };
    // Runtime verification that the type is usable
    expect(typeof handler).toBe("function");
  });

  // 18. RouteDefinition accepts both raw and pipeline handlers
  it("RouteDefinition accepts both raw and pipeline handlers", () => {
    // Raw handler
    const rawRoute: import("../../src/types/index.js").RouteDefinition = {
      method: "GET",
      path: "/raw",
      permissions: allowPublic(),
      handler: async (_req, reply) => reply.send({ ok: true }),
      raw: true,
    };

    // Pipeline handler (no raw)
    const pipelineRoute: import("../../src/types/index.js").RouteDefinition = {
      method: "GET",
      path: "/pipeline",
      permissions: allowPublic(),
      handler: async () => ({ success: true, data: {} }),
    };

    // String handler
    const stringRoute: import("../../src/types/index.js").RouteDefinition = {
      method: "GET",
      path: "/string",
      permissions: allowPublic(),
      handler: "getStats",
    };

    expect(rawRoute.raw).toBe(true);
    expect(pipelineRoute.raw).toBeUndefined();
    expect(typeof stringRoute.handler).toBe("string");
  });
});

