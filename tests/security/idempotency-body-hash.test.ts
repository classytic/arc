/**
 * Security Tests: Idempotency Body Hash
 *
 * Tests that idempotency keys with different request bodies
 * are treated as separate requests (not replayed).
 *
 * CRITICAL: Prevents data corruption from replay attacks.
 */

import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { idempotencyPlugin } from "../../src/idempotency/index.js";

describe("Security: Idempotency Body Hash", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    // Create fresh app for EACH test to avoid cache interference
    app = Fastify({ logger: false });

    // Register idempotency plugin
    await app.register(idempotencyPlugin, {
      enabled: true,
      headerName: "idempotency-key",
      ttlMs: 60000, // 1 minute
    });

    // Test endpoint that returns the request body
    // Wire idempotency.middleware in preHandler (route-level, after auth)
    app.post(
      "/orders",
      {
        preHandler: [app.idempotency.middleware],
      },
      async (request) => {
        const body = request.body as { amount: number; customer: string };
        // No-envelope: return raw payload directly.
        return {
          id: `order-${Math.random()}`, // Use random to avoid timing issues
          amount: body.amount,
          customer: body.customer,
          timestamp: new Date().toISOString(),
        };
      },
    );

    // Complex endpoint for nested objects test
    app.post(
      "/complex",
      {
        preHandler: [app.idempotency.middleware],
      },
      async (request) => {
        // No-envelope: return raw payload directly.
        return request.body;
      },
    );

    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it("should treat same key + same body as replay", async () => {
    const key = "test-replay-same-body";
    const body = { amount: 100, customer: "alice" };

    // First request
    const res1 = await app.inject({
      method: "POST",
      url: "/orders",
      headers: { "idempotency-key": key },
      payload: body,
    });

    expect(res1.statusCode).toBe(200);
    const data1 = JSON.parse(res1.body);
    expect(data1.amount).toBe(100);
    expect(res1.headers["x-idempotency-replayed"]).toBeUndefined();

    // Second request with SAME body - should replay
    const res2 = await app.inject({
      method: "POST",
      url: "/orders",
      headers: { "idempotency-key": key },
      payload: body,
    });

    expect(res2.statusCode).toBe(200);
    const data2 = JSON.parse(res2.body);
    expect(data2.amount).toBe(100);
    expect(data2.id).toBe(data1.id); // Same response
    expect(res2.headers["x-idempotency-replayed"]).toBe("true");
  });

  it("should NOT replay when same key but different body", async () => {
    const key = "test-different-body";

    // First request: $100
    const res1 = await app.inject({
      method: "POST",
      url: "/orders",
      headers: { "idempotency-key": key },
      payload: { amount: 100, customer: "bob" },
    });

    expect(res1.statusCode).toBe(200);
    const data1 = JSON.parse(res1.body);
    expect(data1.amount).toBe(100);
    expect(data1.customer).toBe("bob");
    expect(res1.headers["x-idempotency-replayed"]).toBeUndefined();

    // Second request: $1000 (DIFFERENT BODY)
    const res2 = await app.inject({
      method: "POST",
      url: "/orders",
      headers: { "idempotency-key": key },
      payload: { amount: 1000, customer: "charlie" },
    });

    expect(res2.statusCode).toBe(200);
    const data2 = JSON.parse(res2.body);
    expect(data2.amount).toBe(1000); // NEW response with $1000
    expect(data2.customer).toBe("charlie");
    expect(data2.id).not.toBe(data1.id); // Different order ID
    expect(res2.headers["x-idempotency-replayed"]).toBeUndefined();
  });

  it("should handle empty vs non-empty body as different", async () => {
    const key = "test-empty-body";

    // First request: empty body
    const res1 = await app.inject({
      method: "POST",
      url: "/orders",
      headers: { "idempotency-key": key },
      payload: {},
    });

    expect(res1.statusCode).toBe(200);

    // Second request: non-empty body
    const res2 = await app.inject({
      method: "POST",
      url: "/orders",
      headers: { "idempotency-key": key },
      payload: { amount: 50, customer: "dave" },
    });

    expect(res2.statusCode).toBe(200);
    const data2 = JSON.parse(res2.body);
    expect(data2.amount).toBe(50); // Should NOT replay empty body response
    expect(res2.headers["x-idempotency-replayed"]).toBeUndefined();
  });

  it("should handle different field order as same request", async () => {
    const key = "test-field-order";

    // First request: { amount, customer }
    const res1 = await app.inject({
      method: "POST",
      url: "/orders",
      headers: { "idempotency-key": key },
      payload: { amount: 200, customer: "eve" },
    });

    expect(res1.statusCode).toBe(200);
    const data1 = JSON.parse(res1.body);

    // Second request: { customer, amount } (different order, same content)
    const res2 = await app.inject({
      method: "POST",
      url: "/orders",
      headers: { "idempotency-key": key },
      payload: { customer: "eve", amount: 200 },
    });

    expect(res2.statusCode).toBe(200);
    const data2 = JSON.parse(res2.body);
    expect(data2.id).toBe(data1.id); // Should replay (same content)
    expect(res2.headers["x-idempotency-replayed"]).toBe("true");
  });

  it("should handle nested objects correctly", async () => {
    const key = "test-nested";

    // First request
    const res1 = await app.inject({
      method: "POST",
      url: "/complex",
      headers: { "idempotency-key": key },
      payload: {
        user: { id: 1, name: "test" },
        items: [{ id: 1, qty: 2 }],
      },
    });

    expect(res1.statusCode).toBe(200);

    // Second request with different nested data
    const res2 = await app.inject({
      method: "POST",
      url: "/complex",
      headers: { "idempotency-key": key },
      payload: {
        user: { id: 2, name: "other" },
        items: [{ id: 1, qty: 5 }],
      },
    });

    expect(res2.statusCode).toBe(200);
    const data2 = JSON.parse(res2.body);
    expect(data2.user.id).toBe(2); // Should NOT replay
    expect(data2.items[0].qty).toBe(5);
    expect(res2.headers["x-idempotency-replayed"]).toBeUndefined();
  });
});
