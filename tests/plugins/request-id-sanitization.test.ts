/**
 * Request ID Sanitization Tests
 *
 * Verifies that the requestId plugin validates incoming x-request-id headers:
 * - Accepts valid IDs (alphanumeric, dashes, underscores, dots, colons)
 * - Rejects IDs exceeding 128 characters
 * - Rejects IDs with unsafe characters (newlines, spaces, special chars)
 * - Falls back to generated UUID on rejection
 * - Preserves valid incoming IDs
 */

import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { requestIdPlugin } from "../../src/plugins/requestId.js";

describe("Request ID Sanitization", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app?.close().catch(() => {});
  });

  async function createApp(opts = {}) {
    app = Fastify({ logger: false });
    await app.register(requestIdPlugin, opts);

    app.get("/test", async (request) => {
      return { requestId: request.requestId };
    });

    await app.ready();
    return app;
  }

  // --------------------------------------------------------------------------
  // Valid IDs — should be preserved
  // --------------------------------------------------------------------------

  describe("valid incoming IDs", () => {
    it("should accept a standard UUID", async () => {
      await createApp();
      const res = await app.inject({
        method: "GET",
        url: "/test",
        headers: { "x-request-id": "550e8400-e29b-41d4-a716-446655440000" },
      });

      const body = JSON.parse(res.body);
      expect(body.requestId).toBe("550e8400-e29b-41d4-a716-446655440000");
    });

    it("should accept alphanumeric ID with dashes and underscores", async () => {
      await createApp();
      const res = await app.inject({
        method: "GET",
        url: "/test",
        headers: { "x-request-id": "req_abc-123_def" },
      });

      const body = JSON.parse(res.body);
      expect(body.requestId).toBe("req_abc-123_def");
    });

    it("should accept ID with dots (e.g., trace IDs)", async () => {
      await createApp();
      const res = await app.inject({
        method: "GET",
        url: "/test",
        headers: { "x-request-id": "trace.span.123" },
      });

      const body = JSON.parse(res.body);
      expect(body.requestId).toBe("trace.span.123");
    });

    it("should accept ID with colons (e.g., structured IDs)", async () => {
      await createApp();
      const res = await app.inject({
        method: "GET",
        url: "/test",
        headers: { "x-request-id": "service:region:abc123" },
      });

      const body = JSON.parse(res.body);
      expect(body.requestId).toBe("service:region:abc123");
    });

    it("should accept ID at exactly 128 characters", async () => {
      const id128 = "a".repeat(128);
      await createApp();
      const res = await app.inject({
        method: "GET",
        url: "/test",
        headers: { "x-request-id": id128 },
      });

      const body = JSON.parse(res.body);
      expect(body.requestId).toBe(id128);
    });

    it("should trim whitespace from valid IDs", async () => {
      await createApp();
      const res = await app.inject({
        method: "GET",
        url: "/test",
        headers: { "x-request-id": "  valid-id-123  " },
      });

      const body = JSON.parse(res.body);
      expect(body.requestId).toBe("valid-id-123");
    });
  });

  // --------------------------------------------------------------------------
  // Invalid IDs — should fall back to generated UUID
  // --------------------------------------------------------------------------

  describe("invalid incoming IDs (rejected, UUID generated)", () => {
    it("should reject ID exceeding 128 characters", async () => {
      const longId = "a".repeat(129);
      await createApp();
      const res = await app.inject({
        method: "GET",
        url: "/test",
        headers: { "x-request-id": longId },
      });

      const body = JSON.parse(res.body);
      expect(body.requestId).not.toBe(longId);
      // Should be a UUID (36 chars with dashes)
      expect(body.requestId).toMatch(/^[\w-]{36}$/);
    });

    it("should reject ID with newline characters (log injection)", async () => {
      await createApp();
      const res = await app.inject({
        method: "GET",
        url: "/test",
        headers: { "x-request-id": "valid-start\ninjected-log-line" },
      });

      const body = JSON.parse(res.body);
      expect(body.requestId).not.toContain("\n");
      expect(body.requestId).toMatch(/^[\w.:-]+$/);
    });

    it("should reject ID with carriage return (header injection)", async () => {
      await createApp();
      const res = await app.inject({
        method: "GET",
        url: "/test",
        headers: { "x-request-id": "valid-start\r\nX-Injected: true" },
      });

      const body = JSON.parse(res.body);
      expect(body.requestId).not.toContain("\r");
    });

    it("should reject ID with spaces", async () => {
      await createApp();
      const res = await app.inject({
        method: "GET",
        url: "/test",
        headers: { "x-request-id": "id with spaces" },
      });

      const body = JSON.parse(res.body);
      // Spaces are not in [\w.:-], so this should be rejected
      expect(body.requestId).not.toBe("id with spaces");
    });

    it("should reject ID with HTML/script characters", async () => {
      await createApp();
      const res = await app.inject({
        method: "GET",
        url: "/test",
        headers: { "x-request-id": "<script>alert(1)</script>" },
      });

      const body = JSON.parse(res.body);
      expect(body.requestId).not.toContain("<");
      expect(body.requestId).not.toContain(">");
    });

    it("should reject empty string after trimming", async () => {
      await createApp();
      const res = await app.inject({
        method: "GET",
        url: "/test",
        headers: { "x-request-id": "   " },
      });

      const body = JSON.parse(res.body);
      // Should get a generated UUID, not empty string
      expect(body.requestId.length).toBeGreaterThan(0);
      expect(body.requestId).toMatch(/^[\w-]{36}$/);
    });

    it("should reject ID with null bytes", async () => {
      await createApp();
      const res = await app.inject({
        method: "GET",
        url: "/test",
        headers: { "x-request-id": "valid\0injected" },
      });

      const body = JSON.parse(res.body);
      expect(body.requestId).not.toContain("\0");
    });

    it("should reject ID with semicolons (potential log format attacks)", async () => {
      await createApp();
      const res = await app.inject({
        method: "GET",
        url: "/test",
        headers: { "x-request-id": "id;DROP TABLE users" },
      });

      const body = JSON.parse(res.body);
      expect(body.requestId).not.toContain(";");
    });
  });

  // --------------------------------------------------------------------------
  // No incoming ID — should generate
  // --------------------------------------------------------------------------

  describe("missing incoming ID", () => {
    it("should generate UUID when no x-request-id header present", async () => {
      await createApp();
      const res = await app.inject({ method: "GET", url: "/test" });

      const body = JSON.parse(res.body);
      expect(body.requestId).toBeDefined();
      expect(body.requestId.length).toBeGreaterThan(0);
    });

    it("should use custom generator when provided", async () => {
      let counter = 0;
      await createApp({ generator: () => `custom-${++counter}` });

      const res = await app.inject({ method: "GET", url: "/test" });
      const body = JSON.parse(res.body);
      expect(body.requestId).toBe("custom-1");
    });
  });

  // --------------------------------------------------------------------------
  // Response header propagation
  // --------------------------------------------------------------------------

  describe("response header", () => {
    it("should set sanitized ID in response header", async () => {
      await createApp();
      const res = await app.inject({
        method: "GET",
        url: "/test",
        headers: { "x-request-id": "clean-id-123" },
      });

      expect(res.headers["x-request-id"]).toBe("clean-id-123");
    });

    it("should set generated ID in response header when incoming is rejected", async () => {
      await createApp();
      const res = await app.inject({
        method: "GET",
        url: "/test",
        headers: { "x-request-id": "<injected>" },
      });

      // Should be a generated UUID, not the injected value
      expect(res.headers["x-request-id"]).not.toContain("<");
      expect(res.headers["x-request-id"]).toMatch(/^[\w-]{36}$/);
    });
  });
});
