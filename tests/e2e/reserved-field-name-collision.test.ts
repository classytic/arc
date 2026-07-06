/**
 * EMPIRICAL: does a resource field whose NAME collides with a reserved query
 * param (`cursor`, `page`, `limit`, …) actually break filtering?
 *
 * Real mongokit `Repository` + in-memory MongoDB — no mocks of the query path.
 * This settles the code-review concern that adding `cursor` to the MCP list
 * tool schema is dangerous: we prove whether the collision is (a) real and (b)
 * pre-existing at arc's query-parser layer (not introduced by the MCP change),
 * and it drives the fix (a boot diagnostic).
 *
 * arc's `QueryParser.parse` reserves `page`/`limit`/`sort`/`search`/`select`/
 * `populate`/`after`/`cursor` — `q.after ?? q.cursor` is consumed as the keyset
 * cursor (utils/queryParser.ts). So a document field literally named `cursor`
 * or `page` can't be filtered on via the query string, regardless of MCP.
 */

import { Repository } from "@classytic/mongokit";
import { createMongooseAdapter } from "@classytic/mongokit/adapter";
import type { FastifyInstance } from "fastify";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { type Model, Schema } from "mongoose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BaseController } from "../../src/core/BaseController.js";
import { defineResource } from "../../src/core/defineResource.js";
import { createApp } from "../../src/factory/createApp.js";
import { allowPublic } from "../../src/permissions/index.js";

interface IGadget {
  code: string;
  cursor: string; // ← name collides with the reserved keyset-cursor param
  page: number; // ← name collides with the reserved page param
  color: string; // ← a normal field (control)
}

const GadgetSchema = new Schema<IGadget>({
  code: { type: String, required: true, unique: true },
  cursor: { type: String },
  page: { type: Number },
  color: { type: String },
});

let mongoServer: MongoMemoryServer;
let GadgetModel: Model<IGadget>;
let app: FastifyInstance;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  GadgetModel = mongoose.models.CollisionGadget || mongoose.model("CollisionGadget", GadgetSchema);

  const repo = new Repository<IGadget>(GadgetModel);
  const resource = defineResource<IGadget>({
    name: "gadget",
    prefix: "/gadgets",
    idField: "code",
    tenantField: false,
    adapter: createMongooseAdapter({ model: GadgetModel, repository: repo }),
    controller: new BaseController(repo, {
      resourceName: "gadget",
      idField: "code",
      tenantField: false,
    }),
    schemaOptions: {
      filterableFields: ["code", "cursor", "page", "color"],
    },
    permissions: { list: allowPublic(), get: allowPublic() },
  });

  app = await createApp({
    preset: "development",
    auth: false,
    logger: false,
    helmet: false,
    rateLimit: false,
    plugins: async (f) => {
      await f.register(resource.toPlugin());
    },
  });
  await app.ready();

  await GadgetModel.deleteMany({});
  await GadgetModel.create([
    { code: "g1", cursor: "alpha", page: 1, color: "red" },
    { code: "g2", cursor: "beta", page: 2, color: "blue" },
    { code: "g3", cursor: "gamma", page: 3, color: "red" },
  ]);
}, 60_000);

afterAll(async () => {
  await app?.close();
  await mongoose.disconnect();
  await mongoServer?.stop();
});

function listData(body: string): IGadget[] {
  const parsed = JSON.parse(body);
  return (parsed.data ?? parsed) as IGadget[];
}

describe("reserved-field-name collision (real mongokit)", () => {
  it("CONTROL — a normal field (`color`) filters correctly", async () => {
    const r = await app.inject({ method: "GET", url: "/gadgets?color=red" });
    expect(r.statusCode).toBe(200);
    const data = listData(r.body);
    expect(data.map((g) => g.code).sort()).toEqual(["g1", "g3"]); // both reds, not blue
  });

  it("COLLISION — `?cursor=alpha` does NOT filter by the `cursor` field", async () => {
    // If `cursor` were a normal filter, this would return exactly g1. It is
    // instead consumed as a keyset cursor by the query parser, so the field
    // filter is silently dropped. We assert the observable truth: the result
    // is NOT the single-row filter a naive caller expects.
    const r = await app.inject({ method: "GET", url: "/gadgets?cursor=alpha" });
    const filteredToOnlyG1 =
      r.statusCode === 200 && listData(r.body).length === 1 && listData(r.body)[0]?.code === "g1";
    // The whole point: filtering by a field named `cursor` does NOT work.
    expect(filteredToOnlyG1).toBe(false);
  });

  it("COLLISION — `?page=1` is pagination, NOT a filter on the `page` field", async () => {
    // `page` is the pagination page number. `?page=1` returns page 1 of ALL
    // rows, not "rows whose page field === 1" (which would be just g1).
    const r = await app.inject({ method: "GET", url: "/gadgets?page=1&limit=50" });
    expect(r.statusCode).toBe(200);
    const data = listData(r.body);
    // All three rows come back (page 1 of everything), proving `page` was NOT
    // treated as a field filter.
    expect(data.length).toBe(3);
  });

  it("the collision is arc-query-parser-wide, not MCP-specific (REST proves it)", async () => {
    // Sanity contrast: `code` (also declared filterable, NOT reserved) works.
    const r = await app.inject({ method: "GET", url: "/gadgets?code=g2" });
    expect(r.statusCode).toBe(200);
    const data = listData(r.body);
    expect(data.map((g) => g.code)).toEqual(["g2"]);
  });
});
