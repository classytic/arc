/**
 * `config.idempotency.required` — a route whose retry must not execute twice refuses a call
 * with no idempotency key (400), instead of silently running it unprotected.
 */
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { idempotencyPlugin } from "../../src/idempotency/idempotencyPlugin.js";

let app: FastifyInstance;
let runs = 0;

beforeEach(async () => {
  runs = 0;
  app = Fastify({ logger: false });
  await app.register(idempotencyPlugin, { enabled: true, ttlMs: 60_000 });
  app.post(
    "/checkout",
    { config: { idempotency: { required: true } }, preHandler: [app.idempotency.middleware] },
    async () => ({ run: ++runs }),
  );
  app.post("/note", { preHandler: [app.idempotency.middleware] }, async () => ({ run: ++runs }));
  await app.ready();
});
afterEach(async () => {
  await app.close();
});

describe("required idempotency keys", () => {
  it("refuses a keyless call to a route that requires one — the handler never runs", async () => {
    const res = await app.inject({ method: "POST", url: "/checkout", payload: { total: 1 } });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { code?: string }).code).toBe("arc.idempotency_key_required");
    expect(runs).toBe(0);
  });

  it("runs a keyed call once and replays its retry", async () => {
    const call = () =>
      app.inject({ method: "POST", url: "/checkout", headers: { "idempotency-key": "k" }, payload: { total: 1 } });
    expect((await call()).json()).toEqual({ run: 1 });
    expect((await call()).json()).toEqual({ run: 1 });
    expect(runs).toBe(1);
  });

  it("leaves routes that do not declare it optional", async () => {
    const res = await app.inject({ method: "POST", url: "/note", payload: { text: "x" } });
    expect(res.statusCode).toBe(200);
  });
});
