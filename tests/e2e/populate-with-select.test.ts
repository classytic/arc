/**
 * Populate With Select Test - End-to-End Integration
 *
 * Tests the complete flow:
 * 1. Query string parsing with bracket notation: ?populate[author][select]=name,email
 * 2. QueryParser converting to populateOptions
 * 3. BaseController passing to Repository
 * 4. Repository passing to PaginationEngine
 * 5. Mongoose executing populate with select
 * 6. Response containing only selected fields from populated documents
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import mongoose from "mongoose";
import { createApp } from "../../src/factory/createApp.js";
import { defineResource } from "../../src/core/defineResource.js";
import { BaseController } from "../../src/core/BaseController.js";
import { createMongooseAdapter } from "../../src/adapters/mongoose.js";
import { allowPublic, requireAuth } from "../../src/permissions/index.js";
import { multiTenantPreset } from "../../src/presets/multiTenant.js";
import { QueryParser, Repository } from "@classytic/mongokit";
import type { RequestScope } from "../../src/scope/types.js";
import {
  setupTestDatabase,
  teardownTestDatabase,
  clearDatabase,
} from "../setup.js";
import type { FastifyInstance } from "fastify";

const JWT_SECRET = "test-jwt-secret-must-be-at-least-32-chars-long";

describe("Populate with Select - E2E Integration", () => {
  let app: FastifyInstance;
  let userToken: string;
  let AuthorModel: mongoose.Model<any>;
  let PostModel: mongoose.Model<any>;
  let authorId: string;
  let postId: string;
  const orgId = new mongoose.Types.ObjectId().toString();
  const userId = new mongoose.Types.ObjectId().toString();

  /**
   * Test helper: onRequest hook that resolves `request.scope` from JWT claims
   * and x-organization-id header.
   */
  function scopeFromHeaderHook() {
    return async (request: any, _reply: any): Promise<void> => {
      const user = request.user as Record<string, unknown> | undefined;
      if (!user) return;

      // Read org ID from header (like resolveOrgFromHeader does)
      const headerOrgId = request.headers["x-organization-id"] as
        | string
        | undefined;
      if (headerOrgId) {
        request.scope = {
          kind: "member",
          organizationId: headerOrgId,
          orgRoles: ["member"],
        } satisfies RequestScope;
      }
      // If no header, scope stays 'authenticated' (set by authPlugin)
    };
  }

  beforeAll(async () => {
    // Setup database
    await setupTestDatabase();

    // Create Author model
    const authorSchema = new mongoose.Schema(
      {
        name: { type: String, required: true },
        email: { type: String, required: true },
        bio: String,
        secretField: String, // Field we don't want to expose
        organizationId: { type: mongoose.Schema.Types.ObjectId, index: true },
      },
      { timestamps: true },
    );
    AuthorModel =
      mongoose.models.TestAuthor || mongoose.model("TestAuthor", authorSchema);

    // Create Post model with ref to Author
    const postSchema = new mongoose.Schema(
      {
        title: { type: String, required: true },
        content: String,
        authorId: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "TestAuthor",
          required: true,
        },
        organizationId: { type: mongoose.Schema.Types.ObjectId, index: true },
      },
      { timestamps: true },
    );
    PostModel =
      mongoose.models.TestPost || mongoose.model("TestPost", postSchema);

    // Create repositories using MongoKit
    const postRepo = new Repository(PostModel);

    // Create controller
    const postController = new BaseController(postRepo, {
      resourceName: "post",
    });

    // Create shared query parser (MongoKit)
    const queryParser = new QueryParser();

    // Use multiTenantPreset for org filtering instead of deprecated organizationScoped
    const preset = multiTenantPreset();

    // Define resource with MongoKit query parser for advanced populate
    const postResource = defineResource({
      name: "post",
      displayName: "Posts",
      prefix: "/posts",
      adapter: createMongooseAdapter({
        model: PostModel,
        repository: postRepo,
      }),
      controller: postController,
      queryParser, // MongoKit QueryParser for advanced populate options
      permissions: {
        list: requireAuth(),
        get: requireAuth(),
        create: requireAuth(),
        update: requireAuth(),
        delete: requireAuth(),
      },
      middlewares: preset.middlewares,
    });

    // Create app
    app = await createApp({
      preset: "development",
      auth: { type: "jwt", jwt: { secret: JWT_SECRET } },
      logger: false,
      cors: { origin: true },
      helmet: false,
      rateLimit: false,
      plugins: async (fastify) => {
        // Resolve request.scope from x-organization-id header (replaces orgScopePlugin)
        fastify.addHook("onRequest", scopeFromHeaderHook());
        await fastify.register(postResource.toPlugin());
      },
    });

    await app.ready();

    // Generate token using Arc's auth system (instead of raw jwt.sign)
    userToken = app.auth.issueTokens({
      id: userId,
      email: "user@test.com",
      roles: ["user"],
      organizationId: orgId,
    }).accessToken;
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
    await teardownTestDatabase();
  });

  beforeEach(async () => {
    await clearDatabase();

    // Create test author with all fields
    const author = await AuthorModel.create({
      name: "John Doe",
      email: "john@example.com",
      bio: "A prolific writer",
      secretField: "TOP_SECRET_DATA",
      organizationId: orgId,
    });
    authorId = author._id.toString();

    // Create test post referencing the author
    const post = await PostModel.create({
      title: "Test Post",
      content: "This is a test post",
      authorId: author._id,
      organizationId: orgId,
    });
    postId = post._id.toString();
  });

  // ============================================================================
  // Query String Parsing Tests
  // ============================================================================

  describe("Query String Parsing", () => {
    it("should parse simple populate string", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/posts?populate=authorId",
        headers: {
          "x-organization-id": orgId,
          Authorization: `Bearer ${userToken}`,
        },
      });

      expect(response.statusCode).toBe(200);
      const payload = JSON.parse(response.payload);
      expect(payload.success).toBe(true);
      expect(payload.docs).toHaveLength(1);

      // Author should be populated with ALL fields
      const post = payload.docs[0];
      expect(post.authorId).toBeDefined();
      expect(typeof post.authorId).toBe("object");
      expect(post.authorId.name).toBe("John Doe");
      expect(post.authorId.email).toBe("john@example.com");
      expect(post.authorId.bio).toBe("A prolific writer");
      expect(post.authorId.secretField).toBe("TOP_SECRET_DATA"); // All fields returned
    });

    it("should parse advanced populate with select using bracket notation", async () => {
      // This is the key test - bracket notation: ?populate[authorId][select]=name,email
      const response = await app.inject({
        method: "GET",
        url: "/posts?populate[authorId][select]=name,email",
        headers: {
          "x-organization-id": orgId,
          Authorization: `Bearer ${userToken}`,
        },
      });

      if (response.statusCode !== 200)
        console.log("ERROR:", response.payload, response.statusCode);
      expect(response.statusCode).toBe(200);
      const payload = JSON.parse(response.payload);
      expect(payload.success).toBe(true);
      expect(payload.docs).toHaveLength(1);

      // Author should be populated with ONLY selected fields
      const post = payload.docs[0];
      expect(post.authorId).toBeDefined();
      expect(typeof post.authorId).toBe("object");
      expect(post.authorId.name).toBe("John Doe");
      expect(post.authorId.email).toBe("john@example.com");
      // These fields should NOT be present due to select
      expect(post.authorId.bio).toBeUndefined();
      expect(post.authorId.secretField).toBeUndefined();
    });

    it("should handle URL-encoded bracket notation", async () => {
      // URL encoded: populate%5BauthorId%5D%5Bselect%5D=name%2Cemail
      const response = await app.inject({
        method: "GET",
        url: "/posts?populate%5BauthorId%5D%5Bselect%5D=name%2Cemail",
        headers: {
          "x-organization-id": orgId,
          Authorization: `Bearer ${userToken}`,
        },
      });

      expect(response.statusCode).toBe(200);
      const payload = JSON.parse(response.payload);

      const post = payload.docs[0];
      expect(post.authorId).toBeDefined();
      expect(post.authorId.name).toBe("John Doe");
      expect(post.authorId.email).toBe("john@example.com");
      // These should NOT be present
      expect(post.authorId.bio).toBeUndefined();
      expect(post.authorId.secretField).toBeUndefined();
    });

    it("should work with single field in select", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/posts?populate[authorId][select]=name",
        headers: {
          "x-organization-id": orgId,
          Authorization: `Bearer ${userToken}`,
        },
      });

      expect(response.statusCode).toBe(200);
      const payload = JSON.parse(response.payload);
      const post = payload.docs[0];

      expect(post.authorId.name).toBe("John Doe");
      // Only _id should be returned alongside name (Mongoose always includes _id)
      expect(post.authorId.email).toBeUndefined();
      expect(post.authorId.bio).toBeUndefined();
    });
  });

  // ============================================================================
  // Single Resource Tests (GET by ID)
  // ============================================================================

  describe("Single Resource Populate", () => {
    it("should populate with select on single resource", async () => {
      const response = await app.inject({
        method: "GET",
        url: `/posts/${postId}?populate[authorId][select]=name,email`,
        headers: {
          "x-organization-id": orgId,
          Authorization: `Bearer ${userToken}`,
        },
      });

      expect(response.statusCode).toBe(200);
      const payload = JSON.parse(response.payload);

      expect(payload.data.authorId).toBeDefined();
      expect(payload.data.authorId.name).toBe("John Doe");
      expect(payload.data.authorId.email).toBe("john@example.com");
      expect(payload.data.authorId.secretField).toBeUndefined();
    });
  });

  // ============================================================================
  // Multiple Populate Fields Tests
  // ============================================================================

  describe("Multiple References", () => {
    let CategoryModel: mongoose.Model<any>;
    let MultiRefPostModel: mongoose.Model<any>;
    let categoryId: string;
    let multiRefPostId: string;

    beforeEach(async () => {
      // Create Category model if not exists
      const categorySchema = new mongoose.Schema({
        name: { type: String, required: true },
        description: String,
        secret: String,
        organizationId: mongoose.Schema.Types.ObjectId,
      });
      CategoryModel =
        mongoose.models.TestCategory ||
        mongoose.model("TestCategory", categorySchema);

      // Create MultiRefPost model with multiple refs
      const multiRefPostSchema = new mongoose.Schema({
        title: { type: String, required: true },
        authorId: { type: mongoose.Schema.Types.ObjectId, ref: "TestAuthor" },
        categoryId: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "TestCategory",
        },
        organizationId: mongoose.Schema.Types.ObjectId,
      });
      MultiRefPostModel =
        mongoose.models.TestMultiRefPost ||
        mongoose.model("TestMultiRefPost", multiRefPostSchema);

      // Create test data
      const category = await CategoryModel.create({
        name: "Technology",
        description: "Tech posts",
        secret: "SECRET_CATEGORY_DATA",
        organizationId: orgId,
      });
      categoryId = category._id.toString();

      // Get existing author
      const author = await AuthorModel.findOne({ organizationId: orgId });

      const multiRefPost = await MultiRefPostModel.create({
        title: "Multi-Ref Post",
        authorId: author?._id,
        categoryId: category._id,
        organizationId: orgId,
      });
      multiRefPostId = multiRefPost._id.toString();
    });

    it("should populate multiple refs with different select fields", async () => {
      // Need to create a resource for MultiRefPost
      const multiRefPostRepo = new Repository(MultiRefPostModel);
      const multiRefPostController = new BaseController(multiRefPostRepo, {
        resourceName: "multi-ref-post",
      });
      const queryParser = new QueryParser();

      // Use multiTenantPreset for org filtering
      const multiRefPreset = multiTenantPreset();

      const multiRefPostResource = defineResource({
        name: "multi-ref-post",
        prefix: "/multi-ref-posts",
        adapter: createMongooseAdapter({
          model: MultiRefPostModel,
          repository: multiRefPostRepo,
        }),
        controller: multiRefPostController,
        queryParser,
        permissions: {
          list: requireAuth(),
          get: requireAuth(),
        },
        middlewares: multiRefPreset.middlewares,
      });

      // Create a new app instance for this test
      const testApp = await createApp({
        preset: "development",
        auth: { type: "jwt", jwt: { secret: JWT_SECRET } },
        logger: false,
        cors: { origin: true },
        helmet: false,
        rateLimit: false,
        plugins: async (fastify) => {
          // Resolve request.scope from x-organization-id header
          fastify.addHook("onRequest", scopeFromHeaderHook());
          await fastify.register(multiRefPostResource.toPlugin());
        },
      });

      await testApp.ready();

      try {
        const response = await testApp.inject({
          method: "GET",
          url: "/multi-ref-posts?populate[authorId][select]=name&populate[categoryId][select]=name",
          headers: {
            "x-organization-id": orgId,
            Authorization: `Bearer ${userToken}`,
          },
        });

        expect(response.statusCode).toBe(200);
        const payload = JSON.parse(response.payload);
        const post = payload.docs[0];

        // Author should only have name
        expect(post.authorId.name).toBe("John Doe");
        expect(post.authorId.email).toBeUndefined();

        // Category should only have name
        expect(post.categoryId.name).toBe("Technology");
        expect(post.categoryId.description).toBeUndefined();
        expect(post.categoryId.secret).toBeUndefined();
      } finally {
        await testApp.close();
      }
    });
  });

  // ============================================================================
  // Edge Cases
  // ============================================================================

  describe("Edge Cases", () => {
    it("should handle empty populate value gracefully", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/posts?populate=",
        headers: {
          "x-organization-id": orgId,
          Authorization: `Bearer ${userToken}`,
        },
      });

      expect(response.statusCode).toBe(200);
      const payload = JSON.parse(response.payload);
      // authorId should be just the ObjectId, not populated
      expect(typeof payload.docs[0].authorId).toBe("string");
    });

    it("should handle non-existent field in populate gracefully", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/posts?populate[nonExistentField][select]=name",
        headers: {
          "x-organization-id": orgId,
          Authorization: `Bearer ${userToken}`,
        },
      });

      // Mongoose throws error for non-existent populate paths
      expect(response.statusCode).toBe(500);
    });

    it("should handle populate with filter/pagination together", async () => {
      // Create more posts
      const author = await AuthorModel.findOne({ organizationId: orgId });
      await PostModel.create([
        {
          title: "Post 2",
          content: "Content 2",
          authorId: author?._id,
          organizationId: orgId,
        },
        {
          title: "Post 3",
          content: "Content 3",
          authorId: author?._id,
          organizationId: orgId,
        },
      ]);

      const response = await app.inject({
        method: "GET",
        url: "/posts?populate[authorId][select]=name&page=1&limit=2&sort=-createdAt",
        headers: {
          "x-organization-id": orgId,
          Authorization: `Bearer ${userToken}`,
        },
      });

      expect(response.statusCode).toBe(200);
      const payload = JSON.parse(response.payload);

      expect(payload.docs).toHaveLength(2);
      expect(payload.total).toBe(3);
      // Each post should have author populated with only name
      payload.docs.forEach((post: any) => {
        expect(post.authorId.name).toBe("John Doe");
        expect(post.authorId.email).toBeUndefined();
      });
    });
  });

  // ============================================================================
  // QueryParser Unit Test (Verify parsing logic)
  // ============================================================================

  describe("QueryParser - populateOptions parsing", () => {
    it("should correctly parse bracket notation into populateOptions", () => {
      const queryParser = new QueryParser();

      // Simulate what Fastify would parse with qs
      const query = {
        populate: {
          authorId: {
            select: "name,email",
          },
        },
      };

      const parsed = queryParser.parse(query);

      expect(parsed.populateOptions).toBeDefined();
      expect(parsed.populateOptions).toHaveLength(1);
      expect(parsed.populateOptions![0].path).toBe("authorId");
      expect(parsed.populateOptions![0].select).toBe("name email"); // Converted from comma to space
    });

    it("should parse multiple populate options", () => {
      const queryParser = new QueryParser();

      const query = {
        populate: {
          authorId: { select: "name" },
          categoryId: { select: "name,slug" },
        },
      };

      const parsed = queryParser.parse(query);

      expect(parsed.populateOptions).toHaveLength(2);
      expect(
        parsed.populateOptions!.find((p) => p.path === "authorId")?.select,
      ).toBe("name");
      expect(
        parsed.populateOptions!.find((p) => p.path === "categoryId")?.select,
      ).toBe("name slug");
    });
  });
});
