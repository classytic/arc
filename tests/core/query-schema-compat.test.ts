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
import { createMongooseAdapter } from "@classytic/mongokit/adapter";
import type { FastifyInstance } from "fastify";
import mongoose from "mongoose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
      logger: false,
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

  /**
   * Helper — none of these query shapes should be rejected by FASTIFY SCHEMA
   * VALIDATION (the layer this suite is about). A Fastify schema-validation
   * 400 carries `code: 'arc.validation_error'`. mongokit's fail-closed parser
   * (>=3.25) is a SEPARATE layer that raises 400 `INVALID_QUERY_INPUT` for
   * blocked/unwhitelisted input — that's allowed here; we only assert the
   * query schema itself didn't reject the shape.
   */
  async function expectNotRejected(url: string) {
    const res = await app.inject({ method: "GET", url });
    if (res.statusCode === 400) {
      const body = res.json() as { code?: string };
      expect(body.code, `${url} was SCHEMA-rejected: ${res.body}`).not.toBe("arc.validation_error");
    }
    return res;
  }

  // ── Single operator bracket filters ──

  it("name[contains]=Book", async () => {
    const res = await expectNotRejected("/products?name[contains]=Book");
    // "MacBook" and "TypeScript Book" both contain "Book"
    expect(res.json().data.length).toBe(2);
    expect(res.json().data.every((d: { name: string }) => d.name.includes("Book"))).toBe(true);
  });

  it("price[gte]=100", async () => {
    const res = await expectNotRejected("/products?price[gte]=100");
    expect(res.json().data.length).toBe(1);
  });

  it("price[gt]=5&price[lt]=100", async () => {
    const res = await expectNotRejected("/products?price[gt]=5&price[lt]=100");
    expect(res.json().data.length).toBe(2); // Book (39) + Draft (10)
  });

  it("status[in]=active,draft", async () => {
    const res = await expectNotRejected("/products?status[in]=active,draft");
    expect(res.json().data.length).toBe(3);
  });

  it("status[ne]=archived", async () => {
    const res = await expectNotRejected("/products?status[ne]=archived");
    expect(res.json().data.length).toBe(3);
  });

  // ── Exact match (no brackets) ──

  it("category=books (exact)", async () => {
    const res = await expectNotRejected("/products?category=books");
    expect(res.json().data.length).toBe(1);
  });

  it("status=active (exact)", async () => {
    const res = await expectNotRejected("/products?status=active");
    expect(res.json().data.length).toBe(2);
  });

  // ── Combined filters ──

  it("category=electronics&price[lte]=3000", async () => {
    const res = await expectNotRejected("/products?category=electronics&price[lte]=3000");
    expect(res.json().data.length).toBe(1);
  });

  it("status[in]=active,draft&sort=-price&limit=2", async () => {
    const res = await expectNotRejected("/products?status[in]=active,draft&sort=-price&limit=2");
    const rows = res.json().data;
    expect(rows.length).toBe(2);
    expect(rows[0].price).toBeGreaterThanOrEqual(rows[1].price);
  });

  // ── Pagination + filters ──

  it("page=1&limit=1&status=active", async () => {
    const res = await expectNotRejected("/products?page=1&limit=1&status=active");
    expect(res.json().data.length).toBe(1);
    expect(res.json().total).toBe(2);
  });

  // ── Populate bracket notation ──

  it("populate[x][select]=name (not 400)", async () => {
    await expectNotRejected("/products?populate[x][select]=name");
  });

  // ── Sort ──

  it("sort=price", async () => {
    const res = await expectNotRejected("/products?sort=price");
    const data = res.json();
    for (let i = 1; i < data.length; i++) {
      expect(data[i].price).toBeGreaterThanOrEqual(data[i - 1].price);
    }
  });

  it("sort=-price", async () => {
    const res = await expectNotRejected("/products?sort=-price");
    const data = res.json();
    for (let i = 1; i < data.length; i++) {
      expect(data[i].price).toBeLessThanOrEqual(data[i - 1].price);
    }
  });

  // ── Unknown/extra params don't cause 400 ──

  it("unknown params pass the query SCHEMA (parser may still fail-close them)", async () => {
    // additionalProperties: true — Fastify's query schema doesn't reject unknown
    // params at validation time. mongokit's fail-closed parser then rejects
    // unwhitelisted filter fields with 400 INVALID_QUERY_INPUT (a parser layer,
    // NOT a schema-validation 400). We assert only the schema didn't reject.
    await expectNotRejected("/products?foo=bar&baz[nested]=deep");
  });

  it("search param not rejected by schema validation", async () => {
    const res = await app.inject({ method: "GET", url: "/products?search=MacBook" });
    // search requires a MongoDB text index — may return 400 (MongoKit parse error)
    // or 500 (DB error). The point is it's not a Fastify schema validation 400.
    // A schema validation 400 has "Validation failed" in the response.
    if (res.statusCode === 400) {
      const body = res.json();
      // Schema validation errors have code: "arc.validation_error"
      // MongoKit/DB errors don't — they're operational errors
      expect(body.code).not.toBe("arc.validation_error");
    }
  });
});
