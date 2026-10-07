/**
 * Idempotency body fingerprinting (`fingerprintRequest`, @classytic/primitives).
 *
 *  1. A keyed body nested past 100 levels is REFUSED (400) before the handler runs — never a
 *     stack overflow, never a truncated fingerprint that could match another body.
 *  2. Content is compared exactly at any allowed depth: a difference 40 levels down is the
 *     same key reused (422), and identical deep bodies replay.
 */

import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { idempotencyPlugin } from "../../src/idempotency/idempotencyPlugin.js";

let app: FastifyInstance;
let counter = 0;

async function buildApp(): Promise<FastifyInstance> {
  const instance = Fastify({ logger: false, bodyLimit: 1024 * 1024 });
  await instance.register(idempotencyPlugin, { enabled: true, ttlMs: 60_000 });
  instance.addHook("preHandler", async (req) => {
    (req as Record<string, unknown>).user = { id: "u1", _id: "u1" };
  });
  instance.post("/orders", { preHandler: [instance.idempotency.middleware] }, async () => ({
    ok: true,
    n: ++counter,
  }));
  await instance.ready();
  return instance;
}

/** Nested object `depth` levels deep, with an optional distinguishing leaf. */
function deepBody(depth: number, leaf?: unknown): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  let node = root;
  for (let i = 0; i < depth; i++) {
    const next: Record<string, unknown> = {};
    node.a = next;
    node = next;
  }
  if (leaf !== undefined) node.leaf = leaf;
  return root;
}

function depthOf(body: unknown): number {
  let depth = 0;
  let cur: unknown = body;
  while (cur && typeof cur === "object" && !Array.isArray(cur) && "a" in (cur as object)) {
    depth++;
    cur = (cur as Record<string, unknown>).a;
  }
  return depth;
}

beforeEach(async () => {
  counter = 0;
  app = await buildApp();
});
afterEach(async () => {
  await app?.close();
});

describe("depth-cap DoS defense", () => {
  it("refuses a keyed 1000-deep body with 400 — no stack overflow, handler never runs", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/orders",
      headers: { "content-type": "application/json", "idempotency-key": "depth-bomb-1000" },
      payload: deepBody(1000),
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { code?: string }).code).toBe("arc.idempotency_body_unfingerprintable");
    expect(counter).toBe(0);
  });

  it("an UNKEYED deep body is not fingerprinted at all", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/orders",
      headers: { "content-type": "application/json" },
      payload: deepBody(1000),
    });
    expect(res.statusCode).toBe(200);
  });

  it("round-trips the deep body itself intact", async () => {
    const instance = Fastify({ logger: false, bodyLimit: 1024 * 1024 });
    instance.post("/echo", async (req) => ({ depth: depthOf(req.body) }));
    await instance.ready();
    const res = await instance.inject({
      method: "POST",
      url: "/echo",
      headers: { "content-type": "application/json" },
      payload: deepBody(1000),
    });
    expect(res.json()).toEqual({ depth: 1000 });
    await instance.close();
  });
});

describe("content at depth", () => {
  it("a difference 40 levels deep is the key REUSED — refused, not replayed, not re-run", async () => {
    const first = await app.inject({
      method: "POST",
      url: "/orders",
      headers: { "content-type": "application/json", "idempotency-key": "k-deep" },
      payload: deepBody(40, "payment-a"),
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ ok: true, n: 1 });

    const second = await app.inject({
      method: "POST",
      url: "/orders",
      headers: { "content-type": "application/json", "idempotency-key": "k-deep" },
      payload: deepBody(40, "payment-b"), // differs only at the leaf
    });
    expect(second.statusCode).toBe(422);
    expect(second.headers["x-idempotency-replayed"]).toBeUndefined();
    expect(counter).toBe(1);
  });

  it("identical deep bodies replay the cached response", async () => {
    const payload = deepBody(40, "same");
    const first = await app.inject({
      method: "POST",
      url: "/orders",
      headers: { "content-type": "application/json", "idempotency-key": "k-replay" },
      payload,
    });
    const second = await app.inject({
      method: "POST",
      url: "/orders",
      headers: { "content-type": "application/json", "idempotency-key": "k-replay" },
      payload,
    });

    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
    expect(counter).toBe(1);
  });
});
