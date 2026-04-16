/**
 * Integration Test: MongoKit `buildCrudSchemasFromModel` → Arc OpenAPI pipeline
 *
 * The existing `tests/core/auto-schema-generation.test.ts` proves arc accepts
 * *any* `schemaGenerator` that returns the expected shape — but it uses a
 * mock. This test wires the **real** `buildCrudSchemasFromModel` from
 * `@classytic/mongokit` through `createMongooseAdapter`, mounts the resource,
 * and asserts Arc serves requests validated against those schemas.
 *
 * If mongokit ever changes the shape returned by `buildCrudSchemasFromModel`
 * in a way arc can't consume, this test fails fast.
 */

import {
  buildCrudSchemasFromModel,
  methodRegistryPlugin,
  Repository,
  softDeletePlugin,
} from "@classytic/mongokit";
import type { FastifyInstance } from "fastify";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Schema, type Types } from "mongoose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMongooseAdapter } from "../../src/adapters/mongoose.js";
import { defineResource } from "../../src/core/defineResource.js";
import { createApp } from "../../src/factory/createApp.js";
import { allowPublic } from "../../src/permissions/index.js";

interface IWidget {
  _id: Types.ObjectId;
  name: string;
  price: number;
  inStock: boolean;
  tags: string[];
  deletedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const widgetSchema = new Schema<IWidget>(
  {
    name: { type: String, required: true, minlength: 2, maxlength: 80 },
    price: { type: Number, required: true, min: 0 },
    inStock: { type: Boolean, default: true },
    tags: { type: [String], default: [] },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

let mongo: MongoMemoryServer;
let app: FastifyInstance;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());

  const Widget = mongoose.model<IWidget>("WidgetSchemaGen", widgetSchema);
  const repo = new Repository<IWidget>(Widget, [methodRegistryPlugin(), softDeletePlugin()]);

  const adapter = createMongooseAdapter<IWidget>({
    model: Widget,
    repository: repo,
    // Real mongokit schema generator — this is the integration point under test.
    schemaGenerator: (model, options) => buildCrudSchemasFromModel(model, options),
  });

  const widgetResource = defineResource({
    name: "widget",
    prefix: "/widgets",
    adapter,
    permissions: { create: allowPublic(), get: allowPublic(), list: allowPublic() },
  });

  app = await createApp({
    resources: [widgetResource],
    auth: "none",
    helmet: false,
    cors: false,
    rateLimit: false,
  });
});

afterAll(async () => {
  await app?.close();
  await mongoose.disconnect();
  await mongo?.stop();
});

describe("MongoKit buildCrudSchemasFromModel integration", () => {
  it("POST /widgets validates required `name` using mongokit-generated schema", async () => {
    const bad = await app.inject({
      method: "POST",
      url: "/widgets",
      headers: { "content-type": "application/json" },
      payload: { price: 10 }, // missing `name`
    });
    expect(bad.statusCode).toBe(400);

    const good = await app.inject({
      method: "POST",
      url: "/widgets",
      headers: { "content-type": "application/json" },
      payload: { name: "Gizmo", price: 19, tags: ["new"] },
    });
    expect(good.statusCode).toBe(201);
    const body = good.json() as { data: { name: string; price: number } };
    expect(body.data.name).toBe("Gizmo");
    expect(body.data.price).toBe(19);
  });

  it("PATCH /widgets/:id accepts partial body via updateBody schema", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/widgets",
      headers: { "content-type": "application/json" },
      payload: { name: "Starter", price: 5 },
    });
    const { data } = created.json() as { data: { _id: string } };

    const patched = await app.inject({
      method: "PATCH",
      url: `/widgets/${data._id}`,
      headers: { "content-type": "application/json" },
      payload: { price: 7 }, // partial — updateBody schema must allow this
    });
    expect(patched.statusCode).toBe(200);
    expect((patched.json() as { data: { price: number } }).data.price).toBe(7);
  });

  it("GET /widgets/:id rejects malformed ObjectId via params schema", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/widgets/not-an-object-id",
    });
    expect([400, 404]).toContain(response.statusCode);
  });

  it("minlength/maxlength constraints from Mongoose propagate through to HTTP validation", async () => {
    const tooShort = await app.inject({
      method: "POST",
      url: "/widgets",
      headers: { "content-type": "application/json" },
      payload: { name: "A", price: 1 }, // name minlength: 2
    });
    expect(tooShort.statusCode).toBe(400);
  });
});
