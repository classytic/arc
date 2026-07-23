/**
 * Idempotency body fingerprinting — depth-cap safety + content sensitivity.
 *
 * Invariants:
 *  1. DoS defense — a deeply nested body (`{"a":{"a":{...}}}`, ~250K levels
 *     inside Fastify's 1 MiB bodyLimit) must not blow V8's call stack in
 *     `normalizeBody`; recursion caps at MAX_FINGERPRINT_DEPTH (32) with a
 *     content hash substituted past the cap.
 *  2. No false replay — the store key is `key:fingerprint`, so two
 *     DIFFERENT over-deep bodies under one idempotency key must fingerprint
 *     differently (each executes as its own operation); a shared sentinel
 *     past the cap would replay the FIRST request's cached response for the
 *     second body. Identical deep bodies still replay normally.
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
  it("handles a 1000-deep nested body without stack overflow", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/orders",
      headers: { "content-type": "application/json", "idempotency-key": "depth-bomb-1000" },
      payload: deepBody(1000),
    });
    expect(res.statusCode).toBe(200);
    const parsed = res.json() as { ok: boolean };
    expect(parsed.ok).toBe(true);
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

describe("content beyond the depth cap", () => {
  it("different over-deep bodies under the same key do NOT false-replay each other", async () => {
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
      payload: deepBody(40, "payment-b"), // differs ONLY beyond depth 32
    });
    // Distinct fingerprint → its own operation, not a replay of request one.
    expect(second.statusCode).toBe(200);
    expect(second.headers["x-idempotency-replayed"]).toBeUndefined();
    expect(second.json()).toEqual({ ok: true, n: 2 });
  });

  it("identical over-deep bodies still replay the cached response", async () => {
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
