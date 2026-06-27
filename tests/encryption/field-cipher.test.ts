/**
 * Field cipher — AES-256-GCM envelope round-trip + tamper/rotation behaviour.
 *
 * The `arc.v1` envelope must: round-trip any UTF-8 payload, reject tampering
 * (GCM tag), reject the wrong key, carry the `kid` for rotation, and refuse
 * non-256-bit keys (a silent short key would be a real downgrade).
 */
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  decryptField,
  encryptField,
  parseFieldEnvelope,
} from "../../src/encryption/fieldCipher.js";

const key = randomBytes(32);

describe("fieldCipher", () => {
  it("round-trips a value", () => {
    const token = encryptField("4111111111111111", "k1", key);
    expect(token.startsWith("arc.v1.")).toBe(true);
    const parsed = parseFieldEnvelope(token);
    expect(parsed?.kid).toBe("k1");
    expect(decryptField(parsed!, key)).toBe("4111111111111111");
  });

  it("produces a fresh IV per call (no deterministic ciphertext)", () => {
    const a = encryptField("same", "k1", key);
    const b = encryptField("same", "k1", key);
    expect(a).not.toBe(b);
  });

  it("rejects a tampered ciphertext via the GCM tag", () => {
    const token = encryptField("secret", "k1", key);
    const parsed = parseFieldEnvelope(token)!;
    parsed.ciphertext[0] ^= 0xff; // flip a bit
    expect(() => decryptField(parsed, key)).toThrow();
  });

  it("rejects the wrong key", () => {
    const token = encryptField("secret", "k1", key);
    const parsed = parseFieldEnvelope(token)!;
    expect(() => decryptField(parsed, randomBytes(32))).toThrow();
  });

  it("returns null for non-arc tokens", () => {
    expect(parseFieldEnvelope("not-an-envelope")).toBeNull();
    expect(parseFieldEnvelope("arc.v2.a.b.c.d")).toBeNull();
    expect(parseFieldEnvelope("")).toBeNull();
  });

  it("refuses a key that isn't 32 bytes", () => {
    expect(() => encryptField("x", "k1", randomBytes(16))).toThrow(/32 bytes/);
  });
});
