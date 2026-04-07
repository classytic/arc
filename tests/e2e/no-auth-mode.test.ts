/**
 * No-Auth Mode E2E Tests
 *
 * Tests that Arc resources work correctly when auth is disabled (`auth: false`):
 *
 * 1. Resources with allowPublic() permissions — full CRUD works without auth
 * 2. Resources with no permissions — full CRUD works without auth (default public)
 * 3. Resources with requireAuth() — returns 401 (permission check still enforced)
 * 4. App boots correctly without any auth configuration
 * 5. tenantField: false works in no-auth mode (platform-universal)
 */

import type { FastifyInstance } from "fastify";
import mongoose from "mongoose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMongooseAdapter } from "../../src/adapters/mongoose.js";
import { defineResource } from "../../src/core/defineResource.js";
import { createApp } from "../../src/factory/createApp.js";
import { allowPublic, requireAuth } from "../../src/permissions/index.js";
import { setupTestDatabase, teardownTestDatabase } from "../setup.js";

// ============================================================================
// Schemas
// ============================================================================

const PublicItemSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    price: { type: Number, default: 0 },
  },
  { timestamps: true },
);

const DefaultItemSchema = new mongoose.Schema(
  {
    title: { type: String, required: true },
  },
  { timestamps: true },
);

const ProtectedItemSchema = new mongoose.Schema(
  {
    secret: { type: String, required: true },
  },
  { timestamps: true },
);

// ============================================================================
// Tests
// ============================================================================

describe("No-Auth Mode E2E (auth: false)", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    await setupTestDatabase();

    const PublicModel =
      mongoose.models.NoAuthPublic || mongoose.model("NoAuthPublic", PublicItemSchema);
    const DefaultModel =
      mongoose.models.NoAuthDefault || mongoose.model("NoAuthDefault", DefaultItemSchema);
    const ProtectedModel =
      mongoose.models.NoAuthProtected || mongoose.model("NoAuthProtected", ProtectedItemSchema);

    const { Repository } = require("@classytic/mongokit");

    // Resource 1: explicit allowPublic() on all routes
    const publicResource = defineResource({
      name: "public-item",
      adapter: createMongooseAdapter({
        model: PublicModel,
        repository: new Repository(PublicModel),
      }),
      prefix: "/public-items",
      tenantField: false,
      permissions: {
        list: allowPublic(),
        get: allowPublic(),
        create: allowPublic(),
        update: allowPublic(),
        delete: allowPublic(),
      },
    });

    // Resource 2: no permissions defined (defaults to public)
    const defaultResource = defineResource({
      name: "default-item",
      adapter: createMongooseAdapter({
        model: DefaultModel,
        repository: new Repository(DefaultModel),
      }),
      prefix: "/default-items",
      tenantField: false,
    });

    // Resource 3: requireAuth() on all routes
    const protectedResource = defineResource({
      name: "protected-item",
      adapter: createMongooseAdapter({
        model: ProtectedModel,
        repository: new Repository(ProtectedModel),
      }),
      prefix: "/protected-items",
      tenantField: false,
      permissions: {
        list: requireAuth(),
        get: requireAuth(),
        create: requireAuth(),
        update: requireAuth(),
        delete: requireAuth(),
      },
    });

    app = await createApp({
      preset: "development",
      auth: false,
      logger: false,
      helmet: false,
      rateLimit: false,
      plugins: async (fastify) => {
        await fastify.register(publicResource.toPlugin());
        await fastify.register(defaultResource.toPlugin());
        await fastify.register(protectedResource.toPlugin());
      },
    });

    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await teardownTestDatabase();
  });

  // --------------------------------------------------------------------------
  // allowPublic() resources — full CRUD without auth
  // --------------------------------------------------------------------------

  describe("allowPublic() resource — full CRUD without auth", () => {
    let itemId: string;

    it("should create item without authentication", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/public-items",
        payload: { name: "Widget", price: 19.99 },
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.name).toBe("Widget");
      itemId = body.data._id;
    });

    it("should list items without authentication", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/public-items",
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.docs.length).toBeGreaterThanOrEqual(1);
    });

    it("should get item by ID without authentication", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/public-items/${itemId}`,
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).data.name).toBe("Widget");
    });

    it("should update item without authentication", async () => {
      const res = await app.inject({
        method: "PATCH",
        url: `/public-items/${itemId}`,
        payload: { price: 24.99 },
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).data.price).toBe(24.99);
    });

    it("should delete item without authentication", async () => {
      const res = await app.inject({
        method: "DELETE",
        url: `/public-items/${itemId}`,
      });

      expect(res.statusCode).toBe(200);
    });
  });

  // --------------------------------------------------------------------------
  // No permissions defined — defaults to public
  // --------------------------------------------------------------------------

  describe("No permissions defined — defaults to public", () => {
    let itemId: string;

    it("should create item without authentication", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/default-items",
        payload: { title: "Default Item" },
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      itemId = body.data._id;
    });

    it("should list items without authentication", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/default-items",
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.docs.length).toBeGreaterThanOrEqual(1);
    });

    it("should get item by ID without authentication", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/default-items/${itemId}`,
      });

      expect(res.statusCode).toBe(200);
    });

    it("should update item without authentication", async () => {
      const res = await app.inject({
        method: "PATCH",
        url: `/default-items/${itemId}`,
        payload: { title: "Updated" },
      });

      expect(res.statusCode).toBe(200);
    });

    it("should delete item without authentication", async () => {
      const res = await app.inject({
        method: "DELETE",
        url: `/default-items/${itemId}`,
      });

      expect(res.statusCode).toBe(200);
    });
  });

  // --------------------------------------------------------------------------
  // requireAuth() resources — returns 401
  // --------------------------------------------------------------------------

  describe("requireAuth() resource — enforces 401 even with auth: false", () => {
    it("should reject list with 401", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/protected-items",
      });

      expect(res.statusCode).toBe(401);
    });

    it("should reject create with 401", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/protected-items",
        payload: { secret: "should-fail" },
      });

      expect(res.statusCode).toBe(401);
    });
  });
});
