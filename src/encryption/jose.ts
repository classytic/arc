/**
 * JWE adapter — thin, lazily-loaded wrapper over the optional `jose` peer.
 *
 * `jose` (panva) is the de-facto Node JWE library: zero runtime deps, built
 * on Web Crypto, validates the ephemeral key on-curve (defeating the 2017
 * invalid-curve attack class) and enforces algorithm allowlists. We DON'T
 * hand-roll JWE on `node:crypto` — the envelope, header validation, and JWK
 * handling are exactly where roll-your-own JOSE implementations have been
 * CVE'd.
 *
 * `jose` is imported lazily so arc loads fine without it — the friendly
 * "install jose" error only fires if a host actually selects `mode: 'jwe'`.
 */

import type { JweAlg, JweEnc, KeyMaterial } from "./types.js";

/** Minimal structural view of the `jose` surface we use — avoids a hard dep type. */
interface JoseModule {
  CompactEncrypt: new (
    plaintext: Uint8Array,
  ) => {
    setProtectedHeader(header: Record<string, unknown>): {
      encrypt(key: unknown): Promise<string>;
    };
  };
  compactDecrypt: (
    jwe: string,
    getKey: (header: { kid?: string; alg?: string; enc?: string }) => Promise<unknown> | unknown,
    options?: { keyManagementAlgorithms?: string[]; contentEncryptionAlgorithms?: string[] },
  ) => Promise<{ plaintext: Uint8Array }>;
}

let josePromise: Promise<JoseModule> | undefined;

/** Load `jose` once, caching the module. Throws an actionable error if absent. */
async function loadJose(): Promise<JoseModule> {
  if (!josePromise) {
    josePromise = import("jose").then(
      (m) => m as unknown as JoseModule,
      (cause) => {
        josePromise = undefined; // allow retry after the host installs it
        throw new Error(
          "[arc/encryption] mode 'jwe' requires the optional peer dependency `jose`. " +
            "Install it with `npm i jose`, or use mode: 'fields' (node:crypto, no dependency).",
          { cause },
        );
      },
    );
  }
  return josePromise;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Encrypt a UTF-8 string into a JWE compact serialization. */
export async function jweEncrypt(
  plaintext: string,
  active: { kid: string; key: KeyMaterial; alg?: JweAlg },
  alg: JweAlg,
  enc: JweEnc,
): Promise<string> {
  const jose = await loadJose();
  return new jose.CompactEncrypt(encoder.encode(plaintext))
    .setProtectedHeader({ alg: active.alg ?? alg, enc, kid: active.kid })
    .encrypt(active.key);
}

/**
 * Decrypt a JWE compact string. `resolve` maps the header `kid` to a key;
 * the allowlists are enforced by `jose` so a malicious header can't downgrade
 * the algorithm.
 */
export async function jweDecrypt(
  jwe: string,
  resolve: (kid: string) => Promise<KeyMaterial | undefined> | KeyMaterial | undefined,
  allowedAlgs: readonly JweAlg[],
  allowedEncs: readonly JweEnc[],
): Promise<string> {
  const jose = await loadJose();
  const { plaintext } = await jose.compactDecrypt(
    jwe,
    async (header) => {
      if (!header.kid) {
        throw new Error("[arc/encryption] inbound JWE is missing the `kid` header");
      }
      const key = await resolve(header.kid);
      if (key === undefined) {
        throw new Error(`[arc/encryption] no decryption key for kid '${header.kid}'`);
      }
      return key;
    },
    {
      keyManagementAlgorithms: [...allowedAlgs],
      contentEncryptionAlgorithms: [...allowedEncs],
    },
  );
  return decoder.decode(plaintext);
}
