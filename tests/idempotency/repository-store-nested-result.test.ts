/**
 * A repository-backed idempotency store over a mongoose schema that declares `result` as a NESTED
 * path: mongoose reads a lock-only row back with `result: {}`. That empty object is not a completed
 * result — the first keyed request must execute (200), not replay `{}` into a 500.
 */

import { batchOperationsPlugin, methodRegistryPlugin, Repository } from "@classytic/mongokit";
import Fastify from "fastify";
import mongoose from "mongoose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { idempotencyPlugin } from "../../src/idempotency/idempotencyPlugin.js";
import { setupTestDatabase, teardownTestDatabase } from "../setup.js";

let app: ReturnType<typeof Fastify>;
let hits = 0;

beforeAll(async () => {
  await setupTestDatabase();
  const schema = new mongoose.Schema(
    {
      _id: { type: String, required: true },
      result: {
        statusCode: Number,
        headers: mongoose.Schema.Types.Mixed,
        body: mongoose.Schema.Types.Mixed,
      },
      lock: { requestId: String, expiresAt: Date },
      createdAt: { type: Date, required: true },
      expiresAt: { type: Date, required: true },
    },
    { _id: false, collection: "idem_nested_result" },
  );
  const model = mongoose.models.IdemNested || mongoose.model("IdemNested", schema);
  const repository = new Repository(model, [methodRegistryPlugin(), batchOperationsPlugin()]);
  app = Fastify();
  await app.register(idempotencyPlugin, {
    enabled: true,
    ttlMs: 60_000,
    methods: ["POST"],
    repository,
  });
  app.post("/pay", { preHandler: [app.idempotency.middleware] }, async () => ({ hits: ++hits }));
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await teardownTestDatabase();
});

describe("repository idempotency store — nested result path", () => {
  it("executes the first keyed call and replays the second", async () => {
    const send = () =>
      app.inject({
        method: "POST",
        url: "/pay",
        headers: { "idempotency-key": "pay-1" },
        payload: { amount: 100 },
      });
    const first = await send();
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ hits: 1 });
    const second = await send();
    expect(second.statusCode).toBe(200);
    expect(second.headers["x-idempotency-replayed"]).toBe("true");
    expect(second.json()).toEqual({ hits: 1 });
  });
});
