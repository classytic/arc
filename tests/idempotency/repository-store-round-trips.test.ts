/**
 * A keyed request costs TWO repository round trips on a repository-backed store: one atomic
 * acquire (returns the row) and one fenced completion that also clears the lock. Every
 * semantic of the step protocol still holds: replay, 409 in flight, 422 on a changed body,
 * takeover of an expired lease, re-execution after a failure or an expired result.
 */

import { batchOperationsPlugin, methodRegistryPlugin, Repository } from "@classytic/mongokit";
import Fastify, { type FastifyInstance } from "fastify";
import mongoose from "mongoose";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { idempotencyPlugin } from "../../src/idempotency/idempotencyPlugin.js";
import { repositoryAsIdempotencyStore } from "../../src/idempotency/repository-idempotency-adapter.js";
import type { IdempotencyStore } from "../../src/idempotency/stores/interface.js";
import { setupTestDatabase, teardownTestDatabase } from "../setup.js";

let model: mongoose.Model<Record<string, unknown>>;
let calls = 0;
let effects = 0;
let gate: Promise<void> | undefined;

function countingRepository(): Repository<Record<string, unknown>> {
  const repo = new Repository(model, [methodRegistryPlugin(), batchOperationsPlugin()]);
  for (const verb of ["getOne", "findOneAndUpdate", "deleteMany"] as const) {
    const original = (repo as unknown as Record<string, (...a: unknown[]) => unknown>)[verb];
    (repo as unknown as Record<string, unknown>)[verb] = (...args: unknown[]) => {
      calls++;
      return original?.apply(repo, args);
    };
  }
  return repo;
}

async function boot(store: IdempotencyStore): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(idempotencyPlugin, { enabled: true, ttlMs: 60_000, store, selfCheck: false });
  app.post("/pay", { preHandler: [app.idempotency.middleware] }, async (request, reply) => {
    effects++;
    if (gate) await gate;
    const body = request.body as { fail?: boolean };
    if (body.fail) return reply.code(400).send({ code: "nope" });
    return { effects };
  });
  await app.ready();
  return app;
}

const send = (app: FastifyInstance, key: string, payload: Record<string, unknown> = { amount: 1 }) =>
  app.inject({ method: "POST", url: "/pay", headers: { "idempotency-key": key }, payload });

beforeAll(async () => {
  await setupTestDatabase();
  const schema = new mongoose.Schema(
    {
      _id: { type: String, required: true },
      result: { statusCode: Number, headers: mongoose.Schema.Types.Mixed, body: mongoose.Schema.Types.Mixed, requestFingerprint: String },
      lock: { requestId: String, expiresAt: Date },
      createdAt: { type: Date, required: true },
      expiresAt: { type: Date, required: true },
    },
    { _id: false, collection: "idem_round_trips", strictQuery: false },
  );
  model = (mongoose.models.IdemRoundTrips ||
    mongoose.model("IdemRoundTrips", schema)) as mongoose.Model<Record<string, unknown>>;
});

afterAll(async () => {
  await teardownTestDatabase();
});

beforeEach(() => {
  calls = 0;
  effects = 0;
  gate = undefined;
});

describe("repository idempotency store — round trips per keyed request", () => {
  it("first use: one acquire + one completion that clears the lock", async () => {
    const app = await boot(repositoryAsIdempotencyStore(countingRepository(), 60_000));
    const first = await send(app, "rt-first");
    expect(first.statusCode).toBe(200);
    expect(calls).toBe(2);
    const stored = await model.findOne({ _id: /^rt-first:/ }).lean();
    expect((stored as { lock?: unknown } | null)?.lock).toBeUndefined();
    expect((stored as { result?: { statusCode?: number } } | null)?.result?.statusCode).toBe(200);
    await app.close();
  });

  it("the step protocol (a store without acquire) costs five — the number this replaces", async () => {
    const store = repositoryAsIdempotencyStore(countingRepository(), 60_000);
    (store as { acquire?: unknown }).acquire = undefined;
    (store as { completionReleasesLock?: boolean }).completionReleasesLock = false;
    const app = await boot(store);
    expect((await send(app, "rt-steps")).statusCode).toBe(200);
    expect(calls).toBe(5);
    await app.close();
  });

  it("replays a completed key and refuses a changed body", async () => {
    const app = await boot(repositoryAsIdempotencyStore(countingRepository(), 60_000));
    await send(app, "rt-replay");
    const replay = await send(app, "rt-replay");
    expect(replay.headers["x-idempotency-replayed"]).toBe("true");
    expect(replay.json()).toEqual({ effects: 1 });
    expect((await send(app, "rt-replay", { amount: 2 })).statusCode).toBe(422);
    expect(effects).toBe(1);
    await app.close();
  });

  it("answers 409 while the key is in flight", async () => {
    const app = await boot(repositoryAsIdempotencyStore(countingRepository(), 60_000));
    let open = () => {};
    gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const inFlight = send(app, "rt-busy");
    while (effects === 0) await new Promise((r) => setTimeout(r, 5));
    const second = await send(app, "rt-busy");
    expect(second.statusCode).toBe(409);
    open();
    expect((await inFlight).statusCode).toBe(200);
    expect(effects).toBe(1);
    await app.close();
  });

  it("a failed call releases the lock and the retry executes", async () => {
    const app = await boot(repositoryAsIdempotencyStore(countingRepository(), 60_000));
    expect((await send(app, "rt-fail", { fail: true })).statusCode).toBe(400);
    expect(calls).toBe(2);
    expect((await send(app, "rt-fail", { fail: true })).statusCode).toBe(400);
    expect(effects).toBe(2);
    await app.close();
  });

  it("takes over an expired lease and re-executes after an expired result", async () => {
    const store = repositoryAsIdempotencyStore(countingRepository(), 60_000);
    expect((await store.acquire?.("rt-lease", "old", 30_000))?.status).toBe("acquired");
    await model.updateOne({ _id: "rt-lease" }, { $set: { "lock.expiresAt": new Date(Date.now() - 1) } });
    expect((await store.acquire?.("rt-lease", "new", 30_000))?.status).toBe("acquired");
    expect(await store.setIfLocked?.("rt-lease", "old", { statusCode: 200, headers: {}, body: 1, createdAt: new Date(), expiresAt: new Date(Date.now() + 60_000) })).toBe(false);
    expect(await store.setIfLocked?.("rt-lease", "new", { statusCode: 200, headers: {}, body: 2, createdAt: new Date(), expiresAt: new Date(Date.now() + 60_000) })).toBe(true);
    const done = await store.acquire?.("rt-lease", "third", 30_000);
    expect(done?.status === "completed" && done.result.body).toBe(2);
    await model.updateOne({ _id: "rt-lease" }, { $set: { expiresAt: new Date(Date.now() - 1) } });
    expect((await store.acquire?.("rt-lease", "fourth", 30_000))?.status).toBe("acquired");
    expect(await store.get("rt-lease")).toBeUndefined();
  });
});
