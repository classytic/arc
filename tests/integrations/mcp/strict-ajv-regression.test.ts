/**
 * Regression test: ensure MongoKit's QueryParser schema does not produce
 * AJV strict-mode warnings when wired through defineResource → Fastify list route.
 *
 * Background: MongoKit's getQuerySchema() emits properties like
 *   page:    { minimum: 1 }
 *   limit:   { minimum: 1, maximum: 1000 }
 *   populate: { oneOf: [{type:"string"}, {type:"object", additionalProperties:true}] }
 *
 * AJV strict mode warns when `minimum`/`maximum`/`additionalProperties` appear
 * without a sibling `type`. defineResource normalizes these before passing to
 * Fastify — this test asserts that no warnings reach stderr during route registration.
 */

import { QueryParser, Repository } from "@classytic/mongokit";
import Fastify from "fastify";
import mongoose from "mongoose";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createMongooseAdapter } from "../../../src/adapters/index.js";
import { BaseController, defineResource } from "../../../src/core/index.js";
import { allowPublic } from "../../../src/permissions/index.js";

describe("MongoKit QueryParser → Fastify schema (no AJV strict warnings)", () => {
  let app: ReturnType<typeof Fastify>;
  const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

  beforeAll(async () => {
    const ProductSchema = new mongoose.Schema(
      {
        name: { type: String, required: true },
        price: Number,
        category: String,
      },
      { timestamps: true },
    );
    const Product =
      mongoose.models.StrictAjvProduct || mongoose.model("StrictAjvProduct", ProductSchema);
    const repo = new Repository(Product);

    const productResource = defineResource({
      name: "product",
      adapter: createMongooseAdapter({ model: Product, repository: repo }),
      controller: new BaseController(repo, {
        resourceName: "product",
        queryParser: new QueryParser({
          allowedFilterFields: ["category", "price"],
          allowedOperators: ["eq", "ne", "gt", "gte", "lt", "lte", "in"],
          allowedSortFields: ["createdAt", "price"],
        }),
        tenantField: false,
      }),
      queryParser: new QueryParser({
        allowedFilterFields: ["category", "price"],
        allowedOperators: ["eq", "ne", "gt", "gte", "lt", "lte", "in"],
        allowedSortFields: ["createdAt", "price"],
      }),
      permissions: {
        list: allowPublic(),
        get: allowPublic(),
        create: allowPublic(),
        update: allowPublic(),
        delete: allowPublic(),
      },
    });

    app = Fastify({
      ajv: {
        customOptions: {
          strict: true,
          strictTypes: true,
          strictTuples: true,
        },
      },
    });
    await app.register(productResource.toPlugin());
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    stderrSpy.mockRestore();
    consoleWarnSpy.mockRestore();
  });

  it("does not emit any AJV strict-mode warning to stderr", () => {
    const allWrites = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
    const allWarns = consoleWarnSpy.mock.calls.map((c) => c.join(" ")).join("");
    const combined = `${allWrites}\n${allWarns}`;
    expect(combined).not.toMatch(/strict mode/i);
    expect(combined).not.toMatch(/strictTypes/i);
  });

  it("registered the GET / list route successfully", () => {
    const routes = app.printRoutes();
    expect(routes).toMatch(/products/);
  });
});
