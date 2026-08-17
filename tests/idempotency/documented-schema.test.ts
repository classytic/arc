/**
 * The SCHEMA PRINTED IN THE DOCS must be the one that works.
 *
 * `docs/production-ops/idempotency.mdx` previously printed
 * `new Schema({}, { strict: false, timestamps: false, _id: false })` — the
 * exact pathless shape that, under a global `strictQuery: true`, strips every
 * filter key and replays cached responses across keys and users. The docs were
 * teaching the incident. This pins the corrected snippet by running it.
 */

import {
  batchOperationsPlugin,
  methodRegistryPlugin,
  mongoOperationsPlugin,
  Repository,
} from "@classytic/mongokit";
import Fastify from "fastify";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Schema } from "mongoose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { idempotencyPlugin } from "../../src/idempotency/idempotencyPlugin.js";

let mongod: MongoMemoryServer;
let prior: boolean | "throw";

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  prior = mongoose.get("strictQuery");
  mongoose.set("strictQuery", true); // the hostile global the docs must survive
}, 120_000);

afterAll(async () => {
  mongoose.set("strictQuery", prior);
  await mongoose.disconnect();
  await mongod.stop();
}, 60_000);

describe("the documented repository-store schema", () => {
  it("boots and isolates keys under a global strictQuery: true", async () => {
    // ── copied verbatim from docs/production-ops/idempotency.mdx ──
    const IdempotencyModel = mongoose.model(
      "ArcIdempotencyDoc",
      new Schema({ _id: String }, { strict: false, strictQuery: false, timestamps: false }),
      "arc_idempotency_doc",
    );

    const app = Fastify({ logger: false });
    await app.register(idempotencyPlugin, {
      enabled: true,
      repository: new Repository(IdempotencyModel as never, [
        methodRegistryPlugin(),
        batchOperationsPlugin(),
        mongoOperationsPlugin(),
      ]) as never,
    });
    // Registration succeeding IS the self-check passing.
    await app.ready();

    const store = app.idempotency.store;
    if (!store) throw new Error("store missing");
    const { createIdempotencyResult } = await import("../../src/idempotency/stores/index.js");

    await store.set("DOC-A", createIdempotencyResult(201, { order: "A" }, {}, 60_000));
    expect((await store.get("DOC-A"))?.statusCode).toBe(201);
    expect(await store.get("DOC-B")).toBeUndefined(); // no cross-key replay
    await app.close();
  }, 60_000);
});
