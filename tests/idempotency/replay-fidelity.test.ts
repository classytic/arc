/**
 * A replay returns exactly the bytes the first call served, even when the handler returns a LIVE
 * object its owner keeps mutating (a workflow run, an engine document) after the response.
 */
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { idempotencyPlugin } from "../../src/idempotency/idempotencyPlugin.js";
import type { IdempotencyResult } from "../../src/idempotency/stores/interface.js";
import { MemoryIdempotencyStore } from "../../src/idempotency/stores/memory.js";

interface LiveRun {
  id: string;
  status: string;
  steps: string[];
  [key: string]: unknown;
}

/** A store that persists a deep copy, as Mongo / Redis do, and lets the test act at write time. */
class SerializingStore extends MemoryIdempotencyStore {
  onWrite: (() => void) | undefined;
  override async setIfLocked(
    key: string,
    requestId: string,
    result: Omit<IdempotencyResult, "key">,
  ): Promise<boolean> {
    const persisted = JSON.parse(JSON.stringify(result)) as Omit<IdempotencyResult, "key">;
    this.onWrite?.();
    return super.setIfLocked(key, requestId, persisted);
  }
}

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function boot(store: MemoryIdempotencyStore, live: LiveRun, raw = false) {
  app = Fastify({ logger: false });
  await app.register(idempotencyPlugin, { enabled: true, ttlMs: 60_000, store });
  const start = (): LiveRun => live;
  if (raw) {
    app.post("/start", { preHandler: [app.idempotency.middleware] }, async (_req, reply) =>
      reply.code(201).send(start()),
    );
  } else {
    app.post("/start", { preHandler: [app.idempotency.middleware] }, async (_req, reply) => {
      reply.code(201);
      return start();
    });
  }
  return app;
}

const call = (a: FastifyInstance) =>
  a.inject({ method: "POST", url: "/start", headers: { "idempotency-key": "k-1" }, payload: {} });

describe("idempotency replay fidelity — the replay is the served bytes", () => {
  for (const raw of [false, true]) {
    const kind = raw ? "reply.send" : "returned";
    it(`${kind}: a live object mutated AFTER the response does not change the replay`, async () => {
      const live: LiveRun = { id: "run-1", status: "running", steps: ["start"] };
      const a = await boot(new MemoryIdempotencyStore(), live, raw);
      const first = await call(a);
      expect(first.statusCode).toBe(201);
      // The engine keeps working on the run it handed back.
      live.status = "completed";
      live.steps.push("finish");
      live.finishedAt = "2026-10-11T00:00:00.000Z";
      const replay = await call(a);
      expect(replay.headers["x-idempotency-replayed"]).toBe("true");
      expect(replay.statusCode).toBe(201);
      expect(replay.body).toBe(first.body);
      expect(replay.headers["content-type"]).toBe(first.headers["content-type"]);
    });

    it(`${kind}: a live object mutated WHILE the completion is written does not change the replay`, async () => {
      const live: LiveRun = { id: "run-1", status: "running", steps: ["start"] };
      const store = new SerializingStore();
      store.onWrite = () => {
        live.status = "step-2";
        live.extra = true;
      };
      const a = await boot(store, live, raw);
      const first = await call(a);
      store.onWrite = undefined;
      const replay = await call(a);
      expect(replay.headers["x-idempotency-replayed"]).toBe("true");
      expect(replay.body).toBe(first.body);
    });
  }
});
