/**
 * Security Tests: Webhook Signature — Raw-Body Enforcement
 *
 * The most common verification footgun is passing `req.body` (a parsed
 * object) instead of `req.rawBody` (the bytes the sender signed). Fastify
 * re-serialises JSON, so the HMAC never matches and every request looks
 * like a wrong secret.
 *
 * `verifySignature` now throws TypeError when the body is neither string
 * nor Buffer so the misuse surfaces at the call site rather than as a
 * silent 401 loop in production.
 */

import { describe, expect, it } from "vitest";
import { signPayload, verifySignature } from "../../src/integrations/webhooks.js";

describe("Security: Webhook signature raw-body enforcement", () => {
  const secret = "whsec_test";
  const payload = JSON.stringify({ id: "evt_1", type: "order.created" });
  const signature = signPayload(payload, secret);

  it("accepts a string body", () => {
    expect(verifySignature(payload, secret, signature)).toBe(true);
  });

  it("accepts a Buffer body", () => {
    expect(verifySignature(Buffer.from(payload), secret, signature)).toBe(true);
  });

  it("throws when a parsed object is passed", () => {
    const parsed = JSON.parse(payload) as unknown;
    expect(() => verifySignature(parsed as unknown as string, secret, signature)).toThrow(
      TypeError,
    );
  });

  it("throws when null is passed", () => {
    expect(() => verifySignature(null as unknown as string, secret, signature)).toThrow(TypeError);
  });

  it("throws when undefined is passed", () => {
    expect(() => verifySignature(undefined as unknown as string, secret, signature)).toThrow(
      TypeError,
    );
  });

  it("returns false for a tampered payload (string body)", () => {
    expect(verifySignature(`${payload} `, secret, signature)).toBe(false);
  });

  it("returns false when signature header is missing", () => {
    expect(verifySignature(payload, secret, undefined)).toBe(false);
  });
});
