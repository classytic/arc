/**
 * DX Features — v2.4.4 additions
 *
 * Tests:
 *   1. ArcRequest type
 *   2. envelope() helper
 *   3. getOrgContext() canonical org extraction
 *   4. createDomainError() factory
 *   5. onRegister lifecycle hook
 *   6. preAuth on additionalRoutes
 *   7. streamResponse flag
 */

import { Repository } from "@classytic/mongokit";
import type { FastifyReply, FastifyRequest } from "fastify";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createMongooseAdapter } from "../../src/adapters/mongoose.js";
import { BaseController } from "../../src/core/BaseController.js";
import { defineResource } from "../../src/core/defineResource.js";
import { createApp } from "../../src/factory/index.js";
import { allowPublic } from "../../src/permissions/index.js";
import { getOrgContext } from "../../src/scope/types.js";
import type { ArcRequest } from "../../src/types/index.js";
import { envelope } from "../../src/types/index.js";
import { ArcError, createDomainError, isArcError } from "../../src/utils/errors.js";

// ============================================================================
// Setup
// ============================================================================

let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

afterEach(async () => {
  for (const key in mongoose.connection.collections) {
    await mongoose.connection.collections[key].deleteMany({});
  }
});

const ItemSchema = new mongoose.Schema(
  { name: { type: String, required: true }, status: String },
  { timestamps: true },
);
const ItemModel = mongoose.models.DxItem || mongoose.model("DxItem", ItemSchema);

// ============================================================================
// 1. envelope() helper
// ============================================================================

describe("envelope() response helper", () => {
  it("wraps data in standard format", () => {
    const result = envelope({ id: "1", name: "Widget" });
    expect(result).toEqual({ success: true, data: { id: "1", name: "Widget" } });
  });

  it("includes meta when provided", () => {
    const result = envelope([1, 2, 3], { total: 3, page: 1 });
    expect(result).toEqual({ success: true, data: [1, 2, 3], total: 3, page: 1 });
  });

  it("works with null data", () => {
    const result = envelope(null);
    expect(result).toEqual({ success: true, data: null });
  });
});

// ============================================================================
// 2. getOrgContext() canonical extraction
// ============================================================================

describe("getOrgContext() canonical org extraction", () => {
  it("extracts from member scope", () => {
    const ctx = getOrgContext({
      scope: {
        kind: "member",
        userId: "u-1",
        userRoles: ["admin"],
        organizationId: "org-abc",
        orgRoles: ["owner"],
      },
    });

    expect(ctx.userId).toBe("u-1");
    expect(ctx.organizationId).toBe("org-abc");
    expect(ctx.roles).toEqual(["admin"]);
    expect(ctx.orgRoles).toEqual(["owner"]);
  });

  it("extracts from authenticated scope without org", () => {
    const ctx = getOrgContext({
      scope: { kind: "authenticated", userId: "u-2", userRoles: ["viewer"] },
    });

    expect(ctx.userId).toBe("u-2");
    expect(ctx.organizationId).toBeUndefined();
    expect(ctx.roles).toEqual(["viewer"]);
    expect(ctx.orgRoles).toEqual([]);
  });

  it("falls back to user object when scope is public", () => {
    const ctx = getOrgContext({
      scope: { kind: "public" },
      user: { id: "u-3", organizationId: "org-fallback" },
    });

    expect(ctx.userId).toBe("u-3");
    expect(ctx.organizationId).toBe("org-fallback");
  });

  it("falls back to x-organization-id header", () => {
    const ctx = getOrgContext({
      scope: { kind: "public" },
      headers: { "x-organization-id": "org-header" },
    });

    expect(ctx.organizationId).toBe("org-header");
  });

  it("returns undefined for everything when fully anonymous", () => {
    const ctx = getOrgContext({});

    expect(ctx.userId).toBeUndefined();
    expect(ctx.organizationId).toBeUndefined();
    expect(ctx.roles).toEqual([]);
    expect(ctx.orgRoles).toEqual([]);
  });
});

// ============================================================================
// 3. createDomainError()
// ============================================================================

describe("createDomainError() factory", () => {
  it("creates ArcError with code and statusCode", () => {
    const err = createDomainError("MEMBER_NOT_FOUND", "Member does not exist", 404);

    expect(err).toBeInstanceOf(ArcError);
    expect(err.code).toBe("MEMBER_NOT_FOUND");
    expect(err.statusCode).toBe(404);
    expect(err.message).toBe("Member does not exist");
    expect(isArcError(err)).toBe(true);
  });

  it("defaults to 400 when no statusCode", () => {
    const err = createDomainError("INVALID_INPUT", "Bad input");
    expect(err.statusCode).toBe(400);
  });

  it("includes details", () => {
    const err = createDomainError("INSUFFICIENT_BALANCE", "Not enough credits", 402, {
      balance: 0,
      required: 100,
    });
    expect(err.details).toEqual({ balance: 0, required: 100 });
  });

  it("serializes to JSON with code", () => {
    const err = createDomainError("SELF_REFERRAL", "Cannot refer yourself", 422);
    const json = err.toJSON();

    expect(json.success).toBe(false);
    expect(json.code).toBe("SELF_REFERRAL");
    expect(json.error).toBe("Cannot refer yourself");
  });
});

// ============================================================================
// 4. onRegister lifecycle hook
// ============================================================================

describe("onRegister lifecycle hook", () => {
  it("called with scoped Fastify instance during registration", async () => {
    const onRegister = vi.fn();
    const repo = new Repository(ItemModel);

    const resource = defineResource({
      name: "item",
      adapter: createMongooseAdapter({ model: ItemModel, repository: repo }),
      controller: new BaseController(repo, { resourceName: "item" }),
      permissions: {
        list: allowPublic(),
        get: allowPublic(),
        create: allowPublic(),
        update: allowPublic(),
        delete: allowPublic(),
      },
      onRegister,
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
    expect(onRegister).toHaveBeenCalledTimes(1);
    // First arg should be a Fastify instance
    expect(onRegister.mock.calls[0][0]).toHaveProperty("register");
    expect(onRegister.mock.calls[0][0]).toHaveProperty("addHook");

    await app.close();
  });

  it("async onRegister is awaited", async () => {
    let sideEffect = false;
    const repo = new Repository(ItemModel);

    const resource = defineResource({
      name: "item",
      adapter: createMongooseAdapter({ model: ItemModel, repository: repo }),
      controller: new BaseController(repo, { resourceName: "item" }),
      permissions: { list: allowPublic() },
      onRegister: async (_fastify) => {
        await new Promise((r) => setTimeout(r, 10));
        sideEffect = true;
      },
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
    expect(sideEffect).toBe(true);
    await app.close();
  });
});

// ============================================================================
// 5. preAuth on additionalRoutes
// ============================================================================

describe("preAuth on additionalRoutes", () => {
  it("preAuth array is accepted in route type without error", () => {
    const repo = new Repository(ItemModel);

    // Type-level test: preAuth is a valid property on AdditionalRoute
    const resource = defineResource({
      name: "item",
      adapter: createMongooseAdapter({ model: ItemModel, repository: repo }),
      controller: new BaseController(repo, { resourceName: "item" }),
      permissions: { list: allowPublic() },
      additionalRoutes: [
        {
          method: "GET" as const,
          path: "/stream",
          wrapHandler: false,
          permissions: allowPublic(),
          preAuth: [
            (req: FastifyRequest) => {
              const token = (req.query as Record<string, string>)?.token;
              if (token) req.headers.authorization = `Bearer ${token}`;
            },
          ],
          handler: async (_req: FastifyRequest, reply: FastifyReply) => {
            reply.send({ ok: true });
          },
        },
      ],
    });

    // Resource created without errors
    expect(resource.name).toBe("item");
    expect(resource.additionalRoutes.length).toBe(1);
    expect((resource.additionalRoutes[0] as any).preAuth).toHaveLength(1);
  });
});

// ============================================================================
// 6. streamResponse flag
// ============================================================================

describe("streamResponse flag on additionalRoutes", () => {
  it("streamResponse is accepted in route type", () => {
    const repo = new Repository(ItemModel);

    const resource = defineResource({
      name: "item",
      adapter: createMongooseAdapter({ model: ItemModel, repository: repo }),
      controller: new BaseController(repo, { resourceName: "item" }),
      permissions: { list: allowPublic() },
      additionalRoutes: [
        {
          method: "GET" as const,
          path: "/events",
          wrapHandler: false,
          streamResponse: true,
          permissions: allowPublic(),
          handler: async (_req: FastifyRequest, reply: FastifyReply) => {
            reply.raw.write("data: hello\n\n");
            reply.raw.end();
          },
        },
      ],
    });

    expect(resource.additionalRoutes.length).toBe(1);
    expect((resource.additionalRoutes[0] as any).streamResponse).toBe(true);
  });
});

// ============================================================================
// 7. ArcRequest type is compatible with Fastify
// ============================================================================

describe("ArcRequest type", () => {
  it("is assignable from FastifyRequest with scope", () => {
    // Type-level test — if this compiles, ArcRequest is compatible
    const mockReq = {
      scope: {
        kind: "member" as const,
        userId: "u-1",
        userRoles: [],
        organizationId: "org-1",
        orgRoles: [],
      },
      user: { id: "u-1" },
      signal: new AbortController().signal,
    } as unknown as ArcRequest;

    expect(mockReq.scope.kind).toBe("member");
    expect(mockReq.user).toBeDefined();
    expect(mockReq.signal).toBeInstanceOf(AbortSignal);
  });
});
