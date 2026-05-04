/**
 * User Resource Tests
 *
 * Tests CRUD operations, permissions, and soft delete preset.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { setupApp, teardownApp, seedUser } from "./setup.js";
import { UserModel } from "../resources/user.resource.js";

describe("User Resource", () => {
  let app: FastifyInstance;
  let adminToken: string;
  let viewerToken: string;

  beforeAll(async () => {
    app = await setupApp();
    const admin = await seedUser({ name: "Admin", email: "admin@test.com", role: "admin" });
    const viewer = await seedUser({ name: "Viewer", email: "viewer@test.com", role: "viewer" });
    adminToken = admin.token;
    viewerToken = viewer.token;
  });

  afterAll(async () => {
    await teardownApp();
  });

  beforeEach(async () => {
    // Clean non-seed users
    await UserModel.deleteMany({ email: { $nin: ["admin@test.com", "viewer@test.com"] } });
  });

  // ── Public Read ──────────────────────────────────────────────

  describe("GET /users (public)", () => {
    it("lists users without auth", async () => {
      const res = await app.inject({ method: "GET", url: "/users" });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data).toBeDefined();
      expect(body.data.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("GET /users/:id (public)", () => {
    it("gets a user by ID without auth", async () => {
      const user = await UserModel.findOne({ email: "admin@test.com" }).lean();
      const res = await app.inject({ method: "GET", url: `/users/${user!._id}` });
      expect(res.statusCode).toBe(200);
      expect(res.json().email).toBe("admin@test.com");
    });

    it("returns 404 for nonexistent ID", async () => {
      const fakeId = "000000000000000000000000";
      const res = await app.inject({ method: "GET", url: `/users/${fakeId}` });
      expect(res.statusCode).toBe(404);
    });
  });

  // ── Admin Write ──────────────────────────────────────────────

  describe("POST /users (admin only)", () => {
    it("creates a user as admin", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/users",
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { name: "New User", email: "new@test.com", role: "editor" },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().name).toBe("New User");
    });

    it("rejects creation without auth", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/users",
        payload: { name: "Anon", email: "anon@test.com" },
      });
      expect(res.statusCode).toBe(401);
    });

    it("rejects creation as viewer", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/users",
        headers: { authorization: `Bearer ${viewerToken}` },
        payload: { name: "Denied", email: "denied@test.com" },
      });
      expect(res.statusCode).toBe(403);
    });

    it("validates required fields", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/users",
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { bio: "missing name and email" },
      });
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
    });
  });

  describe("PATCH /users/:id (admin only)", () => {
    it("updates a user as admin", async () => {
      const user = await UserModel.create({ name: "Updatable", email: "upd@test.com" });
      const res = await app.inject({
        method: "PATCH",
        url: `/users/${user._id}`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { name: "Updated" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().name).toBe("Updated");
    });
  });

  describe("DELETE /users/:id (admin only)", () => {
    it("deletes a user as admin", async () => {
      const user = await UserModel.create({ name: "Deletable", email: "del@test.com" });
      const res = await app.inject({
        method: "DELETE",
        url: `/users/${user._id}`,
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().message).toBeDefined();
    });
  });

  // ── Hooks ────────────────────────────────────────────────────

  describe("hooks", () => {
    it("normalizes email to lowercase on create", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/users",
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { name: "Mixed Case", email: "MixedCase@Test.COM" },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().email).toBe("mixedcase@test.com");
    });
  });
});
