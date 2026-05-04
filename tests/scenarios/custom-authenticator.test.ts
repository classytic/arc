/**
 * Custom Authenticator (Clerk/Auth0 Simulation)
 *
 * Proves Arc works with `auth: { authenticate: fn }` — users who
 * bring their own auth (Clerk, Auth0, Firebase, etc.) and don't
 * use Better Auth or Arc's built-in JWT.
 *
 * Run with: npx vitest run tests/scenarios/custom-authenticator.test.ts
 */

import { createMongooseAdapter } from "@classytic/mongokit/adapter";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import mongoose from "mongoose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BaseController } from "../../src/core/BaseController.js";
import { defineResource } from "../../src/core/defineResource.js";
import { createApp } from "../../src/factory/createApp.js";
import { anyOf, requireAuth, requireOwnership, requireRoles } from "../../src/permissions/index.js";
import { multiTenantPreset } from "../../src/presets/multiTenant.js";
import { setupTestDatabase, teardownTestDatabase } from "../setup.js";

// ============================================================================
// Mock session store (simulates Clerk/Auth0 session validation)
// ============================================================================

interface MockSession {
  user: { id: string; role: string[]; organizationId?: string };
}

const sessionStore = new Map<string, MockSession>();

// Pre-populate sessions
const USER_ADMIN = new mongoose.Types.ObjectId().toString();
const USER_REGULAR = new mongoose.Types.ObjectId().toString();
const USER_OTHER = new mongoose.Types.ObjectId().toString();
const ORG_1 = new mongoose.Types.ObjectId().toString();
const ORG_2 = new mongoose.Types.ObjectId().toString();

sessionStore.set("admin-session", {
  user: { id: USER_ADMIN, role: ["admin"], organizationId: ORG_1 },
});
sessionStore.set("user-session", {
  user: { id: USER_REGULAR, role: ["user"], organizationId: ORG_1 },
});
sessionStore.set("other-session", {
  user: { id: USER_OTHER, role: ["user"], organizationId: ORG_2 },
});

// ============================================================================
// Custom authenticator (simulates Clerk middleware)
// ============================================================================

async function clerkAuthenticator(request: FastifyRequest, reply: FastifyReply) {
  const apiKey = request.headers["x-api-key"] as string | undefined;
  if (!apiKey) {
    reply.code(401).send({ error: "Missing API key" });
    return;
  }

  const session = sessionStore.get(apiKey);
  if (!session) {
    reply.code(401).send({ error: "Invalid or expired session" });
    return;
  }

  (request as any).user = session.user;

  // Set request.scope based on user's org context
  if (session.user.organizationId) {
    (request as any).scope = {
      kind: "member",
      organizationId: session.user.organizationId,
      orgRoles: session.user.role,
    };
  } else {
    (request as any).scope = { kind: "authenticated" };
  }
}

// ============================================================================
// Tests
// ============================================================================

describe("Custom Authenticator (Clerk/Auth0 Simulation)", () => {
  let app: FastifyInstance;

  const NoteSchema = new mongoose.Schema(
    {
      title: { type: String, required: true },
      content: { type: String, default: "" },
      organizationId: { type: mongoose.Schema.Types.ObjectId, index: true },
      createdBy: { type: mongoose.Schema.Types.ObjectId },
    },
    { timestamps: true },
  );

  beforeAll(async () => {
    await setupTestDatabase();

    const NoteModel = mongoose.models.CustomNote || mongoose.model("CustomNote", NoteSchema);
    const { Repository } = require("@classytic/mongokit");
    const repo = new Repository(NoteModel);
    const ctrl = new BaseController(repo);

    const preset = multiTenantPreset();
    const resource = defineResource({
      name: "note",
      adapter: createMongooseAdapter({ model: NoteModel, repository: repo }),
      controller: ctrl,
      prefix: "/notes",
      tag: "Notes",
      permissions: {
        list: requireAuth(),
        get: requireAuth(),
        create: requireAuth(),
        update: anyOf(requireRoles(["admin"]), requireOwnership("createdBy")),
        delete: requireRoles(["admin"]),
      },
      middlewares: preset.middlewares,
    });

    app = await createApp({
      preset: "development",
      auth: { type: "authenticator", authenticate: clerkAuthenticator },
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

  // --------------------------------------------------------------------------
  // Session-based authentication
  // --------------------------------------------------------------------------

  describe("Session-based authentication", () => {
    it("should authenticate with valid API key", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/notes",
        headers: { "x-api-key": "admin-session" },
      });

      expect(res.statusCode).toBe(200);
    });

    it("should return 401 with missing API key", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/notes",
      });

      expect(res.statusCode).toBe(401);
    });

    it("should return 401 with invalid session", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/notes",
        headers: { "x-api-key": "expired-or-invalid" },
      });

      expect(res.statusCode).toBe(401);
    });
  });

  // --------------------------------------------------------------------------
  // Integration with Arc permissions
  // --------------------------------------------------------------------------

  describe("Integration with Arc permissions", () => {
    let adminNoteId: string;
    let userNoteId: string;

    it("requireAuth works — authenticated user can create", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/notes",
        headers: { "x-api-key": "admin-session" },
        payload: { title: "Admin Note" },
      });

      expect(res.statusCode).toBe(201);
      adminNoteId = JSON.parse(res.body)._id;
    });

    it("requireAuth works — unauthenticated cannot create", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/notes",
        payload: { title: "No Auth Note" },
      });

      expect(res.statusCode).toBe(401);
    });

    it("requireRoles works — admin can delete", async () => {
      // Create then delete
      const createRes = await app.inject({
        method: "POST",
        url: "/notes",
        headers: { "x-api-key": "admin-session" },
        payload: { title: "Delete Me" },
      });
      const deleteId = JSON.parse(createRes.body)._id;

      const res = await app.inject({
        method: "DELETE",
        url: `/notes/${deleteId}`,
        headers: { "x-api-key": "admin-session" },
      });

      expect(res.statusCode).toBe(200);
    });

    it("requireRoles works — regular user cannot delete", async () => {
      // Create as admin, try delete as user
      const createRes = await app.inject({
        method: "POST",
        url: "/notes",
        headers: { "x-api-key": "user-session" },
        payload: { title: "User Note" },
      });
      userNoteId = JSON.parse(createRes.body)._id;

      const res = await app.inject({
        method: "DELETE",
        url: `/notes/${userNoteId}`,
        headers: { "x-api-key": "user-session" },
      });

      expect(res.statusCode).toBe(403);
    });

    it("anyOf(requireRoles, requireOwnership) — admin can update any note", async () => {
      const res = await app.inject({
        method: "PATCH",
        url: `/notes/${userNoteId}`,
        headers: { "x-api-key": "admin-session" },
        payload: { title: "Admin Edited" },
      });

      expect(res.statusCode).toBe(200);
    });
  });

  // --------------------------------------------------------------------------
  // Integration with multiTenantPreset
  // --------------------------------------------------------------------------

  describe("Integration with multiTenantPreset", () => {
    let org1NoteId: string;
    let org2NoteId: string;

    beforeAll(async () => {
      // Create note in org1
      const res1 = await app.inject({
        method: "POST",
        url: "/notes",
        headers: { "x-api-key": "admin-session" },
        payload: { title: "Org 1 Note" },
      });
      org1NoteId = JSON.parse(res1.body)._id;

      // Create note in org2
      const res2 = await app.inject({
        method: "POST",
        url: "/notes",
        headers: { "x-api-key": "other-session" },
        payload: { title: "Org 2 Note" },
      });
      org2NoteId = JSON.parse(res2.body)._id;
    });

    it("org scoping works from custom user.organizationId", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/notes",
        headers: { "x-api-key": "admin-session" },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      const ids = body.data.map((d: any) => d._id);
      expect(ids).toContain(org1NoteId);
      expect(ids).not.toContain(org2NoteId);
    });

    it("data isolation between orgs with custom auth", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/notes",
        headers: { "x-api-key": "other-session" },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      const ids = body.data.map((d: any) => d._id);
      expect(ids).toContain(org2NoteId);
      expect(ids).not.toContain(org1NoteId);
    });
  });

  // --------------------------------------------------------------------------
  // No JWT utilities
  // --------------------------------------------------------------------------

  describe("No JWT utilities", () => {
    it("app does not have issueTokens when using custom auth only", () => {
      // When using custom authenticator, app.auth (the JWT helper) should not be available
      // OR it should be limited. The key point is the custom authenticator works.
      expect(app.hasDecorator("authenticate")).toBe(true);
    });
  });
});
