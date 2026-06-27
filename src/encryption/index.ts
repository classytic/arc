/**
 * `@classytic/arc/encryption` — Application-Layer Encryption (ALE).
 *
 * Full-body JWE (RFC 7516, via the optional `jose` peer) or field-level
 * AES-256-GCM (via `node:crypto`, no dependency), opted in per-resource
 * through `defineResource({ extensions: { encryption } })` or globally via a
 * route matcher. See {@link encryptionPlugin}.
 */

import type { EncryptionDirective } from "./types.js";

export { default, encryptionPlugin } from "./encryptionPlugin.js";
export {
  decryptField,
  encryptField,
  type ParsedFieldEnvelope,
  parseFieldEnvelope,
} from "./fieldCipher.js";
export { createStaticKeyProvider, type StaticKeyProviderOptions } from "./keyProvider.js";
export type {
  ActiveKey,
  EncryptionDirective,
  EncryptionMode,
  EncryptionOptions,
  JweAlg,
  JweEnc,
  KeyContext,
  KeyMaterial,
  KeyProvider,
} from "./types.js";

// Register the typed `encryption` slice on arc's resource-extension contract.
// Declaration-merging onto the module where `ResourceExtensions` is declared
// makes `defineResource({ extensions: { encryption: { … } } })` fully typed
// for any host that imports this subpath — and a typo a compile error.
declare module "../types/resource.js" {
  interface ResourceExtensions {
    /**
     * Encrypt this resource's responses — full-body JWE or specific fields.
     * Threaded to request time on
     * `request.routeOptions.config.arcExtensions.encryption`.
     */
    encryption?: EncryptionDirective;
  }
}
