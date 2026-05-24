/**
 * Idempotency body-fingerprinting — deep-nesting DoS defense.
 *
 * Fastify's default `bodyLimit` (1 MiB) bounds total payload size, but a 1 MiB
 * payload shaped as `{"a":{"a":{...}}}` still nests ~250K levels deep — enough
 * to blow V8's call stack inside `normalizeBody`. Pre-fix, that landed as an
 * unhandled `RangeError: Maximum call stack size exceeded` in the idempotency
 * preHandler, killing the worker mid-request.
 *
 * Post-fix, `normalizeBody` caps recursion at MAX_FINGERPRINT_DEPTH (32) and
 * substitutes `"<truncated>"` for content past the cap. The request still gets
 * a stable fingerprint; the attacker just can't crash the process.
 */
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { idempotencyPlugin } from "../../src/idempotency/idempotencyPlugin.js";

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 1024 * 1024 });
  await app.register(idempotencyPlugin, { enabled: true, ttlMs: 60_000 });
  app.addHook("preHandler", async (req) => {
    (req as Record<string, unknown>).user = { id: "u1", _id: "u1" };
  });
  app.post("/echo", async (req) => ({ ok: true, depth: depthOf(req.body) }));
  await app.ready();
  return app;
}

function nestedObject(depth: number): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  let node = root;
  for (let i = 0; i < depth; i++) {
    const next: Record<string, unknown> = {};
    node.a = next;
    node = next;
  }
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

describe("idempotency fingerprint — deep-nesting DoS defense", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildApp();
  });
  afterEach(async () => {
    await app.close();
  });

  it("handles a 1000-deep nested body without stack overflow", async () => {
    const body = nestedObject(1000);
    const res = await app.inject({
      method: "POST",
      url: "/echo",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "depth-bomb-1000",
      },
      payload: body,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, depth: 1000 });
  });
});
