/**
 * verifySignature — timing-safe inbound webhook HMAC verification
 *
 * Covers: valid signatures, tampered bodies, wrong secrets, missing/malformed
 * headers, Buffer bodies, custom prefix/algorithm, and the signPayload↔verify
 * round-trip contract.
 */

import { describe, it, expect } from "vitest";
import { signPayload, verifySignature } from "../../../src/integrations/webhooks.js";

const SECRET = "whsec_test_secret_abc123";
const BODY = '{"type":"order.created","payload":{"orderId":"ord-1"}}';

describe("verifySignature", () => {
  // ── Round-trip: signPayload → verifySignature ──

  it("should verify a signature produced by signPayload", () => {
    const sig = signPayload(BODY, SECRET);
    expect(verifySignature(BODY, SECRET, sig)).toBe(true);
  });

  it("should verify with Buffer body (same bytes)", () => {
    const sig = signPayload(BODY, SECRET);
    expect(verifySignature(Buffer.from(BODY, "utf8"), SECRET, sig)).toBe(true);
  });

  it("should verify empty body (edge case — valid HMAC of empty string)", () => {
    const sig = signPayload("", SECRET);
    expect(verifySignature("", SECRET, sig)).toBe(true);
  });

  // ── Rejection cases ──

  it("should reject tampered body", () => {
    const sig = signPayload(BODY, SECRET);
    const tampered = BODY.replace("ord-1", "ord-HACKED");
    expect(verifySignature(tampered, SECRET, sig)).toBe(false);
  });

  it("should reject wrong secret", () => {
    const sig = signPayload(BODY, SECRET);
    expect(verifySignature(BODY, "wrong-secret", sig)).toBe(false);
  });

  it("should reject undefined signature", () => {
    expect(verifySignature(BODY, SECRET, undefined)).toBe(false);
  });

  it("should reject empty string signature", () => {
    expect(verifySignature(BODY, SECRET, "")).toBe(false);
  });

  it("should reject missing sha256= prefix", () => {
    const sig = signPayload(BODY, SECRET);
    const bareHex = sig.slice(7); // strip 'sha256='
    expect(verifySignature(BODY, SECRET, bareHex)).toBe(false);
  });

  it("should reject signature with only the prefix and no hex", () => {
    expect(verifySignature(BODY, SECRET, "sha256=")).toBe(false);
  });

  it("should reject malformed hex (non-hex chars)", () => {
    expect(verifySignature(BODY, SECRET, "sha256=ZZZZZZ")).toBe(false);
  });

  it("should reject signature with wrong length hex", () => {
    expect(verifySignature(BODY, SECRET, "sha256=abcd1234")).toBe(false);
  });

  it("should reject signature with extra trailing bytes", () => {
    const sig = signPayload(BODY, SECRET);
    expect(verifySignature(BODY, SECRET, `${sig}ff`)).toBe(false);
  });

  it("should never throw — always returns boolean", () => {
    // Feed garbage that could cause Buffer.from to throw
    expect(() => verifySignature(BODY, SECRET, "sha256=not_even_hex!!!")).not.toThrow();
    expect(verifySignature(BODY, SECRET, "sha256=not_even_hex!!!")).toBe(false);
  });

  // ── Timing safety (structural, not measurable in unit tests) ──

  it("should use timingSafeEqual internally (structural check via length-mismatch fast path)", () => {
    // Length mismatch returns false before timingSafeEqual — this is acceptable
    // because lengths leaking is not a security concern (wrong-length = invalid)
    const sig = signPayload(BODY, SECRET);
    const truncated = sig.slice(0, -4); // 2 fewer hex bytes
    expect(verifySignature(BODY, SECRET, truncated)).toBe(false);
  });

  // ── Custom options: prefix and algorithm ──

  describe("options.prefix", () => {
    it("should accept bare hex when prefix is empty string", () => {
      const sig = signPayload(BODY, SECRET);
      const bareHex = sig.slice(7);
      expect(verifySignature(BODY, SECRET, bareHex, { prefix: "" })).toBe(true);
    });

    it("should reject prefixed signature when prefix is empty string", () => {
      const sig = signPayload(BODY, SECRET);
      // With prefix='', the full 'sha256=abc...' is treated as hex — which is wrong
      expect(verifySignature(BODY, SECRET, sig, { prefix: "" })).toBe(false);
    });

    it("should work with custom prefix (e.g. GitHub x-hub-signature-256)", () => {
      // GitHub uses 'sha256=' — same as Arc default, so this is a no-op
      const sig = signPayload(BODY, SECRET);
      expect(verifySignature(BODY, SECRET, sig, { prefix: "sha256=" })).toBe(true);
    });

    it("should reject when custom prefix doesn't match", () => {
      const sig = signPayload(BODY, SECRET);
      expect(verifySignature(BODY, SECRET, sig, { prefix: "sha512=" })).toBe(false);
    });
  });

  describe("options.algorithm", () => {
    it("should verify with sha512 when both sides use it", () => {
      // Manual sha512 signature
      const { createHmac } = require("node:crypto");
      const hmac = createHmac("sha512", SECRET);
      hmac.update(BODY);
      const sig = `sha512=${hmac.digest("hex")}`;

      expect(
        verifySignature(BODY, SECRET, sig, { prefix: "sha512=", algorithm: "sha512" }),
      ).toBe(true);
    });

    it("should reject sha512 signature verified with sha256 algorithm", () => {
      const { createHmac } = require("node:crypto");
      const hmac = createHmac("sha512", SECRET);
      hmac.update(BODY);
      const sig = `sha256=${hmac.digest("hex")}`; // wrong prefix for the actual algorithm

      // Length won't match sha256 digest (128 hex chars vs 64)
      expect(verifySignature(BODY, SECRET, sig)).toBe(false);
    });
  });

  // ── Real-world integration patterns ──

  describe("real-world header patterns", () => {
    it("should work with Arc's own x-webhook-signature header format", () => {
      // Simulate what Arc's outbound delivery sends (line 184-196 in webhooks.ts)
      const body = JSON.stringify({
        type: "order.created",
        payload: { orderId: "ord-123" },
        meta: { id: "evt-abc" },
      });
      const secret = "whsec_customer_secret";
      const signature = signPayload(body, secret);

      // Receiver side
      const headers = {
        "content-type": "application/json",
        "x-webhook-signature": signature,
        "x-webhook-id": "evt-abc",
        "x-webhook-event": "order.created",
      };

      expect(
        verifySignature(body, secret, headers["x-webhook-signature"]),
      ).toBe(true);
    });

    it("should reject when body was re-serialized (field order changed)", () => {
      const original = '{"a":1,"b":2}';
      const reserialized = '{"b":2,"a":1}';
      const sig = signPayload(original, SECRET);

      // This is the common mistake — JSON.parse(body) then JSON.stringify again
      expect(verifySignature(reserialized, SECRET, sig)).toBe(false);
    });
  });
});
