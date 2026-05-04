/**
 * Post Resource Tests
 *
 * Tests CRUD, ownedByUser preset, custom actions, and filtering.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { setupApp, teardownApp, seedUser } from "./setup.js";
import { PostModel } from "../resources/post.resource.js";

describe("Post Resource", () => {
  let app: FastifyInstance;
  let adminToken: string;
  let editorToken: string;
  let editorId: string;

  beforeAll(async () => {
    app = await setupApp();
    const admin = await seedUser({ name: "Admin", email: "post-admin@test.com", role: "admin" });
    const editor = await seedUser({ name: "Editor", email: "post-editor@test.com", role: "editor" });
    adminToken = admin.token;
    editorToken = editor.token;
    editorId = (editor.user._id as { toString(): string }).toString();
  });

  afterAll(async () => {
    await teardownApp();
  });

  beforeEach(async () => {
    await PostModel.deleteMany({});
  });

  // ── Public Read ──────────────────────────────────────────────

  describe("GET /posts (public)", () => {
    it("lists posts without auth", async () => {
      await PostModel.create({ title: "Hello", body: "World", status: "published" });
      const res = await app.inject({ method: "GET", url: "/posts" });
      expect(res.statusCode).toBe(200);
      expect(res.json().data).toHaveLength(1);
    });

    it("supports status filter", async () => {
      await PostModel.create([
        { title: "Draft", body: "...", status: "draft" },
        { title: "Published", body: "...", status: "published" },
      ]);
      const res = await app.inject({ method: "GET", url: "/posts?status=published" });
      expect(res.statusCode).toBe(200);
      expect(res.json().data).toHaveLength(1);
      expect(res.json().data[0].title).toBe("Published");
    });

    it("supports sort by title", async () => {
      await PostModel.create([
        { title: "Banana", body: "b" },
        { title: "Apple", body: "a" },
      ]);
      const res = await app.inject({ method: "GET", url: "/posts?sort=title" });
      expect(res.statusCode).toBe(200);
      expect(res.json().data[0].title).toBe("Apple");
      expect(res.json().data[1].title).toBe("Banana");
    });
  });

  // ── Authenticated Write ──────────────────────────────────────

  describe("POST /posts (authenticated)", () => {
    it("creates a post as authenticated user", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/posts",
        headers: { authorization: `Bearer ${editorToken}` },
        payload: { title: "My Post", body: "Content here", tags: ["tech"] },
      });
      expect(res.statusCode).toBe(201);
      const data = res.json();
      expect(data.title).toBe("My Post");
      expect(data.createdBy).toBe(editorId);
    });

    it("rejects creation without auth", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/posts",
        payload: { title: "Anon", body: "No auth" },
      });
      expect(res.statusCode).toBe(401);
    });
  });

  describe("PATCH /posts/:id (owner or admin)", () => {
    it("allows owner to update their post", async () => {
      const post = await PostModel.create({
        title: "Mine",
        body: "My content",
        createdBy: editorId,
      });
      const res = await app.inject({
        method: "PATCH",
        url: `/posts/${post._id}`,
        headers: { authorization: `Bearer ${editorToken}` },
        payload: { title: "Updated Title" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().title).toBe("Updated Title");
    });

    it("allows admin to update any post", async () => {
      const post = await PostModel.create({
        title: "Others",
        body: "Not admin's",
        createdBy: editorId,
      });
      const res = await app.inject({
        method: "PATCH",
        url: `/posts/${post._id}`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { title: "Admin Edit" },
      });
      expect(res.statusCode).toBe(200);
    });
  });

  describe("DELETE /posts/:id (admin only)", () => {
    it("admin can delete any post", async () => {
      const post = await PostModel.create({ title: "Deletable", body: "Gone" });
      const res = await app.inject({
        method: "DELETE",
        url: `/posts/${post._id}`,
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(res.statusCode).toBe(200);
    });

    it("editor cannot delete posts", async () => {
      const post = await PostModel.create({
        title: "Protected",
        body: "Can't delete",
        createdBy: editorId,
      });
      const res = await app.inject({
        method: "DELETE",
        url: `/posts/${post._id}`,
        headers: { authorization: `Bearer ${editorToken}` },
      });
      expect(res.statusCode).toBe(403);
    });
  });

  // ── Pagination ───────────────────────────────────────────────

  describe("pagination", () => {
    it("returns paginated results", async () => {
      const posts = Array.from({ length: 25 }, (_, i) => ({
        title: `Post ${i}`,
        body: `Body ${i}`,
      }));
      await PostModel.create(posts);

      const page1 = await app.inject({ method: "GET", url: "/posts?page=1&limit=10" });
      expect(page1.statusCode).toBe(200);
      const body1 = page1.json();
      expect(body1.data).toHaveLength(10);
      expect(body1.total).toBe(25);
      expect(body1.pages).toBe(3);
      expect(body1.hasNext).toBe(true);

      const page3 = await app.inject({ method: "GET", url: "/posts?page=3&limit=10" });
      const body3 = page3.json();
      expect(body3.data).toHaveLength(5);
      expect(body3.hasNext).toBe(false);
    });
  });
});
