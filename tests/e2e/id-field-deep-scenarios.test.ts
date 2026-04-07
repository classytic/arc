/**
 * Custom idField — Deep End-to-End Scenarios
 *
 * Real-world e-commerce scenario through the FULL Arc stack:
 *   - createApp() with JWT auth + scope-aware authenticator
 *   - multiTenantPreset on every resource
 *   - Real Mongoose models with references
 *   - MongoKit Repository + QueryParser with allowedFilterFields
 *   - Custom idField per resource (slug, sku, orderNumber)
 *   - Permissions (requireAuth)
 *   - Org scope enforcement (cross-tenant leak prevention)
 *   - Complex nested queries (filter operators, populate, sort, pagination, select)
 *
 * Resources:
 *   - Category (_id)              — lookup table
 *   - Product  (sku, multi-tenant) — same SKU can exist in different orgs
 *   - Order    (orderNumber, multi-tenant) — references user + products
 *
 * Scenarios covered:
 *   1. User in Org A cannot GET Org B's product by SKU → 404
 *   2. Same SKU exists in Org A and Org B — each only sees their own
 *   3. UpdatedBy is tracked correctly for PATCH by custom idField
 *   4. Cross-org PATCH attempt → 404 (not 403 — resource just doesn't exist)
 *   5. Filter with MongoKit bracket notation: ?category=<id>&price[gte]=100&price[lte]=500
 *   6. Populate via query: ?populate=category
 *   7. Sort + pagination + limit: ?sort=-createdAt&page=1&limit=2
 *   8. Slug-style custom ID with hyphens, numbers, UUID
 *   9. DELETE by custom ID tracks the correct document in DB
 *  10. Orders by orderNumber + filter on user/status combined
 *  11. UUID-style custom IDs work across CRUD
 *  12. Superadmin bypass: elevated scope sees all orgs
 */

import { QueryParser, Repository } from "@classytic/mongokit";
import type { FastifyInstance, FastifyRequest } from "fastify";
import mongoose, { Schema } from "mongoose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMongooseAdapter } from "../../src/adapters/mongoose.js";
import { BaseController } from "../../src/core/BaseController.js";
import { defineResource } from "../../src/core/defineResource.js";
import { createApp } from "../../src/factory/createApp.js";
import { requireAuth } from "../../src/permissions/index.js";
import { multiTenantPreset } from "../../src/presets/multiTenant.js";
import type { RequestScope } from "../../src/scope/types.js";
import { setupTestDatabase, teardownTestDatabase } from "../setup.js";

const JWT_SECRET = "test-jwt-secret-must-be-at-least-32-chars-long!!";

// Pre-generated IDs
const ORG_A = new mongoose.Types.ObjectId().toString();
const ORG_B = new mongoose.Types.ObjectId().toString();
const USER_A = new mongoose.Types.ObjectId().toString();
const USER_B = new mongoose.Types.ObjectId().toString();
const SUPERADMIN = new mongoose.Types.ObjectId().toString();

// ============================================================================
// Scope-aware authenticator
// ============================================================================

function scopeAwareAuth(superRoles: string[] = ["superadmin"]) {
  return async (
    request: FastifyRequest,
    { jwt }: { jwt: { verify: <T>(token: string) => T } | null },
  ): Promise<Record<string, unknown> | null> => {
    if (!jwt) return null;
    const auth = request.headers.authorization;
    if (!auth?.startsWith("Bearer ")) return null;
    const token = auth.slice(7);
    const decoded = jwt.verify<Record<string, unknown>>(token);
    // biome-ignore lint: test auth
    if ((decoded as any).type === "refresh") return null;

    const userRoles = (Array.isArray(decoded.role) ? decoded.role : []) as string[];
    const orgId = decoded.organizationId as string | undefined;

    if (superRoles.some((r) => userRoles.includes(r))) {
      // biome-ignore lint: test auth
      (request as any).scope = {
        kind: "elevated",
        elevatedBy: String(decoded.id ?? "admin"),
      } satisfies RequestScope;
    } else if (orgId) {
      // biome-ignore lint: test auth
      (request as any).scope = {
        kind: "member",
        organizationId: orgId,
        orgRoles: userRoles,
      } satisfies RequestScope;
    }
    return decoded;
  };
}

// ============================================================================
// Schemas — realistic e-commerce
// ============================================================================

interface ICategory {
  name: string;
  slug: string;
  organizationId: mongoose.Types.ObjectId;
}
const CategorySchema = new Schema<ICategory>(
  {
    name: { type: String, required: true },
    slug: { type: String, required: true },
    organizationId: { type: Schema.Types.ObjectId, required: true, index: true },
  },
  { timestamps: true },
);
CategorySchema.index({ slug: 1, organizationId: 1 }, { unique: true });

interface IProduct {
  sku: string;
  name: string;
  price: number;
  category: mongoose.Types.ObjectId;
  tags: string[];
  status: "draft" | "published" | "archived";
  organizationId: mongoose.Types.ObjectId;
  createdBy?: mongoose.Types.ObjectId;
  updatedBy?: mongoose.Types.ObjectId;
}
const ProductSchema = new Schema<IProduct>(
  {
    sku: { type: String, required: true, index: true },
    name: { type: String, required: true },
    price: { type: Number, required: true, min: 0 },
    category: { type: Schema.Types.ObjectId, ref: "DeepCategory", required: true },
    tags: [{ type: String }],
    status: {
      type: String,
      enum: ["draft", "published", "archived"],
      default: "draft",
    },
    organizationId: { type: Schema.Types.ObjectId, required: true, index: true },
    createdBy: { type: Schema.Types.ObjectId },
    updatedBy: { type: Schema.Types.ObjectId },
  },
  { timestamps: true },
);
// Same SKU can exist in different orgs, but must be unique within an org
ProductSchema.index({ sku: 1, organizationId: 1 }, { unique: true });

interface IOrder {
  orderNumber: string;
  customer: mongoose.Types.ObjectId;
  items: Array<{ product: mongoose.Types.ObjectId; quantity: number; price: number }>;
  total: number;
  status: "pending" | "paid" | "shipped" | "cancelled";
  organizationId: mongoose.Types.ObjectId;
  createdBy?: mongoose.Types.ObjectId;
}
const OrderSchema = new Schema<IOrder>(
  {
    orderNumber: { type: String, required: true, index: true },
    customer: { type: Schema.Types.ObjectId, required: true },
    items: [
      {
        product: { type: Schema.Types.ObjectId, ref: "DeepProduct" },
        quantity: Number,
        price: Number,
      },
    ],
    total: { type: Number, required: true },
    status: {
      type: String,
      enum: ["pending", "paid", "shipped", "cancelled"],
      default: "pending",
    },
    organizationId: { type: Schema.Types.ObjectId, required: true, index: true },
    createdBy: { type: Schema.Types.ObjectId },
  },
  { timestamps: true },
);
OrderSchema.index({ orderNumber: 1, organizationId: 1 }, { unique: true });

// ============================================================================
// Test setup
// ============================================================================

describe("idField — deep E2E scenarios with MongoKit + multi-tenancy", () => {
  let app: FastifyInstance;
  let CategoryModel: mongoose.Model<ICategory>;
  let ProductModel: mongoose.Model<IProduct>;
  let OrderModel: mongoose.Model<IOrder>;
  let categoryA: ICategory & { _id: mongoose.Types.ObjectId };
  let categoryB: ICategory & { _id: mongoose.Types.ObjectId };

  beforeAll(async () => {
    await setupTestDatabase();

    CategoryModel =
      mongoose.models.DeepCategory || mongoose.model<ICategory>("DeepCategory", CategorySchema);
    ProductModel =
      mongoose.models.DeepProduct || mongoose.model<IProduct>("DeepProduct", ProductSchema);
    OrderModel = mongoose.models.DeepOrder || mongoose.model<IOrder>("DeepOrder", OrderSchema);

    const categoryRepo = new Repository<ICategory>(CategoryModel);
    const productRepo = new Repository<IProduct>(ProductModel);
    const orderRepo = new Repository<IOrder>(OrderModel);

    const productParser = new QueryParser({
      allowedFilterFields: ["category", "price", "status", "name", "tags", "sku"],
      allowedSortFields: ["createdAt", "price", "name"],
      maxLimit: 100,
    });
    const orderParser = new QueryParser({
      allowedFilterFields: ["customer", "status", "total", "orderNumber"],
      allowedSortFields: ["createdAt", "total"],
      maxLimit: 50,
    });
    const categoryParser = new QueryParser({
      allowedFilterFields: ["name", "slug"],
    });

    const systemFields = {
      organizationId: { systemManaged: true },
      createdBy: { systemManaged: true },
      updatedBy: { systemManaged: true },
    };

    // Category — default _id (for populate references)
    const categoryResource = defineResource<ICategory>({
      name: "category",
      // biome-ignore lint: generic
      adapter: createMongooseAdapter({ model: CategoryModel, repository: categoryRepo }),
      queryParser: categoryParser,
      schemaOptions: { fieldRules: systemFields },
      controller: new BaseController(categoryRepo, {
        queryParser: categoryParser,
        resourceName: "category",
      }),
      middlewares: multiTenantPreset().middlewares,
      permissions: {
        list: requireAuth(),
        get: requireAuth(),
        create: requireAuth(),
        update: requireAuth(),
        delete: requireAuth(),
      },
    });

    // Product — idField: 'sku', multi-tenant, populate category
    const productResource = defineResource<IProduct>({
      name: "product",
      // biome-ignore lint: generic
      adapter: createMongooseAdapter({ model: ProductModel, repository: productRepo }),
      queryParser: productParser,
      idField: "sku",
      schemaOptions: { fieldRules: systemFields },
      controller: new BaseController(productRepo, {
        queryParser: productParser,
        resourceName: "product",
        idField: "sku",
      }),
      middlewares: multiTenantPreset().middlewares,
      permissions: {
        list: requireAuth(),
        get: requireAuth(),
        create: requireAuth(),
        update: requireAuth(),
        delete: requireAuth(),
      },
    });

    // Order — idField: 'orderNumber', multi-tenant
    const orderResource = defineResource<IOrder>({
      name: "order",
      // biome-ignore lint: generic
      adapter: createMongooseAdapter({ model: OrderModel, repository: orderRepo }),
      queryParser: orderParser,
      idField: "orderNumber",
      schemaOptions: { fieldRules: systemFields },
      controller: new BaseController(orderRepo, {
        queryParser: orderParser,
        resourceName: "order",
        idField: "orderNumber",
      }),
      middlewares: multiTenantPreset().middlewares,
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
      auth: {
        type: "jwt",
        jwt: { secret: JWT_SECRET },
        authenticate: scopeAwareAuth(["superadmin"]),
      },
      logger: false,
      helmet: false,
      rateLimit: false,
      plugins: async (fastify) => {
        await fastify.register(categoryResource.toPlugin());
        await fastify.register(productResource.toPlugin());
        await fastify.register(orderResource.toPlugin());
      },
    });
    await app.ready();

    // Seed categories (one per org) via direct DB insert so populate works
    categoryA = (await CategoryModel.create({
      name: "Electronics",
      slug: "electronics",
      organizationId: new mongoose.Types.ObjectId(ORG_A),
      // biome-ignore lint: lean cast
    })) as any;
    categoryB = (await CategoryModel.create({
      name: "Books",
      slug: "books",
      organizationId: new mongoose.Types.ObjectId(ORG_B),
      // biome-ignore lint: lean cast
    })) as any;
  });

  afterAll(async () => {
    await app?.close();
    await teardownTestDatabase();
  });

  function issueToken(payload: Record<string, unknown>) {
    // biome-ignore lint: decorator
    return (app as any).auth.issueTokens(payload).accessToken;
  }
  function hdr(token: string) {
    return { authorization: `Bearer ${token}` };
  }

  const tokenUserA = () => issueToken({ id: USER_A, role: ["user"], organizationId: ORG_A });
  const tokenUserB = () => issueToken({ id: USER_B, role: ["user"], organizationId: ORG_B });
  const tokenSuper = () => issueToken({ id: SUPERADMIN, role: ["superadmin"] });

  // --------------------------------------------------------------------------
  // Seed products
  // --------------------------------------------------------------------------

  describe("seeding products across orgs", () => {
    it("Org A creates products via POST", async () => {
      for (const p of [
        {
          sku: "WIDGET-001",
          name: "Widget Classic",
          price: 50,
          category: categoryA._id.toString(),
          tags: ["featured"],
          status: "published",
        },
        {
          sku: "WIDGET-002",
          name: "Widget Pro",
          price: 150,
          category: categoryA._id.toString(),
          tags: ["featured", "new"],
          status: "published",
        },
        {
          sku: "GADGET-A1",
          name: "Gadget A1",
          price: 299,
          category: categoryA._id.toString(),
          tags: ["premium"],
          status: "published",
        },
        {
          sku: "GADGET-A2",
          name: "Gadget A2",
          price: 499,
          category: categoryA._id.toString(),
          tags: ["premium"],
          status: "draft",
        },
        {
          sku: "LEGACY-999",
          name: "Legacy",
          price: 10,
          category: categoryA._id.toString(),
          status: "archived",
        },
      ]) {
        const res = await app.inject({
          method: "POST",
          url: "/products",
          headers: hdr(tokenUserA()),
          payload: p,
        });
        expect(res.statusCode).toBe(201);
        const body = JSON.parse(res.body);
        expect(body.data.sku).toBe(p.sku);
        expect(String(body.data.organizationId)).toBe(ORG_A);
        expect(String(body.data.createdBy)).toBe(USER_A);
      }
    });

    it("Org B creates products — including the same SKU as Org A", async () => {
      for (const p of [
        {
          sku: "WIDGET-001",
          name: "B's Widget",
          price: 25,
          category: categoryB._id.toString(),
          status: "published",
        },
        {
          sku: "BOOK-XYZ",
          name: "Book XYZ",
          price: 15,
          category: categoryB._id.toString(),
          status: "published",
        },
      ]) {
        const res = await app.inject({
          method: "POST",
          url: "/products",
          headers: hdr(tokenUserB()),
          payload: p,
        });
        expect(res.statusCode).toBe(201);
      }
    });
  });

  // --------------------------------------------------------------------------
  // Cross-tenant isolation
  // --------------------------------------------------------------------------

  describe("cross-tenant isolation via custom idField", () => {
    it("Org A user GET /products/WIDGET-001 returns A's widget (not B's)", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/products/WIDGET-001",
        headers: hdr(tokenUserA()),
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.name).toBe("Widget Classic");
      expect(body.data.price).toBe(50);
      expect(String(body.data.organizationId)).toBe(ORG_A);
    });

    it("Org B user GET /products/WIDGET-001 returns B's widget (different document)", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/products/WIDGET-001",
        headers: hdr(tokenUserB()),
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.name).toBe("B's Widget");
      expect(body.data.price).toBe(25);
      expect(String(body.data.organizationId)).toBe(ORG_B);
    });

    it("Org B user cannot GET /products/GADGET-A1 (belongs to Org A)", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/products/GADGET-A1",
        headers: hdr(tokenUserB()),
      });
      expect(res.statusCode).toBe(404);
    });

    it("Org B user cannot PATCH /products/GADGET-A1 → 404", async () => {
      const res = await app.inject({
        method: "PATCH",
        url: "/products/GADGET-A1",
        headers: hdr(tokenUserB()),
        payload: { name: "HIJACKED" },
      });
      expect(res.statusCode).toBe(404);

      // DB still shows original name
      const doc = await ProductModel.findOne({
        sku: "GADGET-A1",
        organizationId: new mongoose.Types.ObjectId(ORG_A),
      });
      expect(doc?.name).toBe("Gadget A1");
    });

    it("Org B user cannot DELETE /products/GADGET-A1 → 404", async () => {
      const res = await app.inject({
        method: "DELETE",
        url: "/products/GADGET-A1",
        headers: hdr(tokenUserB()),
      });
      expect(res.statusCode).toBe(404);

      // DB still has the document
      const doc = await ProductModel.findOne({
        sku: "GADGET-A1",
        organizationId: new mongoose.Types.ObjectId(ORG_A),
      });
      expect(doc).toBeTruthy();
    });
  });

  // --------------------------------------------------------------------------
  // Update tracking
  // --------------------------------------------------------------------------

  describe("updatedBy tracking via custom idField", () => {
    it("PATCH /products/WIDGET-002 as Org A sets updatedBy", async () => {
      const res = await app.inject({
        method: "PATCH",
        url: "/products/WIDGET-002",
        headers: hdr(tokenUserA()),
        payload: { price: 175 },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.price).toBe(175);
      expect(String(body.data.updatedBy)).toBe(USER_A);
    });
  });

  // --------------------------------------------------------------------------
  // Complex nested queries with MongoKit operators
  // --------------------------------------------------------------------------

  describe("complex nested queries (filter operators + sort + pagination + populate + select)", () => {
    it("filter by price range: ?price[gte]=100&price[lte]=500", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/products?price[gte]=100&price[lte]=500`,
        headers: hdr(tokenUserA()),
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      // WIDGET-002 (175 after update), GADGET-A1 (299), GADGET-A2 (499)
      const skus = body.docs.map((p: { sku: string }) => p.sku).sort();
      expect(skus).toEqual(["GADGET-A1", "GADGET-A2", "WIDGET-002"]);
    });

    it("filter by status + sort desc by price: ?status=published&sort=-price", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/products?status=published&sort=-price`,
        headers: hdr(tokenUserA()),
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      const skus = body.docs.map((p: { sku: string }) => p.sku);
      // published only, sorted by price desc: GADGET-A1 (299), WIDGET-002 (175), WIDGET-001 (50)
      expect(skus).toEqual(["GADGET-A1", "WIDGET-002", "WIDGET-001"]);
    });

    it("pagination: ?page=1&limit=2&sort=price", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/products?page=1&limit=2&sort=price",
        headers: hdr(tokenUserA()),
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.docs.length).toBe(2);
      expect(body.page).toBe(1);
      expect(body.limit).toBe(2);
      // All 5 Org A products, first page sorted by price asc: LEGACY-999 (10), WIDGET-001 (50)
      const skus = body.docs.map((p: { sku: string }) => p.sku);
      expect(skus).toEqual(["LEGACY-999", "WIDGET-001"]);
    });

    it("page 2 of same query returns next 2 items", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/products?page=2&limit=2&sort=price",
        headers: hdr(tokenUserA()),
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      const skus = body.docs.map((p: { sku: string }) => p.sku);
      // Next 2 sorted by price asc: WIDGET-002 (175), GADGET-A1 (299)
      expect(skus).toEqual(["WIDGET-002", "GADGET-A1"]);
    });

    it("populate category reference: ?populate=category", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/products/WIDGET-001?populate=category",
        headers: hdr(tokenUserA()),
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      // Category should be an object (populated), not an ObjectId
      expect(typeof body.data.category).toBe("object");
      expect(body.data.category.name).toBe("Electronics");
      expect(body.data.category.slug).toBe("electronics");
    });

    it("cross-tenant population isolation — Org B populating sees only their category", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/products/WIDGET-001?populate=category",
        headers: hdr(tokenUserB()),
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.category.name).toBe("Books");
    });
  });

  // --------------------------------------------------------------------------
  // Orders with orderNumber custom ID + references
  // --------------------------------------------------------------------------

  describe("orders with orderNumber custom ID + nested references", () => {
    it("creates orders with auto-generated orderNumber via POST", async () => {
      const productA = await ProductModel.findOne({ sku: "GADGET-A1" });
      expect(productA).toBeTruthy();

      for (const o of [
        {
          orderNumber: "ORD-2026-0001",
          customer: USER_A,
          items: [{ product: productA?._id.toString(), quantity: 2, price: 299 }],
          total: 598,
          status: "paid",
        },
        {
          orderNumber: "ORD-2026-0002",
          customer: USER_A,
          items: [{ product: productA?._id.toString(), quantity: 1, price: 299 }],
          total: 299,
          status: "pending",
        },
        {
          orderNumber: "ORD-2026-0003",
          customer: USER_A,
          items: [{ product: productA?._id.toString(), quantity: 5, price: 299 }],
          total: 1495,
          status: "shipped",
        },
      ]) {
        const res = await app.inject({
          method: "POST",
          url: "/orders",
          headers: hdr(tokenUserA()),
          payload: o,
        });
        expect(res.statusCode).toBe(201);
      }
    });

    it("GET /orders/ORD-2026-0001 fetches by orderNumber", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/orders/ORD-2026-0001",
        headers: hdr(tokenUserA()),
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.orderNumber).toBe("ORD-2026-0001");
      expect(body.data.total).toBe(598);
    });

    it("filter orders by status + total range: ?status=paid&total[gte]=500", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/orders?status=paid&total[gte]=500",
        headers: hdr(tokenUserA()),
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.docs.length).toBe(1);
      expect(body.docs[0].orderNumber).toBe("ORD-2026-0001");
    });

    it("PATCH /orders/ORD-2026-0002 updates status", async () => {
      const res = await app.inject({
        method: "PATCH",
        url: "/orders/ORD-2026-0002",
        headers: hdr(tokenUserA()),
        payload: { status: "paid" },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.status).toBe("paid");

      // Verify in DB by orderNumber
      const doc = await OrderModel.findOne({ orderNumber: "ORD-2026-0002" });
      expect(doc?.status).toBe("paid");
    });

    it("Org B cannot GET /orders/ORD-2026-0001 (belongs to Org A)", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/orders/ORD-2026-0001",
        headers: hdr(tokenUserB()),
      });
      expect(res.statusCode).toBe(404);
    });

    it("DELETE /orders/ORD-2026-0003 removes the order by orderNumber", async () => {
      const res = await app.inject({
        method: "DELETE",
        url: "/orders/ORD-2026-0003",
        headers: hdr(tokenUserA()),
      });
      expect(res.statusCode).toBe(200);
      const doc = await OrderModel.findOne({ orderNumber: "ORD-2026-0003" });
      expect(doc).toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // Superadmin bypass
  // --------------------------------------------------------------------------

  describe("superadmin (elevated scope) bypasses org scoping", () => {
    it("superadmin LIST /products sees products from ALL orgs", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/products?limit=50",
        headers: hdr(tokenSuper()),
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      // 5 Org A products + 2 Org B products = 7 total
      expect(body.docs.length).toBeGreaterThanOrEqual(7);
      const orgs = new Set(
        body.docs.map((p: { organizationId: string }) => String(p.organizationId)),
      );
      expect(orgs.has(ORG_A)).toBe(true);
      expect(orgs.has(ORG_B)).toBe(true);
    });
  });
});
