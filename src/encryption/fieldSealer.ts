/**
 * A synchronous string sealer over the `arc.v1` field envelope and a STATIC key ring, for values sealed
 * at rest (an account number, a token). The ring's first key seals; every listed key opens (rotation).
 * A value that does not open THROWS; it never returns its input. Pinned by tests/encryption/field-sealer.test.ts.
 */

import { decryptField, encryptField, parseFieldEnvelope } from "./fieldCipher.js";

const KID = /^[A-Za-z0-9_-]{1,32}$/;
const KEY_BYTES = 32;

/** Keys by `kid`, in ring order; `activeKid` (the first) seals; `label` names the source in errors. */
export interface FieldKeyRing {
  readonly activeKid: string;
  readonly keys: ReadonlyMap<string, Buffer>;
  readonly label: string;
}

export interface FieldSealer {
  readonly activeKid: string;
  encrypt(plain: string): string;
  /** Throws on a value that is not an envelope, names a kid the ring lacks, or fails the GCM tag. */
  decrypt(token: string): string;
  /** The kid a value is sealed under, or `null` when it is not an `arc.v1` envelope. */
  kidOf(token: string): string | null;
}

/**
 * Parse `kid:base64(32 bytes)` entries (e.g. an env list) into a ring. `label` names the source in every
 * error. Empty, malformed, short or repeated entries throw.
 */
export function parseFieldKeyRing(entries: readonly string[], label: string): FieldKeyRing {
  const trimmed = entries.map((e) => e.trim()).filter((e) => e !== "");
  if (trimmed.length === 0) {
    throw new Error(
      `${label} is not set: a field key ring needs at least one kid:base64 entry (32 random bytes)`,
    );
  }
  const keys = new Map<string, Buffer>();
  let activeKid = "";
  for (const entry of trimmed) {
    const at = entry.indexOf(":");
    const kid = at > 0 ? entry.slice(0, at) : "";
    if (!KID.test(kid))
      throw new Error(`${label}: each entry is kid:base64 with a kid of [A-Za-z0-9_-]{1,32}`);
    const key = Buffer.from(entry.slice(at + 1), "base64");
    if (key.length !== KEY_BYTES) {
      throw new Error(
        `${label}: key ${kid} must be ${KEY_BYTES} bytes (AES-256), got ${key.length}`,
      );
    }
    if (keys.has(kid)) throw new Error(`${label}: key id ${kid} is listed twice`);
    keys.set(kid, key);
    activeKid ||= kid;
  }
  return { activeKid, keys, label };
}

export function createFieldSealer(ring: FieldKeyRing): FieldSealer {
  const { label } = ring;
  const activeKey = ring.keys.get(ring.activeKid);
  if (!activeKey)
    throw new Error(`createFieldSealer: active key ${ring.activeKid} is not in ${label}`);
  return {
    activeKid: ring.activeKid,
    encrypt: (plain) => encryptField(plain, ring.activeKid, activeKey),
    decrypt(token) {
      const envelope = parseFieldEnvelope(token);
      if (!envelope) throw new Error("not a sealed value (expected an arc.v1 field envelope)");
      const key = ring.keys.get(envelope.kid);
      if (!key)
        throw new Error(
          `the value is sealed with key ${envelope.kid}, which ${label} does not hold`,
        );
      return decryptField(envelope, key);
    },
    kidOf: (token) => parseFieldEnvelope(token)?.kid ?? null,
  };
}
