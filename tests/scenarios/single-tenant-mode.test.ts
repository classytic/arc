/**
 * Single-Tenant Mode Tests
 *
 * Confirms that when NO multiTenantPreset is used, all authenticated
 * users can see all records. No org filtering is applied.
 *
 * Run with: npx vitest run tests/scenarios/single-tenant-mode.test.ts
 */

import type { FastifyInstance } from "fastify";
import mongoose from "mongoose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMongooseAdapter } from "../../src/adapters/mongoose.js";
import { BaseController } from "../../src/core/BaseController.js";
import { defineResource } from "../../src/core/defineResource.js";
import { createApp } from "../../src/factory/createApp.js";
import { anyOf, requireAuth, requireOwnership, requireRoles } from "../../src/permissions/index.js";
import { setupTestDatabase, teardownTestDatabase } from "../setup.js";

const JWT_SECRET = "test-jwt-secret-must-be-at-least-32-chars-long!!";

const USER_1 = new mongoose.Types.ObjectId().toString();
const USER_2 = new mongoose.Types.ObjectId().toString();
const ORG_A = new mongoose.Types.ObjectId().toString();
const ORG_B = new mongoose.Types.ObjectId().toString();

describe("Single-Tenant Mode", () => {
  let app: FastifyInstance;

  const ArticleSchema = new mongoose.Schema(
    {
      title: { type: String, required: true },
      createdBy: { type: mongoose.Schema.Types.ObjectId },
    },
    { timestamps: true },
  );

  beforeAll(async () => {
    await setupTestDatabase();

    const ArticleModel = mongoose.models.STArticle || mongoose.model("STArticle", ArticleSchema);
    const { Repository } = require("@classytic/mongokit");
    const repo = new Repository(ArticleModel);
    const ctrl = new BaseController(repo);

    // NO multiTenantPreset — single-tenant mode
    const resource = defineResource({
      name: "article",
      adapter: createMongooseAdapter({ model: ArticleModel, repository: repo }),
      controller: ctrl,
      prefix: "/articles",
      tag: "Articles",
      permissions: {
        list: requireAuth(),
        get: requireAuth(),
        create: requireAuth(),
        update: anyOf(requireRoles(["admin"]), requireOwnership("createdBy")),
        delete: requireRoles(["admin"]),
      },
    });

    app = await createApp({
      preset: "development",
      auth: { type: "jwt", jwt: { secret: JWT_SECRET } },
      logger: false,
      helmet: false,
      rateLimit: false,
      plugins: async (fastify) => {
        await fastify.register(resource.toPlugin());
      },
    });

    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await teardownTestDatabase();
  });

  function issueToken(payload: Record<string, unknown>) {
    return app.auth.issueTokens(payload).accessToken;
  }

  function headers(token: string) {
    return { authorization: `Bearer ${token}` };
  }

  // --------------------------------------------------------------------------
  // No org filtering
  // --------------------------------------------------------------------------

  describe("No org filtering", () => {
    let article1Id: string;
    let article2Id: string;

    beforeAll(async () => {
      // Create articles as two different users (no org claims — single-tenant mode)
      const token1 = issueToken({ id: USER_1, role: ["user"] });
      const res1 = await app.inject({
        method: "POST",
        url: "/articles",
        headers: headers(token1),
        payload: { title: "Article by User 1" },
      });
      expect(res1.statusCode).toBe(201);
      article1Id = JSON.parse(res1.body).data._id;

      const token2 = issueToken({ id: USER_2, role: ["user"] });
      const res2 = await app.inject({
        method: "POST",
        url: "/articles",
        headers: headers(token2),
        payload: { title: "Article by User 2" },
      });
      expect(res2.statusCode).toBe(201);
      article2Id = JSON.parse(res2.body).data._id;
    });

    it("all authenticated users see all records (no org scope without multiTenantPreset)", async () => {
      const token = issueToken({ id: USER_1, role: ["user"] });
      const res = await app.inject({
        method: "GET",
        url: "/articles",
        headers: headers(token),
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      const ids = body.docs.map((d: any) => d._id);
      // Without multiTenantPreset and no org in token, both users see all records
      expect(ids).toContain(article1Id);
      expect(ids).toContain(article2Id);
    });

    it("authenticated scope sees all records (no org filtering applied)", async () => {
      // User 2 also sees all records
      const token = issueToken({ id: USER_2, role: ["user"] });
      const res = await app.inject({
        method: "GET",
        url: "/articles",
        headers: headers(token),
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      const ids = body.docs.map((d: any) => d._id);
      expect(ids).toContain(article1Id);
      expect(ids).toContain(article2Id);
    });

    it("no organizationId is auto-injected on create", async () => {
      const token = issueToken({ id: USER_1, role: ["user"] });
      const res = await app.inject({
        method: "POST",
        url: "/articles",
        headers: headers(token),
        payload: { title: "No Org Article" },
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      // Without multiTenantPreset, organizationId should NOT be set
      expect(body.data.organizationId).toBeUndefined();
    });
  });

  // --------------------------------------------------------------------------
  // Permission enforcement still works
  // --------------------------------------------------------------------------

  describe("Permission enforcement still works", () => {
    it("requireAuth blocks unauthenticated users", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/articles",
      });

      expect(res.statusCode).toBe(401);
    });

    it("requireRoles blocks insufficient roles", async () => {
      const token = issueToken({ id: USER_1, role: ["user"] });
      // Create an article first
      const createRes = await app.inject({
        method: "POST",
        url: "/articles",
        headers: headers(token),
        payload: { title: "Role Test" },
      });
      const articleId = JSON.parse(createRes.body).data._id;

      // Regular user cannot delete (requireRoles(['admin']))
      const res = await app.inject({
        method: "DELETE",
        url: `/articles/${articleId}`,
        headers: headers(token),
      });

      expect(res.statusCode).toBe(403);
    });

    it("requireOwnership scopes to createdBy (no org context needed)", async () => {
      // User 1 creates an article
      const token1 = issueToken({ id: USER_1, role: ["user"] });
      const createRes = await app.inject({
        method: "POST",
        url: "/articles",
        headers: headers(token1),
        payload: { title: "Owned by User 1" },
      });
      const articleId = JSON.parse(createRes.body).data._id;

      // User 1 can update (owner)
      const updateRes = await app.inject({
        method: "PATCH",
        url: `/articles/${articleId}`,
        headers: headers(token1),
        payload: { title: "Updated by Owner" },
      });
      expect(updateRes.statusCode).toBe(200);

      // User 2 cannot update (not owner, not admin)
      const token2 = issueToken({ id: USER_2, role: ["user"] });
      const failRes = await app.inject({
        method: "PATCH",
        url: `/articles/${articleId}`,
        headers: headers(token2),
        payload: { title: "Hacked" },
      });
      // Should get 403 or 404 (filtered by ownership)
      expect([403, 404]).toContain(failRes.statusCode);
    });
  });
});
