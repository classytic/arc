/**
 * `@classytic/arc/encryption` — Application-Layer Encryption (ALE).
 *
 * Full-body JWE (RFC 7516, via the optional `jose` peer) or field-level
 * AES-256-GCM (via `node:crypto`, no dependency), opted in per-resource
 * through `defineResource({ extensions: { encryption } })` or globally via a
 * route matcher. See {@link encryptionPlugin}.
 */

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

// The typed `encryption` slice on `ResourceExtensions` is declared inline in
// `src/types/resource.ts` (type-only import), NOT via `declare module` here:
// a relative module augmentation does not survive d.ts bundling — the
// specifier comes out unresolvable in dist and the merge silently never
// happens for consumers. External plugins (separate packages) augment
// `declare module "@classytic/arc/types"` instead, which bundles fine.
