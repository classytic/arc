/**
 * Query Schema Compatibility Tests
 *
 * Verifies that bracket notation queries (qs-parsed) pass through
 * Fastify's AJV validation and reach the QueryParser correctly.
 *
 * Arc's design: AJV validates structure (additionalProperties), QueryParser
 * validates content (allowed fields, operators, types). No double-validation.
 */

import { QueryParser, Repository } from "@classytic/mongokit";
import type { FastifyInstance } from "fastify";
import mongoose from "mongoose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMongooseAdapter } from "../../src/adapters/mongoose.js";
import { BaseController } from "../../src/core/BaseController.js";
import { defineResource } from "../../src/core/defineResource.js";
import { createApp } from "../../src/factory/createApp.js";
import { allowPublic } from "../../src/permissions/index.js";
import { setupTestDatabase, teardownTestDatabase } from "../setup.js";

describe("Query Schema Compatibility", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    await setupTestDatabase();

    const S = new mongoose.Schema(
      {
        name: { type: String, required: true },
        price: Number,
        category: String,
        tags: [String],
        status: { type: String, enum: ["active", "draft", "archived"] },
        metadata: { type: mongoose.Schema.Types.Mixed },
      },
      { timestamps: true },
    );
    const M = mongoose.models.QSCProduct || mongoose.model("QSCProduct", S);
    const repo = new Repository(M);

    const qp = new QueryParser({
      allowedFilterFields: ["name", "price", "category", "status", "tags"],
      allowedOperators: ["eq", "ne", "gt", "gte", "lt", "lte", "in", "nin", "contains", "exists"],
      allowedSortFields: ["name", "price", "createdAt"],
    });

    const resource = defineResource({
      name: "product",
      adapter: createMongooseAdapter({ model: M, repository: repo }),
      controller: new BaseController(repo, {
        resourceName: "product",
        queryParser: qp,
        tenantField: false,
      }),
      queryParser: qp,
      permissions: {
        list: allowPublic(),
        get: allowPublic(),
        create: allowPublic(),
        update: allowPublic(),
        delete: allowPublic(),
      },
      schemaOptions: {
        fieldRules: {
          name: { type: "string", required: true },
          price: { type: "number" },
          category: { type: "string" },
          tags: { type: "array" },
          status: { type: "string", enum: ["active", "draft", "archived"] },
          createdAt: { systemManaged: true },
          updatedAt: { systemManaged: true },
        },
      },
    });

    // Seed
    await M.deleteMany({});
    await M.create([
      {
        name: "MacBook",
        price: 2499,
        category: "electronics",
        status: "active",
        tags: ["laptop", "apple"],
      },
      {
        name: "TypeScript Book",
        price: 39,
        category: "books",
        status: "active",
        tags: ["programming"],
      },
      { name: "Draft Item", price: 10, category: "other", status: "draft", tags: [] },
      { name: "Archived Widget", price: 5, category: "other", status: "archived", tags: ["old"] },
    ]);

    app = await createApp({
      preset: "testing",
      auth: false,
      resources: [resource],
    });
    await app.ready();
  });

  afterAll(async () => {
    if (app) await app.close();
    await teardownTestDatabase();
  });

  /** Helper — none of these should return 400 */
  async function expectNotRejected(url: string) {
    const res = await app.inject({ method: "GET", url });
    expect(res.statusCode, `${url} returned ${res.statusCode}: ${res.body}`).not.toBe(400);
    return res;
  }

  // ── Single operator bracket filters ──

  it("name[contains]=Book", async () => {
    const res = await expectNotRejected("/products?name[contains]=Book");
    // "MacBook" and "TypeScript Book" both contain "Book"
    expect(res.json().docs.length).toBe(2);
    expect(res.json().docs.every((d: { name: string }) => d.name.includes("Book"))).toBe(true);
  });

  it("price[gte]=100", async () => {
    const res = await expectNotRejected("/products?price[gte]=100");
    expect(res.json().docs.length).toBe(1);
  });

  it("price[gt]=5&price[lt]=100", async () => {
    const res = await expectNotRejected("/products?price[gt]=5&price[lt]=100");
    expect(res.json().docs.length).toBe(2); // Book (39) + Draft (10)
  });

  it("status[in]=active,draft", async () => {
    const res = await expectNotRejected("/products?status[in]=active,draft");
    expect(res.json().docs.length).toBe(3);
  });

  it("status[ne]=archived", async () => {
    const res = await expectNotRejected("/products?status[ne]=archived");
    expect(res.json().docs.length).toBe(3);
  });

  // ── Exact match (no brackets) ──

  it("category=books (exact)", async () => {
    const res = await expectNotRejected("/products?category=books");
    expect(res.json().docs.length).toBe(1);
  });

  it("status=active (exact)", async () => {
    const res = await expectNotRejected("/products?status=active");
    expect(res.json().docs.length).toBe(2);
  });

  // ── Combined filters ──

  it("category=electronics&price[lte]=3000", async () => {
    const res = await expectNotRejected("/products?category=electronics&price[lte]=3000");
    expect(res.json().docs.length).toBe(1);
  });

  it("status[in]=active,draft&sort=-price&limit=2", async () => {
    const res = await expectNotRejected("/products?status[in]=active,draft&sort=-price&limit=2");
    const docs = res.json().docs;
    expect(docs.length).toBe(2);
    expect(docs[0].price).toBeGreaterThanOrEqual(docs[1].price);
  });

  // ── Pagination + filters ──

  it("page=1&limit=1&status=active", async () => {
    const res = await expectNotRejected("/products?page=1&limit=1&status=active");
    expect(res.json().docs.length).toBe(1);
    expect(res.json().total).toBe(2);
  });

  // ── Populate bracket notation ──

  it("populate[x][select]=name (not 400)", async () => {
    await expectNotRejected("/products?populate[x][select]=name");
  });

  // ── Sort ──

  it("sort=price", async () => {
    const res = await expectNotRejected("/products?sort=price");
    const docs = res.json().docs;
    for (let i = 1; i < docs.length; i++) {
      expect(docs[i].price).toBeGreaterThanOrEqual(docs[i - 1].price);
    }
  });

  it("sort=-price", async () => {
    const res = await expectNotRejected("/products?sort=-price");
    const docs = res.json().docs;
    for (let i = 1; i < docs.length; i++) {
      expect(docs[i].price).toBeLessThanOrEqual(docs[i - 1].price);
    }
  });

  // ── Unknown/extra params don't cause 400 ──

  it("unknown params pass through", async () => {
    await expectNotRejected("/products?foo=bar&baz[nested]=deep");
  });

  it("search param not rejected by schema validation", async () => {
    const res = await app.inject({ method: "GET", url: "/products?search=MacBook" });
    // search requires a MongoDB text index — may return 400 (MongoKit parse error)
    // or 500 (DB error). The point is it's not a Fastify schema validation 400.
    // A schema validation 400 has "Validation failed" in the response.
    if (res.statusCode === 400) {
      const body = res.json();
      // Schema validation errors have code: "VALIDATION_ERROR"
      // MongoKit/DB errors don't — they're operational errors
      expect(body.code).not.toBe("VALIDATION_ERROR");
    }
  });
});
