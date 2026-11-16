/**
 * Field sealer: a synchronous string seal over the `arc.v1` envelope and a static key ring parsed from
 * `kid:base64` entries. The first entry seals, every entry opens; a value that does not open throws.
 */
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createFieldSealer, parseFieldKeyRing } from "../../src/encryption/index.js";

const k1 = randomBytes(32).toString("base64");
const k2 = randomBytes(32).toString("base64");
const VALUE = "001234567890";
const sealerOf = (...entries: string[]) =>
  createFieldSealer(parseFieldKeyRing(entries, "TEST_KEYS"));

describe("createFieldSealer", () => {
  it("seals with a fresh IV under the active kid, and opens what it sealed", () => {
    const sealer = sealerOf(`k1:${k1}`);
    const a = sealer.encrypt(VALUE);
    const b = sealer.encrypt(VALUE);
    expect(a).not.toBe(b);
    expect(a).not.toContain(VALUE);
    expect(a.startsWith("arc.v1.")).toBe(true);
    expect(sealer.activeKid).toBe("k1");
    expect(sealer.kidOf(a)).toBe("k1");
    expect(sealer.decrypt(a)).toBe(VALUE);
  });

  it("refuses a tampered ciphertext, a tampered tag and a foreign key: it throws, never returns its input", () => {
    const sealer = sealerOf(`k1:${k1}`);
    const sealed = sealer.encrypt(VALUE);
    const parts = sealed.split(".");
    const flip = (b64: string) => {
      const buf = Buffer.from(b64, "base64url");
      buf[0] = (buf[0] ?? 0) ^ 0x01;
      return buf.toString("base64url");
    };
    const at = (i: number, v: string) => parts.map((p, j) => (j === i ? v : p)).join(".");
    expect(() => sealer.decrypt(at(4, flip(parts[4] ?? "")))).toThrow();
    expect(() => sealer.decrypt(at(5, flip(parts[5] ?? "")))).toThrow();
    expect(() => sealerOf(`k1:${k2}`).decrypt(sealed)).toThrow();
    expect(() => sealer.decrypt(VALUE)).toThrow(/not a sealed value/);
    expect(sealer.kidOf(VALUE)).toBeNull();
    const k9 = sealerOf(`k9:${k2}`).encrypt(VALUE);
    expect(() => sealer.decrypt(k9)).toThrow(/k9.*TEST_KEYS/);
  });

  it("rotates: the first entry seals, an older entry still opens", () => {
    const old = sealerOf(`k1:${k1}`).encrypt(VALUE);
    const rotated = sealerOf(`k2:${k2}`, `k1:${k1}`);
    expect(rotated.decrypt(old)).toBe(VALUE);
    expect(rotated.kidOf(rotated.encrypt(VALUE))).toBe("k2");
  });
});

describe("parseFieldKeyRing", () => {
  it("refuses a missing or malformed ring, naming its label", () => {
    expect(() => parseFieldKeyRing([], "TEST_KEYS")).toThrow(/TEST_KEYS is not set/);
    expect(() => parseFieldKeyRing(["k1"], "TEST_KEYS")).toThrow(/TEST_KEYS/);
    expect(() => parseFieldKeyRing([`bad id:${k1}`], "TEST_KEYS")).toThrow(/TEST_KEYS/);
    expect(() =>
      parseFieldKeyRing([`k1:${randomBytes(16).toString("base64")}`], "TEST_KEYS"),
    ).toThrow(/32 bytes/);
    expect(() => parseFieldKeyRing([`k1:${k1}`, `k1:${k2}`], "TEST_KEYS")).toThrow(/twice/);
  });

  it("trims entries and keeps their order: the first is active", () => {
    const ring = parseFieldKeyRing([` k2:${k2} `, `k1:${k1}`], "TEST_KEYS");
    expect(ring.activeKid).toBe("k2");
    expect([...ring.keys.keys()]).toEqual(["k2", "k1"]);
  });
});
