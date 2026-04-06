/**
 * Business Scenario E2E Tests
 *
 * Real-world patterns: accounting with subdoc arrays, multi-branch with
 * mixed tenant modes, company-wide lookups, and plugin-added fields.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import mongoose from "mongoose";
import { Repository, QueryParser } from "@classytic/mongokit";
import { createApp } from "../../src/factory/createApp.js";
import { defineResource } from "../../src/core/defineResource.js";
import { BaseController } from "../../src/core/BaseController.js";
import { createMongooseAdapter } from "../../src/adapters/mongoose.js";
import { allowPublic, roles, requireOrgRole, requireAuth } from "../../src/permissions/index.js";
import { setupTestDatabase, teardownTestDatabase } from "../setup.js";
import type { FastifyInstance } from "fastify";

// ============================================================================
// Scenario 1: Accounting App — Subdocument Arrays + excludeFields
// ============================================================================

describe("Scenario: Accounting App", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    await setupTestDatabase();

    const JournalSchema = new mongoose.Schema(
      {
        description: { type: String, required: true },
        date: { type: Date, required: true },
        entries: [
          {
            account: { type: mongoose.Schema.Types.ObjectId, required: true },
            debit: { type: Number, default: 0 },
            credit: { type: Number, default: 0 },
            memo: String,
          },
        ],
        // Computed — should NOT be in create/update body
        totalDebit: { type: Number, default: 0 },
        totalCredit: { type: Number, default: 0 },
        isBalanced: { type: Boolean, default: true },
        status: { type: String, enum: ["draft", "posted", "void"], default: "draft" },
        organizationId: { type: String }, // Not required in schema — injected by middleware in production
      },
      { timestamps: true },
    );
    const JM = mongoose.models.BizJournal || mongoose.model("BizJournal", JournalSchema);
    const jr = new Repository(JM);

    const journalSchemaOpts = {
      fieldRules: {
        description: { type: "string", required: true },
        date: { type: "date", required: true },
        entries: { type: "array" },
        status: { type: "string", enum: ["draft", "posted", "void"] },
        totalDebit: { systemManaged: true },
        totalCredit: { systemManaged: true },
        isBalanced: { systemManaged: true },
        organizationId: { systemManaged: true },
        createdAt: { systemManaged: true },
        updatedAt: { systemManaged: true },
      },
    };

    const journalResource = defineResource({
      name: "journal",
      prefix: "/journal-entries",
      displayName: "Journal Entry",
      adapter: createMongooseAdapter({ model: JM, repository: jr }),
      controller: new BaseController(jr, {
        resourceName: "journal",
        queryParser: new QueryParser({
          allowedFilterFields: ["status", "date", "organizationId"],
          allowedOperators: ["eq", "gte", "lte", "in"],
        }),
        tenantField: "organizationId",
        schemaOptions: journalSchemaOpts,
      }),
      permissions: {
        list: allowPublic(),
        get: allowPublic(),
        create: allowPublic(),
        update: allowPublic(),
        delete: allowPublic(),
      },
      schemaOptions: journalSchemaOpts,
    });

    await JM.deleteMany({});

    app = await createApp({
      preset: "testing",
      auth: false,
      resources: [journalResource],
    });
    await app.ready();
  });

  afterAll(async () => {
    if (app) await app.close();
    await teardownTestDatabase();
  });

  it("creates journal entry with subdocument array entries", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/journal-entries",
      payload: {
        description: "Office supplies",
        date: "2026-01-15T00:00:00.000Z",
        organizationId: "org-1", // required by Mongoose, injected by middleware in prod
        entries: [
          { account: "507f1f77bcf86cd799439011", debit: 500, credit: 0, memo: "Supplies" },
          { account: "507f1f77bcf86cd799439012", debit: 0, credit: 500, memo: "Cash" },
        ],
        status: "draft",
      },
    });
    expect(res.statusCode).toBe(201);
    const data = res.json().data;
    expect(data.entries).toHaveLength(2);
    expect(data.entries[0].debit).toBe(500);
    expect(data.entries[1].credit).toBe(500);
  });

  it("computed fields (totalDebit, totalCredit) not required on create", async () => {
    // Should succeed without totalDebit, totalCredit, isBalanced
    const res = await app.inject({
      method: "POST",
      url: "/journal-entries",
      payload: {
        description: "Salary payment",
        date: "2026-02-01T00:00:00.000Z",
        organizationId: "org-1",
        entries: [{ account: "507f1f77bcf86cd799439011", debit: 3000 }],
      },
    });
    expect(res.statusCode).toBe(201);
  });

  it("organizationId not required in Fastify body schema (systemManaged)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/journal-entries",
      payload: { description: "Test", date: "2026-03-01T00:00:00.000Z" },
    });
    // Fastify should NOT reject this — organizationId is systemManaged (not in body schema).
    // Mongoose may reject at DB level (required:true) — that's expected, middleware injects it.
    if (res.statusCode === 400) {
      const body = res.json();
      expect(body.code).not.toBe("VALIDATION_ERROR");
    }
  });

  it("filters with bracket notation on status", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/journal-entries?status=draft",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().docs.length).toBeGreaterThanOrEqual(1);
  });

  it("short date strings (2026-01-15) pass Fastify validation", async () => {
    // After removing format: "date-time" from Date type, both short dates and
    // ISO datetimes should pass Fastify validation. Mongoose handles parsing.
    const res = await app.inject({
      method: "POST",
      url: "/journal-entries",
      payload: { description: "Short date", date: "2026-06-15", organizationId: "org-1" },
    });
    expect(res.statusCode).toBe(201);
  });

  it("invalid date strings fail at Mongoose level, not Fastify", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/journal-entries",
      payload: { description: "Bad date", date: "not-a-date", organizationId: "org-1" },
    });
    // Should fail — but as a Mongoose/DB error, not Fastify VALIDATION_ERROR
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    if (res.statusCode === 400) {
      const body = res.json();
      expect(body.code).not.toBe("VALIDATION_ERROR");
    }
  });

  it("date range filter works", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/journal-entries?date[gte]=2026-01-01&date[lte]=2026-01-31",
    });
    expect(res.statusCode).toBe(200);
  });
});

// ============================================================================
// Scenario 2: Multi-Branch App — Mixed Tenant Modes
// ============================================================================

describe("Scenario: Multi-Branch App (mixed tenantField)", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    await setupTestDatabase();

    // Company-wide resource (all branches share) — tenantField: false
    const AccountTypeSchema = new mongoose.Schema({
      code: { type: String, required: true, unique: true },
      name: { type: String, required: true },
      category: { type: String, enum: ["asset", "liability", "equity", "revenue", "expense"] },
    });
    const ATM =
      mongoose.models.BizAccountType || mongoose.model("BizAccountType", AccountTypeSchema);
    const atr = new Repository(ATM);

    const atSchemaOpts = {
      fieldRules: {
        code: { type: "string", required: true, immutable: true },
        name: { type: "string", required: true },
        category: { type: "string", enum: ["asset", "liability", "equity", "revenue", "expense"] },
        createdAt: { systemManaged: true },
        updatedAt: { systemManaged: true },
      },
    };

    const accountTypeResource = defineResource({
      name: "account-type",
      displayName: "Account Type",
      adapter: createMongooseAdapter({ model: ATM, repository: atr }),
      controller: new BaseController(atr, {
        resourceName: "account-type",
        tenantField: false,
        schemaOptions: atSchemaOpts,
      }),
      permissions: {
        list: allowPublic(),
        get: allowPublic(),
        create: allowPublic(),
        update: allowPublic(),
        delete: allowPublic(),
      },
      schemaOptions: atSchemaOpts,
    });

    // Per-branch resource — tenantField: 'branchId'
    const OrderSchema = new mongoose.Schema(
      {
        orderNumber: { type: String, required: true },
        total: { type: Number, required: true },
        branchId: { type: String, index: true }, // Injected by middleware in production
      },
      { timestamps: true },
    );
    const OM = mongoose.models.BizOrder || mongoose.model("BizOrder", OrderSchema);
    const or = new Repository(OM);

    const orderSchemaOpts = {
      fieldRules: {
        orderNumber: { type: "string", required: true },
        total: { type: "number", required: true },
        branchId: { systemManaged: true },
        createdAt: { systemManaged: true },
        updatedAt: { systemManaged: true },
      },
    };

    const orderResource = defineResource({
      name: "order",
      displayName: "Order",
      adapter: createMongooseAdapter({ model: OM, repository: or }),
      controller: new BaseController(or, {
        resourceName: "order",
        tenantField: "branchId",
        schemaOptions: orderSchemaOpts,
      }),
      permissions: {
        list: allowPublic(),
        get: allowPublic(),
        create: allowPublic(),
        update: allowPublic(),
        delete: allowPublic(),
      },
      schemaOptions: orderSchemaOpts,
    });

    await ATM.deleteMany({});
    await OM.deleteMany({});

    await ATM.create([
      { code: "1000", name: "Cash", category: "asset" },
      { code: "2000", name: "Accounts Payable", category: "liability" },
      { code: "4000", name: "Sales Revenue", category: "revenue" },
    ]);

    app = await createApp({
      preset: "testing",
      auth: false,
      resources: [accountTypeResource, orderResource],
    });
    await app.ready();
  });

  afterAll(async () => {
    if (app) await app.close();
    await teardownTestDatabase();
  });

  it("company-wide resource (tenantField: false) returns all records", async () => {
    const res = await app.inject({ method: "GET", url: "/account-types" });
    expect(res.statusCode).toBe(200);
    expect(res.json().docs.length).toBe(3);
  });

  it("company-wide resource: immutable field (code) cannot be updated", async () => {
    const list = await app.inject({ method: "GET", url: "/account-types" });
    const cash = list.json().docs.find((d: any) => d.code === "1000");
    expect(cash).toBeDefined();

    const res = await app.inject({
      method: "PATCH",
      url: `/account-types/${cash._id}`,
      payload: { code: "9999", name: "Updated Cash" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.name).toBe("Updated Cash");
    expect(res.json().data.code).toBe("1000"); // immutable — not changed
  });

  it("per-branch resource CRUD works (branchId provided)", async () => {
    // In production, branchId would be injected by multiTenant preset or middleware.
    // Here we pass it explicitly since we're testing without the preset.
    const create = await app.inject({
      method: "POST",
      url: "/orders",
      payload: { orderNumber: "ORD-001", total: 150, branchId: "branch-1" },
    });
    expect(create.statusCode).toBe(201);

    const list = await app.inject({ method: "GET", url: "/orders" });
    expect(list.statusCode).toBe(200);
    expect(list.json().docs.length).toBeGreaterThanOrEqual(1);
  });

  it("branchId not required in Fastify body SCHEMA (systemManaged)", async () => {
    // The Fastify body schema should NOT list branchId as required.
    // This means the HTTP request passes validation.
    // Mongoose may still reject at DB level if required:true — that's expected,
    // because middleware/hooks inject it before the DB call in production.
    const res = await app.inject({
      method: "POST",
      url: "/orders",
      payload: { orderNumber: "ORD-002", total: 75 },
    });
    // Should NOT be a Fastify schema validation error (code: VALIDATION_ERROR)
    // May be a Mongoose validation error (code: BAD_REQUEST) — that's the DB layer, not Arc
    if (res.statusCode === 400) {
      const body = res.json();
      expect(body.code).not.toBe("VALIDATION_ERROR");
    }
  });
});

// ============================================================================
// Scenario 3: Plugin-Added Fields (extraFields pattern)
// ============================================================================

describe("Scenario: Plugin-Added Fields (extraFields)", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    await setupTestDatabase();

    // Simulate a schema where a plugin adds organizationId AFTER definition
    const ProductSchema = new mongoose.Schema(
      {
        name: { type: String, required: true },
        price: { type: Number, required: true },
      },
      { timestamps: true },
    );

    // Plugin adds organizationId (like ledger or multi-tenant plugin would)
    ProductSchema.add({
      organizationId: { type: String, index: true }, // Not required — middleware injects it
    });

    const PM =
      mongoose.models.BizPluginProduct || mongoose.model("BizPluginProduct", ProductSchema);
    const pr = new Repository(PM);

    const prodSchemaOpts = {
      fieldRules: {
        name: { type: "string", required: true },
        price: { type: "number", required: true },
        createdAt: { systemManaged: true },
        updatedAt: { systemManaged: true },
      },
    };

    const productResource = defineResource({
      name: "product",
      adapter: createMongooseAdapter({ model: PM, repository: pr }),
      controller: new BaseController(pr, {
        resourceName: "product",
        tenantField: "organizationId",
        schemaOptions: prodSchemaOpts,
      }),
      permissions: {
        list: allowPublic(),
        get: allowPublic(),
        create: allowPublic(),
        update: allowPublic(),
        delete: allowPublic(),
      },
      schemaOptions: prodSchemaOpts,
    });

    await PM.deleteMany({});

    app = await createApp({
      preset: "testing",
      auth: false,
      resources: [productResource],
    });
    await app.ready();
  });

  afterAll(async () => {
    if (app) await app.close();
    await teardownTestDatabase();
  });

  it("plugin-added field (organizationId) NOT required in Fastify body schema", async () => {
    // organizationId is required in Mongoose but NOT in fieldRules.
    // Arc should NOT add it to the Fastify body schema required array.
    // Mongoose will reject at DB level — that's expected (middleware injects it in prod).
    const res = await app.inject({
      method: "POST",
      url: "/products",
      payload: { name: "Widget", price: 9.99 },
    });
    // Should NOT be a Fastify VALIDATION_ERROR — that would mean the schema requires organizationId
    if (res.statusCode === 400) {
      const body = res.json();
      expect(body.code).not.toBe("VALIDATION_ERROR");
    } else {
      expect(res.statusCode).toBe(201);
    }
  });

  it("plugin-added field still appears in response when set", async () => {
    // Create with organizationId explicitly (simulating middleware injection)
    await app.inject({
      method: "POST",
      url: "/products",
      payload: { name: "Gadget", price: 19.99, organizationId: "org-test" },
    });

    const res = await app.inject({ method: "GET", url: "/products" });
    expect(res.statusCode).toBe(200);
    const doc = res.json().docs.find((d: any) => d.name === "Gadget");
    expect(doc).toBeDefined();
    expect(doc.organizationId).toBe("org-test");
  });

  it("known required fields are still enforced", async () => {
    // name is required — should fail without it
    const res = await app.inject({
      method: "POST",
      url: "/products",
      payload: { price: 5 },
    });
    // Mongoose validation should catch missing name
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });
});
