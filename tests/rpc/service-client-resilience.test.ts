/**
 * Service Client — Resilience & Observability Tests
 *
 * Tests the microservice-critical features:
 * 1. correlationId propagation across service calls
 * 2. Retry with backoff for transient failures
 * 3. Error normalization from remote services
 * 4. Request/response logging hooks
 */

import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServiceClient } from "../../src/rpc/serviceClient.js";

// ============================================================================
// Test server
// ============================================================================

let server: FastifyInstance;
let baseUrl: string;
let requestLog: Array<{ method: string; url: string; headers: Record<string, string> }>;

beforeEach(async () => {
  requestLog = [];
  server = Fastify({ logger: false });

  // Log all incoming requests for assertion
  server.addHook("onRequest", async (req) => {
    requestLog.push({
      method: req.method,
      url: req.url,
      headers: req.headers as Record<string, string>,
    });
  });

  // Normal endpoint
  server.get("/products", async () => ({
    success: true,
    data: { docs: [{ _id: "p1", name: "Widget" }], total: 1 },
  }));

  // Flaky endpoint — fails N times then succeeds
  let flakyCallCount = 0;
  server.get("/flaky/products", async (_req, reply) => {
    flakyCallCount++;
    if (flakyCallCount <= 2) {
      return reply.code(503).send({ success: false, error: "Service Unavailable" });
    }
    return { success: true, data: { docs: [], total: 0 } };
  });

  // Always-failing endpoint
  server.get("/broken/products", async (_req, reply) => {
    return reply.code(500).send({
      success: false,
      error: "Internal Server Error",
      message: "Database connection lost",
    });
  });

  // Error with non-JSON response
  server.get("/html-error/products", async (_req, reply) => {
    return reply.code(502).type("text/html").send("<h1>Bad Gateway</h1>");
  });

  server.get("/_health/live", async () => ({ status: "ok" }));

  const addr = await server.listen({ port: 0, host: "127.0.0.1" });
  baseUrl = addr;
});

afterEach(async () => {
  if (server) await server.close();
});

// ============================================================================
// correlationId propagation
// ============================================================================

describe("ServiceClient — correlationId propagation", () => {
  it("should forward x-request-id header when provided", async () => {
    const client = createServiceClient({
      baseUrl,
      correlationId: "req-abc-123",
    });

    await client.resource("product").list();

    expect(requestLog[0]?.headers["x-request-id"]).toBe("req-abc-123");
  });

  it("should forward dynamic correlationId from function", async () => {
    let count = 0;
    const client = createServiceClient({
      baseUrl,
      correlationId: () => `trace-${++count}`,
    });

    await client.resource("product").list();
    await client.resource("product").list();

    expect(requestLog[0]?.headers["x-request-id"]).toBe("trace-1");
    expect(requestLog[1]?.headers["x-request-id"]).toBe("trace-2");
  });

  it("should not send x-request-id when correlationId is not set", async () => {
    const client = createServiceClient({ baseUrl });

    await client.resource("product").list();

    expect(requestLog[0]?.headers["x-request-id"]).toBeUndefined();
  });
});

// ============================================================================
// Retry with backoff
// ============================================================================

describe("ServiceClient — retry", () => {
  it("should retry on 503 and succeed after transient failures", async () => {
    // Flaky endpoint fails 2 times then succeeds on 3rd
    const client = createServiceClient({
      baseUrl,
      retry: { maxRetries: 3, backoffMs: 50 },
    });

    const result = await client.call("GET", "/flaky/products");

    expect(result.success).toBe(true);
  });

  it("should exhaust retries and return last error", async () => {
    const client = createServiceClient({
      baseUrl,
      retry: { maxRetries: 2, backoffMs: 10 },
    });

    const result = await client.call("GET", "/broken/products");

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("should not retry on 4xx errors (client errors are not transient)", async () => {
    // GET a non-existent product (returns 404 from our mock that returns success:false)
    const client = createServiceClient({
      baseUrl,
      retry: { maxRetries: 3, backoffMs: 10 },
    });

    const result = await client.resource("product").get("nonexistent-id-xyz");

    // Should NOT retry — only 1 request made (4xx is not retryable)
    const requests = requestLog.filter((r) => r.url.includes("nonexistent-id-xyz"));
    expect(requests).toHaveLength(1);
    expect(result.success).toBe(false);
  });

  it("should not retry when retry is not configured", async () => {
    const client = createServiceClient({ baseUrl });

    const result = await client.call("GET", "/broken/products");

    expect(result.success).toBe(false);
    const brokenRequests = requestLog.filter((r) => r.url === "/broken/products");
    expect(brokenRequests).toHaveLength(1);
  });
});

// ============================================================================
// Error normalization
// ============================================================================

describe("ServiceClient — error normalization", () => {
  it("should normalize JSON error responses", async () => {
    const client = createServiceClient({ baseUrl });
    const result = await client.call("GET", "/broken/products");

    expect(result.success).toBe(false);
    expect(result.error).toBe("Internal Server Error");
    expect(result.status).toBe(500);
  });

  it("should handle non-JSON error responses gracefully", async () => {
    const client = createServiceClient({ baseUrl });
    const result = await client.call("GET", "/html-error/products");

    expect(result.success).toBe(false);
    expect(result.status).toBe(502);
    // Should not throw — non-JSON is normalized to a generic error
    expect(result.error).toBeDefined();
  });

  it("should handle network errors", async () => {
    const client = createServiceClient({
      baseUrl: "http://127.0.0.1:19999", // valid port, nothing listening
      timeout: 500,
      retry: { maxRetries: 1, backoffMs: 10 }, // retry normalizes errors instead of throwing
    });

    const result = await client.call("GET", "/products");

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.status).toBe(0); // network error = no HTTP status
  });
});

// ============================================================================
// onRequest / onResponse hooks
// ============================================================================

describe("ServiceClient — lifecycle hooks", () => {
  it("should call onRequest before each request", async () => {
    const onRequest = vi.fn();
    const client = createServiceClient({ baseUrl, onRequest });

    await client.resource("product").list();

    expect(onRequest).toHaveBeenCalledOnce();
    expect(onRequest.mock.calls[0]?.[0]).toMatchObject({
      method: "GET",
      url: expect.stringContaining("/products"),
    });
  });

  it("should call onResponse after each response", async () => {
    const onResponse = vi.fn();
    const client = createServiceClient({ baseUrl, onResponse });

    await client.resource("product").list();

    expect(onResponse).toHaveBeenCalledOnce();
    expect(onResponse.mock.calls[0]?.[0]).toMatchObject({
      method: "GET",
      url: expect.stringContaining("/products"),
      status: 200,
      durationMs: expect.any(Number),
    });
  });

  it("should call onResponse even on errors", async () => {
    const onResponse = vi.fn();
    const client = createServiceClient({ baseUrl, onResponse });

    await client.call("GET", "/broken/products");

    expect(onResponse).toHaveBeenCalledOnce();
    expect(onResponse.mock.calls[0]?.[0].status).toBe(500);
  });
});
