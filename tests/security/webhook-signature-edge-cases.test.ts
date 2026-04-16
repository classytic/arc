/**
 * Webhook verifySignature — edge-case hardening
 *
 * `verifySignature` uses Node's `crypto.timingSafeEqual`, which THROWS a
 * `RangeError` when the two buffers differ in length. A naive implementation
 * would crash on a truncated / malformed signature — the attacker gets a
 * 500 and learns they can DoS the endpoint by sending short signatures.
 *
 * This suite verifies the helper:
 *   - never throws on malformed input
 *   - returns `false` for every class of bad signature
 *   - still returns `true` for a correctly-computed one
 *
 * Companion to `tests/security/webhook-signature-rawbody.test.ts` which
 * covers the raw-body footgun; this file targets the comparison step.
 */

import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { signPayload, verifySignature } from "../../src/integrations/webhooks.js";

const SECRET = "whsec_test_secret_for_unit_tests_only";
const PAYLOAD = JSON.stringify({ event: "order.created", id: "ord_1" });

function validSig(body: string | Buffer, secret: string = SECRET): string {
  return signPayload(body, secret);
}

describe("verifySignature — edge cases", () => {
  it("returns true for a correct signature (sanity baseline)", () => {
    expect(verifySignature(PAYLOAD, SECRET, validSig(PAYLOAD))).toBe(true);
  });

  it("returns false when signature is undefined", () => {
    expect(() => verifySignature(PAYLOAD, SECRET, undefined)).not.toThrow();
    expect(verifySignature(PAYLOAD, SECRET, undefined)).toBe(false);
  });

  it("returns false for empty string signature", () => {
    expect(verifySignature(PAYLOAD, SECRET, "")).toBe(false);
  });

  it("returns false for signature missing the sha256= prefix", () => {
    const raw = crypto.createHmac("sha256", SECRET).update(PAYLOAD).digest("hex");
    // Send without the `sha256=` prefix verifySignature expects.
    expect(verifySignature(PAYLOAD, SECRET, raw)).toBe(false);
  });

  it("does not throw on truncated signature (timingSafeEqual length guard)", () => {
    const full = validSig(PAYLOAD);
    const truncated = full.slice(0, full.length - 10); // still has sha256= prefix, but short hex
    expect(() => verifySignature(PAYLOAD, SECRET, truncated)).not.toThrow();
    expect(verifySignature(PAYLOAD, SECRET, truncated)).toBe(false);
  });

  it("does not throw on oversized signature", () => {
    const tooLong = `${validSig(PAYLOAD)}deadbeef`;
    expect(() => verifySignature(PAYLOAD, SECRET, tooLong)).not.toThrow();
    expect(verifySignature(PAYLOAD, SECRET, tooLong)).toBe(false);
  });

  it("returns false for garbage hex payload of correct length", () => {
    const fakeHex = `sha256=${"z".repeat(64)}`; // 64 chars but not valid hex
    expect(() => verifySignature(PAYLOAD, SECRET, fakeHex)).not.toThrow();
    expect(verifySignature(PAYLOAD, SECRET, fakeHex)).toBe(false);
  });

  it("returns false for a signature computed with the wrong secret", () => {
    const wrong = signPayload(PAYLOAD, "different-secret");
    expect(verifySignature(PAYLOAD, SECRET, wrong)).toBe(false);
  });

  it("returns false when body bytes differ from what was signed", () => {
    const sig = validSig(PAYLOAD);
    const tampered = PAYLOAD.replace("ord_1", "ord_2");
    expect(verifySignature(tampered, SECRET, sig)).toBe(false);
  });

  it("verifies Buffer bodies identically to string bodies", () => {
    const body = Buffer.from(PAYLOAD);
    expect(verifySignature(body, SECRET, validSig(body))).toBe(true);
  });

  it("throws TypeError when body is a parsed object (req.body footgun)", () => {
    // Documented safeguard from the webhooks module — passing a parsed object
    // would silently fail HMAC comparison and look like a wrong secret.
    // Better to surface it loudly at the call site.
    expect(() =>
      verifySignature({ any: "object" } as unknown as string, SECRET, validSig(PAYLOAD)),
    ).toThrow(TypeError);
  });

  it("supports custom prefix and algorithm", () => {
    const sig = `v1=${crypto.createHmac("sha512", SECRET).update(PAYLOAD).digest("hex")}`;
    expect(verifySignature(PAYLOAD, SECRET, sig, { prefix: "v1=", algorithm: "sha512" })).toBe(
      true,
    );

    // Wrong prefix → false, no throw.
    expect(verifySignature(PAYLOAD, SECRET, sig.replace("v1=", "v2="))).toBe(false);
  });
});
