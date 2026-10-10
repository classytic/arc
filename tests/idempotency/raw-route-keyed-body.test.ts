/**
 * A `rawHandler` route built with `handleRaw`, called with an idempotency key, returns its body
 * on the first call and the same body on the replay — and so does a raw handler that calls
 * `reply.send()` itself and returns nothing. The plugin's async `preSerialization`
 * must not lose the body to Fastify re-sending the handler's `undefined` result.
 */

import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { defineResource } from "../../src/core/defineResource.js";
import { idempotencyPlugin } from "../../src/idempotency/idempotencyPlugin.js";
import { allowPublic } from "../../src/permissions/index.js";
import { handleRaw } from "../../src/utils/handleRaw.js";

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function boot(): Promise<FastifyInstance> {
  let runs = 0;
  const resource = defineResource({
    name: "probe",
    prefix: "/probe",
    disableDefaultRoutes: true,
    routes: [
      {
        method: "POST",
        path: "/open",
        permissions: allowPublic(),
        rawHandler: handleRaw(async () => ({ ok: 1, run: ++runs }), 201),
      },
      {
        method: "POST",
        path: "/manual",
        permissions: allowPublic(),
        config: { idempotency: { required: true } },
        // Sends itself and returns nothing — arc must still keep the body.
        rawHandler: async (_req, reply) => {
          reply.code(201).send({ ok: 3, run: ++runs });
        },
      },
      {
        method: "POST",
        path: "/fenced",
        permissions: allowPublic(),
        config: { idempotency: { required: true } },
        rawHandler: handleRaw(async () => ({ ok: 2, run: ++runs }), 201),
      },
    ],
  });
  app = Fastify({ logger: false });
  await app.register(idempotencyPlugin, { enabled: true, ttlMs: 60_000 });
  await app.register(resource.toPlugin());
  await app.ready();
  return app;
}

describe("handleRaw route under idempotency", () => {
  it("keyless keeps its body", async () => {
    const res = await (await boot()).inject({ method: "POST", url: "/probe/open", payload: {} });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ ok: 1, run: 1 });
  });

  for (const url of ["/probe/open", "/probe/fenced", "/probe/manual"]) {
    it(`${url}: keyed call returns its body, and the replay returns the same body`, async () => {
      const server = await boot();
      const call = () =>
        server.inject({ method: "POST", url, headers: { "idempotency-key": "k1" }, payload: {} });
      const first = await call();
      expect(first.statusCode).toBe(201);
      expect(first.body).not.toBe("");
      const body = first.json();
      const replay = await call();
      expect(replay.statusCode).toBe(201);
      expect(replay.headers["x-idempotency-replayed"]).toBe("true");
      expect(replay.json()).toEqual(body);
    });
  }
});
