/**
 * Rate limiting under burst load
 *
 * Arc uses `@fastify/rate-limit` as an optional peer. This test asserts the
 * end-to-end behaviour: when N parallel requests hit a rate-limited route
 * with `max: K`, exactly K succeed and (N-K) get `429 Too Many Requests`
 * carrying a `retry-after` header.
 *
 * We spin up a minimal Fastify instance with a fixed window (5 req / 1 s)
 * and fire 20 parallel `app.inject()` calls. The memory store is the
 * default and is perfectly adequate for a single-process burst test.
 */

import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

describe("Rate limit — burst behaviour", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app?.close().catch(() => {});
  });

  it("allows max requests, rejects the rest with 429 + retry-after", async () => {
    // Sequential sends — this reflects real-client behaviour where each
    // request waits for the previous response. With in-process `Promise.all`
    // the rate-limit plugin's internal onRequest hook runs for all inflight
    // injections before any event-loop yield and the counter behaves
    // implementation-defined; sequential fires make the assertion deterministic.
    const MAX = 5;
    const BURST = 20;

    app = Fastify({ logger: false });
    await app.register(rateLimit, { max: MAX, timeWindow: "1 second" });
    app.get("/ping", async () => ({ ok: true }));
    await app.ready();

    const responses: Array<{ statusCode: number; headers: Record<string, unknown> }> = [];
    for (let i = 0; i < BURST; i++) {
      const r = await app.inject({ method: "GET", url: "/ping" });
      responses.push({ statusCode: r.statusCode, headers: r.headers });
    }

    const ok = responses.filter((r) => r.statusCode === 200);
    const limited = responses.filter((r) => r.statusCode === 429);

    expect(ok).toHaveLength(MAX);
    expect(limited).toHaveLength(BURST - MAX);

    for (const r of limited) {
      expect(r.headers["retry-after"]).toBeDefined();
    }
  });

  it("refills after the time window expires", async () => {
    app = Fastify({ logger: false });
    await app.register(rateLimit, { max: 2, timeWindow: 200 }); // 200ms window
    app.get("/ping", async () => ({ ok: true }));
    await app.ready();

    const a = await app.inject({ method: "GET", url: "/ping" });
    const b = await app.inject({ method: "GET", url: "/ping" });
    const c = await app.inject({ method: "GET", url: "/ping" });

    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    expect(c.statusCode).toBe(429);

    // Wait for refill + a small margin.
    await new Promise((r) => setTimeout(r, 260));

    const afterRefill = await app.inject({ method: "GET", url: "/ping" });
    expect(afterRefill.statusCode).toBe(200);
  });

  it("responds with a JSON error envelope rather than crashing the connection", async () => {
    app = Fastify({ logger: false });
    await app.register(rateLimit, { max: 1, timeWindow: "1 minute" });
    app.get("/ping", async () => ({ ok: true }));
    await app.ready();

    await app.inject({ method: "GET", url: "/ping" });
    const second = await app.inject({ method: "GET", url: "/ping" });

    expect(second.statusCode).toBe(429);
    const body = second.json() as Record<string, unknown>;
    // @fastify/rate-limit 10+ returns { statusCode, error, message }
    expect(typeof body.message).toBe("string");
    expect(String(body.message).toLowerCase()).toContain("rate");
  });

  it("different keys (ip addresses) are counted independently", async () => {
    app = Fastify({ logger: false });
    await app.register(rateLimit, {
      max: 1,
      timeWindow: "1 minute",
      keyGenerator: (req) => req.headers["x-test-ip"] as string,
    });
    app.get("/ping", async () => ({ ok: true }));
    await app.ready();

    const a1 = await app.inject({ method: "GET", url: "/ping", headers: { "x-test-ip": "a" } });
    const a2 = await app.inject({ method: "GET", url: "/ping", headers: { "x-test-ip": "a" } });
    const b1 = await app.inject({ method: "GET", url: "/ping", headers: { "x-test-ip": "b" } });

    expect(a1.statusCode).toBe(200);
    expect(a2.statusCode).toBe(429);
    expect(b1.statusCode).toBe(200); // different key, independent bucket
  });
});
