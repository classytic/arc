/**
 * A refused keyed request (validation, permission, any non-2xx) records no response, so it must
 * leave nothing behind: the claim row `acquire` upserted is deleted on release, not left
 * result-less until its TTL. A corrected retry with the same key then executes, and its success
 * is what later retries replay.
 */

import { batchOperationsPlugin, methodRegistryPlugin, Repository } from "@classytic/mongokit";
import Fastify, { type FastifyInstance } from "fastify";
import mongoose from "mongoose";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { idempotencyPlugin } from "../../src/idempotency/idempotencyPlugin.js";
import { repositoryAsIdempotencyStore } from "../../src/idempotency/repository-idempotency-adapter.js";
import { setupTestDatabase, teardownTestDatabase } from "../setup.js";

let model: mongoose.Model<Record<string, unknown>>;
let effects = 0;

async function boot(): Promise<FastifyInstance> {
  const repo = new Repository(model, [methodRegistryPlugin(), batchOperationsPlugin()]);
  const app = Fastify();
  await app.register(idempotencyPlugin, {
    enabled: true,
    ttlMs: 60_000,
    repository: repo,
    selfCheck: false,
  });
  app.post(
    "/orders",
    {
      preHandler: [app.idempotency.middleware],
      schema: {
        body: {
          type: "object",
          properties: { qty: { type: "integer" }, role: { type: "string" } },
          required: ["qty"],
        },
      },
    },
    async (request, reply) => {
      const body = request.body as { qty: number; role?: string };
      // Refusals the handler makes after the claim: a permission check, then domain validation.
      if (body.role !== "clerk") return reply.code(403).send({ code: "forbidden" });
      if (body.qty < 1) return reply.code(422).send({ code: "qty.invalid" });
      effects++;
      return reply.code(201).send({ effects });
    },
  );
  await app.ready();
  return app;
}

const send = (app: FastifyInstance, key: string, payload: Record<string, unknown>) =>
  app.inject({ method: "POST", url: "/orders", headers: { "idempotency-key": key }, payload });

const rowsFor = (key: string) => model.countDocuments({ _id: new RegExp(`^${key}:`) });

beforeAll(async () => {
  await setupTestDatabase();
  const schema = new mongoose.Schema(
    {
      _id: { type: String, required: true },
      result: {
        statusCode: Number,
        headers: mongoose.Schema.Types.Mixed,
        body: mongoose.Schema.Types.Mixed,
        requestFingerprint: String,
      },
      lock: { requestId: String, expiresAt: Date },
      createdAt: { type: Date, required: true },
      expiresAt: { type: Date, required: true },
    },
    { _id: false, collection: "idem_refusal_release", strictQuery: false },
  );
  model = (mongoose.models.IdemRefusalRelease ||
    mongoose.model("IdemRefusalRelease", schema)) as mongoose.Model<Record<string, unknown>>;
});

afterAll(async () => {
  await teardownTestDatabase();
});

beforeEach(() => {
  effects = 0;
});

describe("repository idempotency store: a refusal releases its claim", () => {
  it("a permission refusal leaves no row; the corrected retry executes, then replays", async () => {
    const app = await boot();
    expect((await send(app, "ref-perm", { qty: 1, role: "guest" })).statusCode).toBe(403);
    expect(await rowsFor("ref-perm")).toBe(0);

    const corrected = await send(app, "ref-perm", { qty: 1, role: "clerk" });
    expect(corrected.statusCode).toBe(201);
    expect(corrected.json()).toEqual({ effects: 1 });

    const replay = await send(app, "ref-perm", { qty: 1, role: "clerk" });
    expect(replay.headers["x-idempotency-replayed"]).toBe("true");
    expect(replay.json()).toEqual({ effects: 1 });
    expect(effects).toBe(1);
    await app.close();
  });

  it("a handler validation refusal leaves no row", async () => {
    const app = await boot();
    expect((await send(app, "ref-422", { qty: 0, role: "clerk" })).statusCode).toBe(422);
    expect(await rowsFor("ref-422")).toBe(0);
    expect((await send(app, "ref-422", { qty: 2, role: "clerk" })).statusCode).toBe(201);
    expect(await rowsFor("ref-422")).toBe(1);
    await app.close();
  });

  it("a schema validation refusal (before the middleware) never creates a claim", async () => {
    const app = await boot();
    expect((await send(app, "ref-schema", { role: "clerk" })).statusCode).toBe(400);
    expect(await rowsFor("ref-schema")).toBe(0);
    await app.close();
  });

  it("a completed row survives a stale unlock by its own request id", async () => {
    const repo = new Repository(model, [methodRegistryPlugin(), batchOperationsPlugin()]);
    const store = repositoryAsIdempotencyStore(repo, 60_000);
    expect((await store.acquire?.("ref-done", "r1", 30_000))?.status).toBe("acquired");
    // A step-protocol store can hold a lock on a row that already has a result (the
    // finish-before-lock race): unlock must clear the lock, never delete the result.
    await model.updateOne(
      { _id: "ref-done" },
      { $set: { result: { statusCode: 200, headers: {}, body: 7 } } },
    );
    await store.unlock("ref-done", "r1");
    const row = (await model.findById("ref-done").lean()) as {
      lock?: unknown;
      result?: { body?: unknown };
    } | null;
    expect(row?.result?.body).toBe(7);
    expect(row?.lock).toBeUndefined();
  });

  it("another request's lock is never released or deleted", async () => {
    const repo = new Repository(model, [methodRegistryPlugin(), batchOperationsPlugin()]);
    const store = repositoryAsIdempotencyStore(repo, 60_000);
    expect((await store.acquire?.("ref-other", "owner", 30_000))?.status).toBe("acquired");
    await store.unlock("ref-other", "intruder");
    expect(await store.isLocked("ref-other")).toBe(true);
  });
});
