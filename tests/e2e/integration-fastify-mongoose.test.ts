/**
 * Integration Tests - Fastify + Mongoose + Arc Features
 *
 * Comprehensive integration tests covering:
 * - Authentication & Authorization
 * - Multi-tenant organization scoping
 * - All CRUD operations with permissions
 * - Preset behaviors (softDelete, slugLookup)
 * - Hook system
 * - Event emission
 * - Error handling
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import mongoose from "mongoose";
import jwt from "jsonwebtoken";
import { createApp } from "../../src/factory/createApp.js";
import { defineResource } from "../../src/core/defineResource.js";
import { BaseController } from "../../src/core/BaseController.js";
import { createMongooseAdapter } from "../../src/adapters/mongoose.js";
import {
  allowPublic,
  requireAuth,
  requireRoles,
  requireOwnership,
} from "../../src/permissions/index.js";
import {
  setupTestDatabase,
  teardownTestDatabase,
  clearDatabase,
} from "../setup.js";
import type { FastifyInstance } from "fastify";

const JWT_SECRET = "test-jwt-secret-must-be-at-least-32-chars-long";

/**
 * TODO: This test needs refactoring
 *
 * Issue: The test mixes incompatible patterns:
 * - Uses allowPublic() for list/get (expects access without auth/org)
 * - Uses organizationScoped: true (requires org header for all routes)
 * - Has org-specific test suites that depend on org scoping
 *
 * Resolution options:
 * 1. Split into two test files: one for auth/permissions, one for org scoping
 * 2. Remove allowPublic() and require auth for all routes when using org scoping
 * 3. Use separate resources for public vs org-scoped endpoints
 */
describe.skip("Integration: Fastify + Mongoose + Arc", () => {
  let app: FastifyInstance;
  let mongoUri: string;
  let adminToken: string;
  let userToken: string;
  let guestToken: string;

  // Test data IDs
  const adminUserId = new mongoose.Types.ObjectId().toString();
  const regularUserId = new mongoose.Types.ObjectId().toString();
  const org1Id = new mongoose.Types.ObjectId().toString();
  const org2Id = new mongoose.Types.ObjectId().toString();

  beforeAll(async () => {
    // Setup database
    mongoUri = await setupTestDatabase();

    // Generate tokens
    adminToken = jwt.sign(
      {
        sub: adminUserId,
        email: "admin@test.com",
        roles: ["admin"],
        organizations: [{ _id: org1Id, roles: ["admin"] }],
      },
      JWT_SECRET,
      { expiresIn: "1h" },
    );
    userToken = jwt.sign(
      {
        sub: regularUserId,
        email: "user@test.com",
        roles: ["user"],
        organizations: [{ _id: org1Id, roles: ["member"] }],
      },
      JWT_SECRET,
      { expiresIn: "1h" },
    );
    guestToken = jwt.sign(
      {
        sub: new mongoose.Types.ObjectId().toString(),
        email: "guest@test.com",
        roles: [],
      },
      JWT_SECRET,
      { expiresIn: "1h" },
    );

    // Create Article model with presets support
    const articleSchema = new mongoose.Schema(
      {
        title: { type: String, required: true },
        slug: { type: String, unique: true, sparse: true },
        content: String,
        status: {
          type: String,
          enum: ["draft", "published", "archived"],
          default: "draft",
        },
        organizationId: {
          type: mongoose.Schema.Types.ObjectId,
          required: true,
          index: true,
        },
        createdBy: { type: mongoose.Schema.Types.ObjectId, index: true },
        deletedAt: { type: Date, default: null },
        isActive: { type: Boolean, default: true },
      },
      { timestamps: true },
    );

    const ArticleModel =
      mongoose.models.IntegrationArticle ||
      mongoose.model("IntegrationArticle", articleSchema);

    // Create repository using MongoKit
    const { Repository, softDeletePlugin } =
      await import("@classytic/mongokit");
    const articleRepo = new Repository(ArticleModel, [softDeletePlugin()]);

    // Create controller
    const articleController = new BaseController(articleRepo);

    // Define resource with full configuration
    const articleResource = defineResource({
      name: "article",
      displayName: "Articles",
      prefix: "/articles",
      tag: "Content",
      adapter: createMongooseAdapter({
        model: ArticleModel,
        repository: articleRepo,
      }),
      controller: articleController,
      presets: ["softDelete", "slugLookup"],
      // Note: organizationScoped removed - this test focuses on auth/permission patterns
      // For org scoping tests, see a dedicated org-scope test file
      permissions: {
        list: allowPublic(),
        get: allowPublic(),
        create: requireAuth(),
        update: requireOwnership("createdBy"),
        delete: requireRoles(["admin"]),
        // Soft delete preset permissions
        deleted: requireRoles(["admin"]),
        restore: requireRoles(["admin"]),
      },
    });

    // Create app
    app = await createApp({
      preset: "development",
      auth: { jwt: { secret: JWT_SECRET } },
      logger: false,
      cors: { origin: true },
      helmet: false,
      rateLimit: false,
      plugins: async (fastify) => {
        // Register hooks
        fastify.arc.hooks.before(
          "article",
          "create",
          async (ctx: { data?: { title?: string; slug?: string } }) => {
            if (ctx.data?.title && !ctx.data.slug) {
              return {
                ...ctx.data,
                slug: ctx.data.title
                  .toLowerCase()
                  .replace(/\s+/g, "-")
                  .replace(/[^a-z0-9-]/g, ""),
              };
            }
          },
        );

        // Register resource
        await fastify.register(articleResource.toPlugin());
      },
    });

    await app.listen({ port: 0, host: "127.0.0.1" });
  });

  afterAll(async () => {
    await app.close();
    await teardownTestDatabase();
  });

  beforeEach(async () => {
    await clearDatabase();
  });

  // ============================================================================
  // Authentication Tests
  // ============================================================================

  describe("Authentication", () => {
    it("should allow public access to list endpoint", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/articles",
      });

      expect(response.statusCode).toBe(200);
    });

    it("should require auth for create endpoint", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/articles",
        payload: { title: "Test" },
      });

      // Without auth, should fail
      expect(response.statusCode).toBe(401);
    });

    it("should allow authenticated user to create", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/articles",
        headers: {
          authorization: `Bearer ${userToken}`,
          "x-organization-id": org1Id,
        },
        payload: { title: "Test Article", content: "Test content" },
      });

      expect(response.statusCode).toBe(201);
      const payload = JSON.parse(response.payload);
      expect(payload.success).toBe(true);
      expect(payload.data.title).toBe("Test Article");
    });
  });

  // ============================================================================
  // Authorization & Permissions Tests
  // ============================================================================

  describe("Authorization & Permissions", () => {
    let articleId: string;

    beforeEach(async () => {
      // Create article as regular user
      const response = await app.inject({
        method: "POST",
        url: "/articles",
        headers: {
          authorization: `Bearer ${userToken}`,
          "x-organization-id": org1Id,
        },
        payload: { title: "User Article", content: "Content" },
      });
      articleId = JSON.parse(response.payload).data._id;
    });

    it("should allow owner to update their article", async () => {
      const response = await app.inject({
        method: "PATCH",
        url: `/articles/${articleId}`,
        headers: {
          authorization: `Bearer ${userToken}`,
          "x-organization-id": org1Id,
        },
        payload: { content: "Updated content" },
      });

      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.payload).data.content).toBe("Updated content");
    });

    it("should deny non-owner from updating article", async () => {
      // Create another user token
      const otherUserId = new mongoose.Types.ObjectId().toString();
      const otherUserToken = jwt.sign(
        {
          sub: otherUserId,
          email: "other@test.com",
          roles: ["user"],
          organizations: [{ _id: org1Id, roles: ["member"] }],
        },
        JWT_SECRET,
      );

      const response = await app.inject({
        method: "PATCH",
        url: `/articles/${articleId}`,
        headers: {
          authorization: `Bearer ${otherUserToken}`,
          "x-organization-id": org1Id,
        },
        payload: { content: "Hacked content" },
      });

      expect(response.statusCode).toBe(403);
    });

    it("should allow admin to delete any article", async () => {
      const response = await app.inject({
        method: "DELETE",
        url: `/articles/${articleId}`,
        headers: {
          authorization: `Bearer ${adminToken}`,
          "x-organization-id": org1Id,
        },
      });

      expect(response.statusCode).toBe(200);
    });

    it("should deny non-admin from deleting", async () => {
      const response = await app.inject({
        method: "DELETE",
        url: `/articles/${articleId}`,
        headers: {
          authorization: `Bearer ${userToken}`,
          "x-organization-id": org1Id,
        },
      });

      expect(response.statusCode).toBe(403);
    });
  });

  // ============================================================================
  // Multi-Tenant Organization Scoping Tests
  // ============================================================================

  describe("Multi-Tenant Organization Scoping", () => {
    beforeEach(async () => {
      // Create articles in different orgs directly in DB
      const ArticleModel = mongoose.model("IntegrationArticle");
      await ArticleModel.create([
        {
          title: "Org1 Article 1",
          organizationId: org1Id,
          createdBy: adminUserId,
        },
        {
          title: "Org1 Article 2",
          organizationId: org1Id,
          createdBy: regularUserId,
        },
        {
          title: "Org2 Article 1",
          organizationId: org2Id,
          createdBy: new mongoose.Types.ObjectId(),
        },
      ]);
    });

    it("should only return articles from requested organization", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/articles",
        headers: {
          "x-organization-id": org1Id,
        },
      });

      expect(response.statusCode).toBe(200);
      const payload = JSON.parse(response.payload);

      // Should only get org1 articles
      expect(payload.data.length).toBe(2);
      payload.data.forEach((article: any) => {
        expect(article.organizationId.toString()).toBe(org1Id);
      });
    });

    it("should auto-inject organizationId on create", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/articles",
        headers: {
          authorization: `Bearer ${userToken}`,
          "x-organization-id": org1Id,
        },
        payload: { title: "New Article", content: "Content" },
      });

      expect(response.statusCode).toBe(201);
      const payload = JSON.parse(response.payload);
      expect(payload.data.organizationId.toString()).toBe(org1Id);
    });

    it("should prevent access to articles from other organizations", async () => {
      // Get org2 article ID
      const ArticleModel = mongoose.model("IntegrationArticle");
      const org2Article = await ArticleModel.findOne({
        organizationId: org2Id,
      });

      // Try to access org2 article with org1 context
      const response = await app.inject({
        method: "GET",
        url: `/articles/${org2Article!._id}`,
        headers: {
          "x-organization-id": org1Id,
        },
      });

      expect(response.statusCode).toBe(404);
    });
  });

  // ============================================================================
  // Soft Delete Preset Tests
  // ============================================================================

  describe("Soft Delete Preset", () => {
    let articleId: string;

    beforeEach(async () => {
      const response = await app.inject({
        method: "POST",
        url: "/articles",
        headers: {
          authorization: `Bearer ${adminToken}`,
          "x-organization-id": org1Id,
        },
        payload: { title: "Deletable Article" },
      });
      articleId = JSON.parse(response.payload).data._id;
    });

    it("should soft delete instead of hard delete", async () => {
      // Delete
      const deleteResponse = await app.inject({
        method: "DELETE",
        url: `/articles/${articleId}`,
        headers: {
          authorization: `Bearer ${adminToken}`,
          "x-organization-id": org1Id,
        },
      });
      expect(deleteResponse.statusCode).toBe(200);

      // Article should not appear in list
      const listResponse = await app.inject({
        method: "GET",
        url: "/articles",
        headers: { "x-organization-id": org1Id },
      });
      const articles = JSON.parse(listResponse.payload).data;
      expect(articles.find((a: any) => a._id === articleId)).toBeUndefined();

      // But should exist in DB with deletedAt set
      const ArticleModel = mongoose.model("IntegrationArticle");
      const deleted = await ArticleModel.findById(articleId);
      expect(deleted).not.toBeNull();
      expect(deleted!.deletedAt).not.toBeNull();
    });

    it("should allow admin to view deleted articles", async () => {
      // Delete article
      await app.inject({
        method: "DELETE",
        url: `/articles/${articleId}`,
        headers: {
          authorization: `Bearer ${adminToken}`,
          "x-organization-id": org1Id,
        },
      });

      // Get deleted articles
      const response = await app.inject({
        method: "GET",
        url: "/articles/deleted",
        headers: {
          authorization: `Bearer ${adminToken}`,
          "x-organization-id": org1Id,
        },
      });

      expect(response.statusCode).toBe(200);
      const payload = JSON.parse(response.payload);
      expect(payload.data.length).toBeGreaterThanOrEqual(1);
    });

    it("should allow admin to restore deleted articles", async () => {
      // Delete article
      await app.inject({
        method: "DELETE",
        url: `/articles/${articleId}`,
        headers: {
          authorization: `Bearer ${adminToken}`,
          "x-organization-id": org1Id,
        },
      });

      // Restore
      const restoreResponse = await app.inject({
        method: "POST",
        url: `/articles/${articleId}/restore`,
        headers: {
          authorization: `Bearer ${adminToken}`,
          "x-organization-id": org1Id,
        },
      });

      expect(restoreResponse.statusCode).toBe(200);

      // Should appear in list again
      const listResponse = await app.inject({
        method: "GET",
        url: "/articles",
        headers: { "x-organization-id": org1Id },
      });
      const articles = JSON.parse(listResponse.payload).data;
      expect(articles.find((a: any) => a._id === articleId)).toBeDefined();
    });
  });

  // ============================================================================
  // Slug Lookup Preset Tests
  // ============================================================================

  describe("Slug Lookup Preset", () => {
    beforeEach(async () => {
      await app.inject({
        method: "POST",
        url: "/articles",
        headers: {
          authorization: `Bearer ${userToken}`,
          "x-organization-id": org1Id,
        },
        payload: { title: "My Awesome Article" },
      });
    });

    it("should auto-generate slug from title via hook", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/articles",
        headers: { "x-organization-id": org1Id },
      });

      const article = JSON.parse(response.payload).data[0];
      expect(article.slug).toBe("my-awesome-article");
    });

    it("should allow lookup by slug", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/articles/slug/my-awesome-article",
        headers: { "x-organization-id": org1Id },
      });

      expect(response.statusCode).toBe(200);
      const payload = JSON.parse(response.payload);
      expect(payload.data.title).toBe("My Awesome Article");
    });

    it("should return 404 for non-existent slug", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/articles/slug/non-existent-slug",
        headers: { "x-organization-id": org1Id },
      });

      expect(response.statusCode).toBe(404);
    });
  });

  // ============================================================================
  // CRUD Operations Tests
  // ============================================================================

  describe("CRUD Operations", () => {
    it("should create, read, update, delete successfully", async () => {
      // CREATE
      const createResponse = await app.inject({
        method: "POST",
        url: "/articles",
        headers: {
          authorization: `Bearer ${adminToken}`,
          "x-organization-id": org1Id,
        },
        payload: {
          title: "CRUD Test",
          content: "Initial content",
          status: "draft",
        },
      });
      expect(createResponse.statusCode).toBe(201);
      const created = JSON.parse(createResponse.payload).data;
      const articleId = created._id;

      // READ (single)
      const readResponse = await app.inject({
        method: "GET",
        url: `/articles/${articleId}`,
        headers: { "x-organization-id": org1Id },
      });
      expect(readResponse.statusCode).toBe(200);
      expect(JSON.parse(readResponse.payload).data.title).toBe("CRUD Test");

      // UPDATE
      const updateResponse = await app.inject({
        method: "PATCH",
        url: `/articles/${articleId}`,
        headers: {
          authorization: `Bearer ${adminToken}`,
          "x-organization-id": org1Id,
        },
        payload: { status: "published", content: "Updated content" },
      });
      expect(updateResponse.statusCode).toBe(200);
      const updated = JSON.parse(updateResponse.payload).data;
      expect(updated.status).toBe("published");
      expect(updated.content).toBe("Updated content");

      // DELETE
      const deleteResponse = await app.inject({
        method: "DELETE",
        url: `/articles/${articleId}`,
        headers: {
          authorization: `Bearer ${adminToken}`,
          "x-organization-id": org1Id,
        },
      });
      expect(deleteResponse.statusCode).toBe(200);

      // Verify deleted
      const verifyResponse = await app.inject({
        method: "GET",
        url: `/articles/${articleId}`,
        headers: { "x-organization-id": org1Id },
      });
      expect(verifyResponse.statusCode).toBe(404);
    });
  });

  // ============================================================================
  // Query Features Tests
  // ============================================================================

  describe("Query Features", () => {
    beforeEach(async () => {
      const ArticleModel = mongoose.model("IntegrationArticle");
      await ArticleModel.create([
        {
          title: "A First",
          organizationId: org1Id,
          createdBy: adminUserId,
          status: "published",
        },
        {
          title: "B Second",
          organizationId: org1Id,
          createdBy: adminUserId,
          status: "draft",
        },
        {
          title: "C Third",
          organizationId: org1Id,
          createdBy: regularUserId,
          status: "published",
        },
        {
          title: "D Fourth",
          organizationId: org1Id,
          createdBy: regularUserId,
          status: "archived",
        },
      ]);
    });

    it("should filter by field value", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/articles?status=published",
        headers: { "x-organization-id": org1Id },
      });

      expect(response.statusCode).toBe(200);
      const payload = JSON.parse(response.payload);
      expect(payload.data.length).toBe(2);
      payload.data.forEach((a: any) => {
        expect(a.status).toBe("published");
      });
    });

    it("should sort results", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/articles?sort=title",
        headers: { "x-organization-id": org1Id },
      });

      expect(response.statusCode).toBe(200);
      const titles = JSON.parse(response.payload).data.map((a: any) => a.title);
      expect(titles[0]).toBe("A First");
      expect(titles[titles.length - 1]).toBe("D Fourth");
    });

    it("should sort descending with minus prefix", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/articles?sort=-title",
        headers: { "x-organization-id": org1Id },
      });

      expect(response.statusCode).toBe(200);
      const titles = JSON.parse(response.payload).data.map((a: any) => a.title);
      expect(titles[0]).toBe("D Fourth");
    });

    it("should paginate results", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/articles?page=1&limit=2",
        headers: { "x-organization-id": org1Id },
      });

      expect(response.statusCode).toBe(200);
      const payload = JSON.parse(response.payload);
      expect(payload.data.length).toBe(2);
      expect(payload.total).toBe(4);
      expect(payload.page).toBe(1);
      expect(payload.limit).toBe(2);
    });
  });

  // ============================================================================
  // Error Handling Tests
  // ============================================================================

  describe("Error Handling", () => {
    it("should return 404 for non-existent resource", async () => {
      const fakeId = new mongoose.Types.ObjectId().toString();
      const response = await app.inject({
        method: "GET",
        url: `/articles/${fakeId}`,
        headers: { "x-organization-id": org1Id },
      });

      expect(response.statusCode).toBe(404);
    });

    it("should return 400 for invalid ObjectId", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/articles/invalid-id",
        headers: { "x-organization-id": org1Id },
      });

      expect(response.statusCode).toBeGreaterThanOrEqual(400);
    });

    it("should return 401 for missing auth on protected route", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/articles",
        payload: { title: "Test" },
      });

      expect(response.statusCode).toBe(401);
    });

    it("should return 403 for unauthorized action", async () => {
      // Create article
      const createResponse = await app.inject({
        method: "POST",
        url: "/articles",
        headers: {
          authorization: `Bearer ${userToken}`,
          "x-organization-id": org1Id,
        },
        payload: { title: "Test" },
      });
      const articleId = JSON.parse(createResponse.payload).data._id;

      // Try to delete as non-admin
      const response = await app.inject({
        method: "DELETE",
        url: `/articles/${articleId}`,
        headers: {
          authorization: `Bearer ${userToken}`,
          "x-organization-id": org1Id,
        },
      });

      expect(response.statusCode).toBe(403);
    });
  });
});
