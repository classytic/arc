/**
 * `lookupFields` beside an ObjectId `_id`: `GET /:id` accepts a business number (no ObjectId
 * pattern on its params), a value matching no key is 404 — not a schema 400 — and the write
 * routes, which resolve by `_id` only, keep the pattern.
 */

import { createMongooseAdapter } from "@classytic/mongokit/adapter";
import Fastify, { type FastifyInstance } from "fastify";
import mongoose, { Schema } from "mongoose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defineResource } from "../../src/core/defineResource.js";
import { allowPublic } from "../../src/permissions/index.js";
import { errorHandlerPlugin } from "../../src/plugins/errorHandler.js";
import { createMockRepository, setupTestDatabase, teardownTestDatabase } from "../setup.js";

interface Rma {
  rmaNumber: string;
  status?: string;
}

const RmaModel =
  mongoose.models.LookupGetRma ??
  mongoose.model<Rma>(
    "LookupGetRma",
    new Schema<Rma>({ rmaNumber: { type: String, required: true }, status: String }),
  );

let app: FastifyInstance;
let docId: string;

beforeAll(async () => {
  await setupTestDatabase();
  const [doc] = await RmaModel.create([{ rmaNumber: "RMA-2026-0040", status: "open" }]);
  docId = String(doc._id);
  const repo = createMockRepository(RmaModel);
  const open = allowPublic();
  const resource = defineResource({
    name: "rma",
    prefix: "/rmas",
    tenantField: false,
    adapter: createMongooseAdapter({ model: RmaModel, repository: repo }),
    lookupFields: ["rmaNumber"],
    permissions: { list: open, get: open, create: open, update: open, delete: open },
  });
  app = Fastify({ logger: false });
  await app.register(errorHandlerPlugin);
  await app.register(resource.toPlugin());
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await teardownTestDatabase();
});

describe("GET /:id with lookupFields", () => {
  it("resolves a business number and the _id alike", async () => {
    const byNumber = await app.inject({ method: "GET", url: "/rmas/RMA-2026-0040" });
    expect(byNumber.statusCode, byNumber.body).toBe(200);
    expect(byNumber.json().data?.rmaNumber ?? byNumber.json().rmaNumber).toBe("RMA-2026-0040");
    expect((await app.inject({ method: "GET", url: `/rmas/${docId}` })).statusCode).toBe(200);
  });

  it("a value matching no key is 404, not a schema 400", async () => {
    const res = await app.inject({ method: "GET", url: "/rmas/RMA-NOPE" });
    expect(res.statusCode).toBe(404);
  });

  it("write routes resolve by _id only and keep their ObjectId param check", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/rmas/RMA-2026-0040",
      payload: { status: "closed" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("arc.validation_error");
  });
});
