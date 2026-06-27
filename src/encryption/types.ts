/**
 * Encryption plugin — public contract types.
 *
 * Application-Layer Encryption (ALE) for arc responses (and optionally
 * requests). Two modes:
 *
 *   - `jwe`    — encrypt the WHOLE response body into a JWE compact string
 *                (RFC 7516). The interop standard used by Visa MLE,
 *                Mastercard, Wise. Requires the optional `jose` peer.
 *   - `fields` — encrypt SPECIFIC fields in place (AES-256-GCM via
 *                `node:crypto`), preserving the JSON shape so gateways /
 *                routers can still read non-sensitive metadata. No `jose`
 *                dependency.
 *
 * Defense-in-depth ALONGSIDE TLS — not a replacement. Scope it to sensitive
 * routes; asymmetric JWE per response is CPU-heavy. See the wiki page.
 */

import type { FastifyRequest } from "fastify";

/** JWE key-management algorithm — the protected-header `alg`. */
export type JweAlg =
  | "RSA-OAEP-256"
  | "RSA-OAEP-384"
  | "RSA-OAEP-512"
  | "ECDH-ES"
  | "ECDH-ES+A256KW"
  | "A256GCMKW"
  | "dir";

/** JWE content-encryption algorithm — the protected-header `enc`. AEAD only. */
export type JweEnc = "A128GCM" | "A192GCM" | "A256GCM";

/** Encryption strategy for a route's response. */
export type EncryptionMode = "jwe" | "fields";

/**
 * Opaque key material. For `jwe` mode this is a `jose` `KeyLike` /
 * `CryptoKey` / `Uint8Array`; for `fields` mode a 32-byte secret
 * (`Buffer` / `Uint8Array`). Kept `unknown` at the contract layer so the
 * `KeyProvider` interface carries no hard `jose` type dependency — hosts
 * without `jose` installed can still implement field-mode providers.
 */
export type KeyMaterial = unknown;

/** A key paired with its identifier — what encrypt operations consume. */
export interface ActiveKey {
  /** Key id, stamped into the JWE `kid` header / field envelope for rotation. */
  readonly kid: string;
  /** The key material (public key for JWE, 32-byte secret for fields). */
  readonly key: KeyMaterial;
  /** Optional per-key `alg` override (else the plugin default applies). */
  readonly alg?: JweAlg;
}

/** Context handed to the key provider so resolution can be request-scoped. */
export interface KeyContext {
  readonly request: FastifyRequest;
}

type MaybePromise<T> = T | Promise<T>;

/**
 * Pluggable key resolution. Arc owns the request-time plumbing — `kid` →
 * key, algorithm allowlist enforcement; the host owns the trust store —
 * which keys are valid and where they live (file / env / AWS KMS / GCP KMS
 * / Vault). Encryption and decryption are deliberately separate operations
 * because they often use DIFFERENT keys (JWE: a public key encrypts the
 * outbound response, a private key by `kid` decrypts the inbound request —
 * exactly Visa's two-key-pair model).
 *
 * Rotation mirrors `@fastify/secure-session`: the active key encrypts; any
 * key resolvable by `kid` can decrypt, so you can roll keys without dropping
 * in-flight traffic.
 */
export interface KeyProvider {
  /** Active key for encrypting OUTBOUND responses. */
  encryptionKey(ctx: KeyContext): MaybePromise<ActiveKey>;
  /** Resolve a DECRYPTION key by the inbound message's `kid`. */
  decryptionKey(kid: string, ctx: KeyContext): MaybePromise<KeyMaterial | undefined>;
}

/**
 * Per-resource encryption directive — the typed slice plugins register on
 * `ResourceExtensions`. Declared on a resource via
 * `defineResource({ extensions: { encryption: { … } } })`; arc threads it
 * to request time on `request.routeOptions.config.arcExtensions.encryption`.
 */
export interface EncryptionDirective {
  /** Strategy. Defaults to the plugin-level `mode` (default `'jwe'`). */
  readonly mode?: EncryptionMode;
  /**
   * For `mode: 'fields'` — dot-paths of fields to encrypt, resolved against
   * the serialized response body (e.g. `'cardNumber'`, `'account.iban'`).
   * Ignored for `mode: 'jwe'` (the whole body is encrypted).
   */
  readonly fields?: readonly string[];
  /**
   * Explicit opt-out — set `false` to disable encryption for this resource
   * even when a plugin-level default (`routes`) would otherwise apply.
   */
  readonly enabled?: boolean;
}

/** Internal resolved form — directive after defaults are applied. */
export interface ResolvedDirective {
  readonly mode: EncryptionMode;
  readonly fields: readonly string[];
}

/**
 * Plugin-level options. `keyProvider` is the only required field; everything
 * else has a secure default.
 */
export interface EncryptionOptions {
  /**
   * Master on/off. Default `true`. Set `false` to register the plugin as a
   * typed no-op (config-gated environments) — same pattern as
   * `idempotencyPlugin`.
   */
  readonly enabled?: boolean;
  /** Key provider — resolves `kid` → key for encrypt/decrypt. Required. */
  readonly keyProvider: KeyProvider;
  /** Default mode when a route opts in without naming one. Default `'jwe'`. */
  readonly mode?: EncryptionMode;
  /** JWE key-management algorithm. Default `'RSA-OAEP-256'`. */
  readonly alg?: JweAlg;
  /** JWE content-encryption algorithm. Default `'A256GCM'`. */
  readonly enc?: JweEnc;
  /**
   * Inbound-decryption algorithm allowlists — block algorithm-substitution
   * downgrade attacks. Default `[alg]` / `[enc]`. Set explicitly only when a
   * client legitimately uses more than one algorithm.
   */
  readonly allowedAlgs?: readonly JweAlg[];
  readonly allowedEncs?: readonly JweEnc[];
  /**
   * Fallback opt-in for routes that don't declare
   * `extensions.encryption`. Return a directive (or `true` for the default
   * mode) to encrypt, `false`/`undefined` to skip. The per-resource
   * `extensions.encryption` ALWAYS wins when present. Use this to scope ALE
   * to sensitive prefixes without touching every resource.
   *
   * @example confine ALE to `/payments` and `/accounts`
   * ```ts
   * routes: (req) => /^\/(payments|accounts)\b/.test(req.url)
   * ```
   */
  readonly routes?: (request: FastifyRequest) => EncryptionDirective | boolean | undefined;
  /** Decrypt inbound `application/jose` request bodies. Default `true`. */
  readonly decryptRequests?: boolean;
  /** Media type that signals an encrypted REQUEST body. Default `'application/jose'`. */
  readonly contentType?: string;
  /** Content-Type set on full-body JWE RESPONSES. Default `'application/jose'`. */
  readonly responseContentType?: string;
  /**
   * Response header advertising that the body is encrypted, so generic
   * client SDKs know to decrypt. Default `'x-encrypted'`; set `false` to omit.
   */
  readonly flagHeader?: string | false;
}

/** Request decorations added by the plugin. */
declare module "fastify" {
  interface FastifyRequest {
    /** `true` when the inbound body was decrypted from a JWE by this plugin. */
    requestDecrypted?: boolean;
    /** `true` when the outbound body was encrypted by this plugin. */
    responseEncrypted?: boolean;
  }
}
