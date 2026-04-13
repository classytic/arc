/**
 * Tests: createActionRouter + defineResource integration
 *
 * Validates that action routers registered via onRegister work correctly
 * with resource prefixes, and that disableDefaultRoutes does not break
 * action route registration.
 *
 * Bug report: team used disableDefaultRoutes + onRegister with double prefix,
 * reimplemented CRUD as routes, bypassed BaseController pipeline.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import mongoose from "mongoose";
import type { FastifyInstance } from "fastify";
import { setupTestDatabase, teardownTestDatabase, createMockModel, createMockRepository } from "../setup.js";
import { defineResource } from "../../src/core/defineResource.js";
import { createMongooseAdapter } from "../../src/adapters/mongoose.js";
import { BaseController } from "../../src/core/BaseController.js";
import { createActionRouter } from "../../src/core/createActionRouter.js";
import { createApp } from "../../src/factory/createApp.js";
import { allowPublic, requireAuth, requireRoles } from "../../src/permissions/index.js";

describe("createActionRouter + defineResource integration", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    await setupTestDatabase();

    const TransferModel = createMockModel("ActionTransfer");
    const transferRepo = createMockRepository(TransferModel);

    // Seed test data
    await TransferModel.create([
      { name: "TRF-001", description: "Draft transfer", isActive: true },
      { name: "TRF-002", description: "Approved transfer", isActive: true },
    ]);

    // ── CORRECT PATTERN: CRUD via Arc + actions via onRegister ──
    const transferResource = defineResource({
      name: "transfer",
      displayName: "Transfers",
      tag: "Inventory - Transfers",
      prefix: "/inventory/transfers",
      adapter: createMongooseAdapter(TransferModel, transferRepo),
      controller: new BaseController(transferRepo, { resourceName: "transfer", tenantField: false }),
      permissions: {
        list: allowPublic(),
        get: allowPublic(),
        create: allowPublic(),
        update: allowPublic(),
        delete: allowPublic(),
      },
      // Only custom routes that Arc doesn't provide
      routes: [
        {
          method: "GET",
          path: "/stats",
          summary: "Transfer statistics",
          permissions: allowPublic(),
          raw: true,
          handler: async (_req, reply) => reply.send({ success: true, data: { total: 42 } }),
        },
      ],
      // onRegister runs INSIDE the prefixed scope — no manual prefix needed
      onRegister: (fastify) => {
        createActionRouter(fastify, {
          tag: "Inventory - Transfers",
          actions: {
            approve: async (id) => ({ id, status: "approved" }),
            dispatch: async (id, data) => ({ id, status: "dispatched", transport: data.transport }),
            cancel: async (id, data) => ({ id, status: "cancelled", reason: data.reason }),
          },
          actionPermissions: {
            approve: allowPublic(),
            dispatch: allowPublic(),
            cancel: allowPublic(),
          },
          actionSchemas: {
            dispatch: { transport: { type: "object", description: "Transport details" } },
            cancel: { reason: { type: "string", description: "Cancellation reason" } },
          },
        });
      },
    });

    // ── ANTI-PATTERN: disableDefaultRoutes + reimplemented CRUD ──
    const brokenResource = defineResource({
      name: "broken-transfer",
      displayName: "Broken Transfers",
      prefix: "/broken/transfers",
      disableDefaultRoutes: true,
      // No adapter, no controller — just raw routes
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
          path: "/",
          summary: "List (reimplemented)",
          permissions: allowPublic(),
          raw: true,
          handler: async (_req, reply) => reply.send({ success: true, docs: [] }),
        },
        {
          method: "POST",
          path: "/",
          summary: "Create (reimplemented)",
          permissions: allowPublic(),
          raw: true,
          handler: async (req, reply) => reply.code(201).send({ success: true, data: req.body }),
        },
      ],
      // Anti-pattern: manually adding prefix in onRegister
      // Since onRegister now runs INSIDE the prefix scope,
      // adding prefix again creates double prefix: /broken/transfers/broken/transfers/:id/action
      onRegister: (fastify) => {
        fastify.register(
          (instance, _opts, done) => {
            createActionRouter(instance, {
              actions: {
                approve: async (id) => ({ id, approved: true }),
              },
              actionPermissions: { approve: allowPublic() },
            });
            done();
          },
          { prefix: "/broken/transfers" }, // ← WRONG: creates double prefix
        );
      },
    });

    app = await createApp({
      preset: "testing",
      auth: false,
      logger: false,
      plugins: async (f) => {
        await f.register(transferResource.toPlugin());
        await f.register(brokenResource.toPlugin());
      },
    });

    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await teardownTestDatabase();
  });

  // ── Correct pattern tests ──

  it("CRUD routes work via BaseController (no reimplementation needed)", async () => {
    const list = await app.inject({ method: "GET", url: "/inventory/transfers" });
    expect(list.statusCode).toBe(200);
    const body = JSON.parse(list.body);
    expect(body.docs).toBeDefined();
    expect(body.docs.length).toBeGreaterThanOrEqual(2);
  });

  it("GET by ID works via BaseController", async () => {
    const list = await app.inject({ method: "GET", url: "/inventory/transfers" });
    const { docs } = JSON.parse(list.body);
    const id = docs[0]._id;

    const get = await app.inject({ method: "GET", url: `/inventory/transfers/${id}` });
    expect(get.statusCode).toBe(200);
    expect(JSON.parse(get.body).data).toBeDefined();
  });

  it("CREATE works via BaseController", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/inventory/transfers",
      payload: { name: "TRF-003", description: "New transfer" },
    });
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body).data.name).toBe("TRF-003");
  });

  it("action router works at correct prefix", async () => {
    const list = await app.inject({ method: "GET", url: "/inventory/transfers" });
    const { docs } = JSON.parse(list.body);
    const id = docs[0]._id;

    const approve = await app.inject({
      method: "POST",
      url: `/inventory/transfers/${id}/action`,
      payload: { action: "approve" },
    });
    expect(approve.statusCode).toBe(200);
    expect(JSON.parse(approve.body)).toMatchObject({
      success: true,
      data: { id, status: "approved" },
    });
  });

  it("action router with data works", async () => {
    const list = await app.inject({ method: "GET", url: "/inventory/transfers" });
    const { docs } = JSON.parse(list.body);
    const id = docs[0]._id;

    const dispatch = await app.inject({
      method: "POST",
      url: `/inventory/transfers/${id}/action`,
      payload: { action: "dispatch", transport: { driver: "John" } },
    });
    expect(dispatch.statusCode).toBe(200);
    expect(JSON.parse(dispatch.body).data.transport).toEqual({ driver: "John" });
  });

  it("action router rejects invalid action", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/inventory/transfers/some-id/action",
      payload: { action: "nonexistent" },
    });
    // Fastify's schema validation catches invalid enum values before
    // the action handler — returns 400 with "Validation failed"
    expect(res.statusCode).toBe(400);
  });

  it("custom additionalRoute (stats) works alongside CRUD", async () => {
    const res = await app.inject({ method: "GET", url: "/inventory/transfers/stats" });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data.total).toBe(42);
  });

  // ── Anti-pattern tests (broken resource) ──

  it("disableDefaultRoutes: reimplemented CRUD still works (but wastes code)", async () => {
    const list = await app.inject({ method: "GET", url: "/broken/transfers" });
    expect(list.statusCode).toBe(200);
    // Returns raw { docs: [] } instead of Arc's paginated response
    expect(JSON.parse(list.body)).toEqual({ success: true, docs: [] });
  });

  it("disableDefaultRoutes: no BaseController = no pagination/filtering/hooks", async () => {
    const res = await app.inject({ method: "GET", url: "/broken/transfers?page=2&limit=10" });
    // Returns same raw response — query params ignored
    expect(JSON.parse(res.body)).toEqual({ success: true, docs: [] });
  });

  it("broken: manual prefix in onRegister creates double prefix (404 at expected path)", async () => {
    // The action route is at /broken/transfers/broken/transfers/:id/action (double prefix)
    // NOT at /broken/transfers/:id/action
    const res = await app.inject({
      method: "POST",
      url: "/broken/transfers/some-id/action",
      payload: { action: "approve" },
    });
    expect(res.statusCode).toBe(404); // proves the double prefix bug

    // The actual (wrong) path where it ended up:
    const doubled = await app.inject({
      method: "POST",
      url: "/broken/transfers/broken/transfers/some-id/action",
      payload: { action: "approve" },
    });
    expect(doubled.statusCode).toBe(200); // found at double prefix
  });
});
