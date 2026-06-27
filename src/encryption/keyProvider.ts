/**
 * Key providers — the host's trust store, behind arc's `KeyProvider` contract.
 *
 * `createStaticKeyProvider` covers the common case: one active encryption key
 * plus a `kid`-indexed set of decryption keys for rotation. For KMS / Vault,
 * implement `KeyProvider` directly (resolve + cache keys from your secret
 * manager) — arc only calls `encryptionKey` / `decryptionKey`.
 */

import type { ActiveKey, KeyMaterial, KeyProvider } from "./types.js";

export interface StaticKeyProviderOptions {
  /**
   * Active key used to ENCRYPT outbound responses. For `jwe` mode this is the
   * recipient's PUBLIC key; for `fields` mode a 32-byte symmetric secret.
   */
  readonly encryptionKey: ActiveKey;
  /**
   * Keys used to DECRYPT inbound requests, indexed by `kid`. For `jwe` mode
   * these are PRIVATE keys; for `fields` mode the same symmetric secrets.
   *
   * Defaults to `{ [encryptionKey.kid]: encryptionKey.key }` — correct for
   * symmetric field mode where one key both encrypts and decrypts. For
   * asymmetric JWE you MUST pass the private key(s) here; the public
   * `encryptionKey` cannot decrypt. Keep 2–3 entries during a rotation so
   * in-flight messages signed with the previous `kid` still decrypt.
   */
  readonly decryptionKeys?: Readonly<Record<string, KeyMaterial>>;
}

/**
 * A static, in-memory key provider with `kid`-based rotation. Keys are held
 * for the process lifetime — resolve them from env / a secrets file at boot
 * and pass the imported key material in (don't re-parse PEM per request).
 *
 * @example symmetric field mode
 * ```ts
 * const provider = createStaticKeyProvider({
 *   encryptionKey: { kid: "2026-06", key: Buffer.from(process.env.FIELD_KEY!, "base64") },
 * });
 * ```
 *
 * @example asymmetric JWE (jose key material)
 * ```ts
 * const provider = createStaticKeyProvider({
 *   encryptionKey: { kid: "client-1", key: await importSPKI(clientPubPem, "RSA-OAEP-256") },
 *   decryptionKeys: { "server-1": await importPKCS8(serverPrivPem, "RSA-OAEP-256") },
 * });
 * ```
 */
export function createStaticKeyProvider(options: StaticKeyProviderOptions): KeyProvider {
  const { encryptionKey } = options;
  const decryptionKeys: Record<string, KeyMaterial> = {
    [encryptionKey.kid]: encryptionKey.key,
    ...options.decryptionKeys,
  };
  return {
    encryptionKey: () => encryptionKey,
    decryptionKey: (kid) => decryptionKeys[kid],
  };
}
