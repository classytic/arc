/**
 * Bulk preset + custom idField + multi-tenancy
 *
 * Verifies:
 *   1. bulkCreate works for resources with custom idField
 *   2. bulkUpdate by custom field filter works
 *   3. bulkDelete by custom field filter works
 *   4. SECURITY: bulk operations enforce org scope (a user in Org A cannot
 *      bulk-update / bulk-delete Org B's documents)
 *
 * Bulk operates by filter, not by ID, so the idField question reduces to
 * "does the filter shape work with custom fields?" The answer should be yes
 * (filter is opaque). The security question is harder — bulk filters come
 * from the request body and must be merged with org scope on the server.
 */

import {
  batchOperationsPlugin,
  methodRegistryPlugin,
  mongoOperationsPlugin,
  Repository,
  softDeletePlugin,
} from "@classytic/mongokit";
import { createMongooseAdapter } from "@classytic/mongokit/adapter";
import type { FastifyRequest } from "fastify";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { type Model, Schema } from "mongoose";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { BaseController } from "../../src/core/BaseController.js";
import { defineResource } from "../../src/core/defineResource.js";
import { createApp } from "../../src/factory/createApp.js";
import { requireAuth } from "../../src/permissions/index.js";
import { multiTenantPreset } from "../../src/presets/multiTenant.js";
import type { RequestScope } from "../../src/scope/types.js";

const JWT_SECRET = "test-jwt-secret-must-be-at-least-32-chars-long!!";
const ORG_A = new mongoose.Types.ObjectId().toString();
const ORG_B = new mongoose.Types.ObjectId().toString();
const USER_A = new mongoose.Types.ObjectId().toString();
const USER_B = new mongoose.Types.ObjectId().toString();

interface IItem {
  sku: string;
  name: string;
  price: number;
  status: string;
  organizationId: mongoose.Types.ObjectId;
}

const ItemSchema = new Schema<IItem>(
  {
    sku: { type: String, required: true, index: true },
    name: { type: String, required: true },
    price: { type: Number, required: true },
    status: { type: String, default: "active" },
    organizationId: { type: Schema.Types.ObjectId, required: true, index: true },
    deletedAt: { type: Date, default: null, index: true },
  },
  { timestamps: true },
);
ItemSchema.index(
  { sku: 1, organizationId: 1 },
  { unique: true, partialFilterExpression: { deletedAt: null } },
);

let mongoServer: MongoMemoryServer;
let ItemModel: Model<IItem>;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  ItemModel = mongoose.models.BulkSkuItem || mongoose.model<IItem>("BulkSkuItem", ItemSchema);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

afterEach(async () => {
  await ItemModel.deleteMany({});
});

function scopeAwareAuth() {
  return async (
    request: FastifyRequest,
    { jwt }: { jwt: { verify: <T>(token: string) => T } | null },
  ): Promise<Record<string, unknown> | null> => {
    if (!jwt) return null;
    const auth = request.headers.authorization;
    if (!auth?.startsWith("Bearer ")) return null;
    const decoded = jwt.verify<Record<string, unknown>>(auth.slice(7));
    const orgId = decoded.organizationId as string | undefined;
    if (orgId) {
      // biome-ignore lint: test
      (request as any).scope = {
        kind: "member",
        organizationId: orgId,
        orgRoles: (decoded.role as string[]) ?? [],
      } satisfies RequestScope;
    }
    return decoded;
  };
}

async function buildApp(opts: { withSoftDelete?: boolean } = {}) {
  const plugins = [
    methodRegistryPlugin(),
    batchOperationsPlugin(),
    ...(opts.withSoftDelete
      ? [softDeletePlugin({ deletedField: "deletedAt", filterMode: "null" })]
      : []),
    mongoOperationsPlugin(),
  ];
  const repo = new Repository<IItem>(ItemModel, plugins);

  const resource = defineResource<IItem>({
    name: "item",
    // biome-ignore lint: generic
    adapter: createMongooseAdapter({ model: ItemModel, repository: repo }),
    idField: "sku",
    presets: ["bulk"],
    middlewares: multiTenantPreset().middlewares,
    schemaOptions: {
      fieldRules: {
        organizationId: { systemManaged: true },
      },
    },
    controller: new BaseController(repo, {
      resourceName: "item",
      idField: "sku",
    }),
    permissions: {
      list: requireAuth(),
      get: requireAuth(),
      create: requireAuth(),
      update: requireAuth(),
      delete: requireAuth(),
    },
  });

  const app = await createApp({
    preset: "development",
    auth: {
      type: "jwt",
      jwt: { secret: JWT_SECRET },
      authenticate: scopeAwareAuth(),
    },
    logger: false,
    helmet: false,
    rateLimit: false,
    plugins: async (fastify) => {
      await fastify.register(resource.toPlugin());
    },
  });
  await app.ready();
  return app;
}

describe("Bulk preset + custom idField + multi-tenancy", () => {
  function tokens(app: {
    auth: { issueTokens(p: Record<string, unknown>): { accessToken: string } };
  }) {
    return {
      tokenA: app.auth.issueTokens({ id: USER_A, role: ["user"], organizationId: ORG_A })
        .accessToken,
      tokenB: app.auth.issueTokens({ id: USER_B, role: ["user"], organizationId: ORG_B })
        .accessToken,
    };
  }

  it("bulkCreate creates items with org-injected organizationId", async () => {
    const app = await buildApp();
    try {
      // biome-ignore lint: app decorator
      const { tokenA } = tokens(app as any);

      const res = await app.inject({
        method: "POST",
        url: "/items/bulk",
        headers: { authorization: `Bearer ${tokenA}` },
        payload: {
          items: [
            { sku: "BULK-001", name: "Item 1", price: 10 },
            { sku: "BULK-002", name: "Item 2", price: 20 },
            { sku: "BULK-003", name: "Item 3", price: 30 },
          ],
        },
      });
      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      // bulkCreate emits the inserted docs as a bare array at the top level
      // (single-doc path through fastifyAdapter — response.data is the array).
      expect(Array.isArray(body) ? body.length : body.data?.length).toBe(3);

      // All items should have org A's organizationId
      const data = await ItemModel.find({}).lean();
      expect(data.length).toBe(3);
      for (const doc of data) {
        expect(String(doc.organizationId)).toBe(ORG_A);
      }
    } finally {
      await app.close();
    }
  });

  it("bulkUpdate by sku filter only updates current org's items", async () => {
    const app = await buildApp();
    try {
      // biome-ignore lint: app decorator
      const { tokenA, tokenB } = tokens(app as any);

      // Org A creates items
      await app.inject({
        method: "POST",
        url: "/items/bulk",
        headers: { authorization: `Bearer ${tokenA}` },
        payload: {
          items: [
            { sku: "SHARED-001", name: "A's Shared", price: 100, status: "active" },
            { sku: "ONLY-A", name: "Only A", price: 200, status: "active" },
          ],
        },
      });

      // Org B creates an item with the SAME sku
      await app.inject({
        method: "POST",
        url: "/items/bulk",
        headers: { authorization: `Bearer ${tokenB}` },
        payload: {
          items: [{ sku: "SHARED-001", name: "B's Shared", price: 999, status: "active" }],
        },
      });

      // Org A bulkUpdates by status filter — should NOT touch Org B's data
      const updateRes = await app.inject({
        method: "PATCH",
        url: "/items/bulk",
        headers: { authorization: `Bearer ${tokenA}` },
        payload: {
          filter: { status: "active" },
          data: { status: "inactive" },
        },
      });
      expect(updateRes.statusCode).toBe(200);

      // Org A's docs should be inactive
      const orgADocs = await ItemModel.find({
        organizationId: new mongoose.Types.ObjectId(ORG_A),
      }).lean();
      for (const doc of orgADocs) {
        expect(doc.status).toBe("inactive");
      }

      // Org B's doc should STILL be active — this is the security check
      const orgBDocs = await ItemModel.find({
        organizationId: new mongoose.Types.ObjectId(ORG_B),
      }).lean();
      expect(orgBDocs.length).toBe(1);
      expect(orgBDocs[0]?.status).toBe("active");
    } finally {
      await app.close();
    }
  });

  it("bulkDelete only deletes current org's items", async () => {
    const app = await buildApp();
    try {
      // biome-ignore lint: app decorator
      const { tokenA, tokenB } = tokens(app as any);

      await app.inject({
        method: "POST",
        url: "/items/bulk",
        headers: { authorization: `Bearer ${tokenA}` },
        payload: {
          items: [
            { sku: "DEL-1", name: "A1", price: 1, status: "draft" },
            { sku: "DEL-2", name: "A2", price: 2, status: "draft" },
          ],
        },
      });
      await app.inject({
        method: "POST",
        url: "/items/bulk",
        headers: { authorization: `Bearer ${tokenB}` },
        payload: {
          items: [{ sku: "B-DEL", name: "B1", price: 5, status: "draft" }],
        },
      });

      // Org A bulkDeletes by status — should NOT delete Org B's draft item
      const delRes = await app.inject({
        method: "DELETE",
        url: "/items/bulk",
        headers: { authorization: `Bearer ${tokenA}` },
        payload: {
          filter: { status: "draft" },
        },
      });
      expect(delRes.statusCode).toBe(200);

      // Org A items gone (hard delete)
      const remainingA = await ItemModel.find({
        organizationId: new mongoose.Types.ObjectId(ORG_A),
      });
      expect(remainingA.length).toBe(0);

      // Org B item STILL present (security check)
      const remainingB = await ItemModel.find({
        organizationId: new mongoose.Types.ObjectId(ORG_B),
      });
      expect(remainingB.length).toBe(1);
      expect(remainingB[0]?.sku).toBe("B-DEL");
    } finally {
      await app.close();
    }
  });

  it("bulkUpdate by custom sku filter works (idField is just a filter key)", async () => {
    const app = await buildApp();
    try {
      // biome-ignore lint: app decorator
      const { tokenA } = tokens(app as any);

      await app.inject({
        method: "POST",
        url: "/items/bulk",
        headers: { authorization: `Bearer ${tokenA}` },
        payload: {
          items: [
            { sku: "WIDGET-001", name: "W1", price: 50, status: "active" },
            { sku: "WIDGET-002", name: "W2", price: 50, status: "active" },
            { sku: "GADGET-001", name: "G1", price: 100, status: "active" },
          ],
        },
      });

      // Update by custom field filter (sku starts with WIDGET)
      const res = await app.inject({
        method: "PATCH",
        url: "/items/bulk",
        headers: { authorization: `Bearer ${tokenA}` },
        payload: {
          filter: { sku: { $regex: "^WIDGET" } },
          data: { price: 75 },
        },
      });
      expect(res.statusCode).toBe(200);

      const widgets = await ItemModel.find({ sku: { $regex: "^WIDGET" } });
      for (const w of widgets) {
        expect(w.price).toBe(75);
      }
      const gadget = await ItemModel.findOne({ sku: "GADGET-001" });
      expect(gadget?.price).toBe(100); // unchanged
    } finally {
      await app.close();
    }
  });

  it("bulkDelete + softDeletePlugin: org A's draft items soft-deleted, org B's untouched", async () => {
    const app = await buildApp({ withSoftDelete: true });
    try {
      // biome-ignore lint: app decorator
      const { tokenA, tokenB } = tokens(app as any);

      await app.inject({
        method: "POST",
        url: "/items/bulk",
        headers: { authorization: `Bearer ${tokenA}` },
        payload: {
          items: [
            { sku: "SD-1", name: "A1", price: 1, status: "draft" },
            { sku: "SD-2", name: "A2", price: 2, status: "draft" },
            { sku: "SD-3", name: "A3", price: 3, status: "active" },
          ],
        },
      });
      await app.inject({
        method: "POST",
        url: "/items/bulk",
        headers: { authorization: `Bearer ${tokenB}` },
        payload: {
          items: [{ sku: "B-SD-1", name: "B1", price: 10, status: "draft" }],
        },
      });

      // Org A bulkDeletes by status — should soft-delete only Org A drafts
      const delRes = await app.inject({
        method: "DELETE",
        url: "/items/bulk",
        headers: { authorization: `Bearer ${tokenA}` },
        payload: { filter: { status: "draft" } },
      });
      expect(delRes.statusCode).toBe(200);
      // Note: deletedCount from MongoKit reflects HARD-deletes; with softDeletePlugin
      // active, the actual update happens but the count is 0. Verify by querying DB.

      // Org A drafts soft-deleted (deletedAt set)
      const orgADocs = await ItemModel.find({
        organizationId: new mongoose.Types.ObjectId(ORG_A),
      }).lean();
      const orgASoftDeleted = orgADocs.filter((d) => d.deletedAt !== null);
      expect(orgASoftDeleted.length).toBe(2);
      // Org A active item NOT touched
      const orgAActive = orgADocs.filter((d) => d.deletedAt === null);
      expect(orgAActive.length).toBe(1);
      expect(orgAActive[0]?.status).toBe("active");

      // Org B's draft item NOT touched (security check)
      const orgBDocs = await ItemModel.find({
        organizationId: new mongoose.Types.ObjectId(ORG_B),
      }).lean();
      const orgBSoftDeleted = orgBDocs.filter((d) => d.deletedAt !== null);
      expect(orgBSoftDeleted.length).toBe(0);
    } finally {
      await app.close();
    }
  });
});
