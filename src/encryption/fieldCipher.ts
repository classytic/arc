/**
 * Field-level cipher — `node:crypto` AES-256-GCM, zero external deps.
 *
 * Used by `mode: 'fields'` to encrypt individual field values in place while
 * leaving the JSON structure intact. The envelope is an authenticated,
 * versioned, `kid`-tagged token:
 *
 *   arc.v1.<b64url(kid)>.<b64url(iv)>.<b64url(ciphertext)>.<b64url(tag)>
 *
 * This is NOT a hand-rolled cipher — it's the correct use of a vetted AEAD
 * primitive (AES-256-GCM): a fresh random 96-bit IV per operation (never
 * caller-supplied — IV reuse under GCM is catastrophic), authentication via
 * the GCM tag, and a version prefix so the format can evolve. Same shape, in
 * spirit, as MongoDB CSFLE's BSON-binary subtype-6 envelope. For
 * cross-vendor interop or asymmetric keys use `mode: 'jwe'` (RFC 7516)
 * instead.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ENVELOPE_PREFIX = "arc.v1";
const IV_BYTES = 12; // 96-bit nonce — the GCM standard.
const KEY_BYTES = 32; // AES-256.

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

function toKeyBuffer(key: unknown): Buffer {
  if (Buffer.isBuffer(key)) {
    if (key.length !== KEY_BYTES) {
      throw new Error(
        `[arc/encryption] field-mode key must be ${KEY_BYTES} bytes (AES-256); got ${key.length}`,
      );
    }
    return key;
  }
  if (key instanceof Uint8Array) return toKeyBuffer(Buffer.from(key));
  throw new Error(
    "[arc/encryption] field-mode key must be a 32-byte Buffer/Uint8Array. " +
      "For asymmetric or cross-vendor encryption use mode: 'jwe'.",
  );
}

/** Encrypt a UTF-8 string into the `arc.v1` field envelope. */
export function encryptField(plaintext: string, kid: string, key: unknown): string {
  const secret = toKeyBuffer(key);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", secret, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    ENVELOPE_PREFIX,
    b64url(Buffer.from(kid, "utf8")),
    b64url(iv),
    b64url(ciphertext),
    b64url(tag),
  ].join(".");
}

/** Parsed envelope header — exposes `kid` for key resolution before decrypt. */
export interface ParsedFieldEnvelope {
  readonly kid: string;
  readonly iv: Buffer;
  readonly ciphertext: Buffer;
  readonly tag: Buffer;
}

/** Returns the parsed envelope, or `null` when the token isn't `arc.v1`. */
export function parseFieldEnvelope(token: string): ParsedFieldEnvelope | null {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 6) return null;
  const [v0, v1, kidPart, ivPart, ctPart, tagPart] = parts;
  if (`${v0}.${v1}` !== ENVELOPE_PREFIX) return null;
  if (
    kidPart === undefined ||
    ivPart === undefined ||
    ctPart === undefined ||
    tagPart === undefined
  ) {
    return null;
  }
  try {
    return {
      kid: Buffer.from(kidPart, "base64url").toString("utf8"),
      iv: Buffer.from(ivPart, "base64url"),
      ciphertext: Buffer.from(ctPart, "base64url"),
      tag: Buffer.from(tagPart, "base64url"),
    };
  } catch {
    return null;
  }
}

/** Decrypt a parsed `arc.v1` envelope with the resolved key. Throws on tamper. */
export function decryptField(envelope: ParsedFieldEnvelope, key: unknown): string {
  const secret = toKeyBuffer(key);
  const decipher = createDecipheriv("aes-256-gcm", secret, envelope.iv);
  decipher.setAuthTag(envelope.tag);
  const plaintext = Buffer.concat([
    decipher.update(envelope.ciphertext),
    decipher.final(), // throws if the GCM tag doesn't verify (tampered / wrong key)
  ]);
  return plaintext.toString("utf8");
}
