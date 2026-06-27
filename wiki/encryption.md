# encryption — Application-Layer Encryption (ALE)

`@classytic/arc/encryption` — optional plugin that encrypts response bodies
(and optionally decrypts request bodies) so sensitive payloads stay
confidential past TLS termination (proxies, log aggregators). Defense-in-depth
**alongside** TLS, not a replacement. Scope it to sensitive routes — per-response
asymmetric JWE is CPU-heavy.

## Two modes

| Mode | What | Cipher | Dependency |
|------|------|--------|------------|
| `jwe` | Encrypts the **whole** body into a JWE compact string (RFC 7516). Interop standard (Visa MLE, Mastercard, Wise). | `jose` (RSA-OAEP / ECDH-ES + A256GCM) | optional peer `jose` (lazy-loaded) |
| `fields` | Encrypts **named fields** in place; JSON shape preserved so gateways still read non-sensitive metadata. | `node:crypto` AES-256-GCM (`arc.v1.<kid>.<iv>.<ct>.<tag>` envelope) | none |

`jose` is imported lazily — arc loads fine without it; the "install jose" error
only fires if a host actually selects `mode: 'jwe'`. Field mode never needs it.

## Opt-in (two ways)

**Declarative, per-resource** — via the `extensions` hatch (the "React for
backend" composition path). Threaded onto each route's Fastify
`config.arcExtensions` by `createCrudRouter`, read at request time:

```ts
defineResource({
  name: "payment",
  extensions: { encryption: { mode: "fields", fields: ["cardNumber", "cvv"] } },
});
```

**Global matcher** — plugin-level `routes(request)` fallback for cross-cutting
scope. Per-resource `extensions.encryption` always wins; `{ enabled: false }`
is an authoritative opt-out even when the matcher would include the route.

```ts
await app.register(encryptionPlugin, {
  mode: "jwe",
  keyProvider: createStaticKeyProvider({
    encryptionKey: { kid: "client-1", key: clientPublicKey },   // public key (JWE)
    decryptionKeys: { "server-1": serverPrivateKey },           // private key, by kid
  }),
  routes: (req) => /^\/(payments|accounts)\b/.test(req.url),
});
```

## Key management

`KeyProvider` is the contract: arc owns the request-time plumbing (`kid` → key,
algorithm allowlist); the host owns the trust store (which keys are valid,
file / env / KMS / Vault). Encryption and decryption are separate operations
because they often use **different** keys (Visa's two-key-pair model: a public
key encrypts the outbound response, a private key by `kid` decrypts the inbound
request). Rotation mirrors `@fastify/secure-session` — the active key encrypts;
any `kid`-resolvable key decrypts. Ship `createStaticKeyProvider` for the common
case; implement `KeyProvider` directly for KMS/Vault.

## Hook placement (load-bearing)

Everything happens in **async `preSerialization`** — never `onSend`. arc's rule:
an async `onSend` races Fastify's `onSendEnd → safeWriteHead` flush. **The same
race also affects async `preSerialization` on the controller-dispatch path** —
`createFastifyHandler` calls `reply.send()` then must `return reply` so Fastify
doesn't flush an empty body while jose is still encrypting. See [[gotchas]] and
[[plugins]] (onSend race rule). Inbound decryption is a content-type parser for
`application/jose` (opt-in by media type — plain JSON traffic untouched).

- Full-body JWE: serialize → `jweEncrypt` → pass-through serializer → set
  `Content-Type: application/jose` + `x-encrypted: true`.
- Field mode: mutate the object in place; JSON shape preserved.
- **SSE / streams / non-string bodies are skipped** — JWE has no streaming form.

## Pitfalls

- JWE gives confidentiality + integrity, **not anti-replay** — add
  `iat`/`exp`/`jti` + a server nonce cache if freshness matters.
- Algorithm allowlists (`allowedAlgs`/`allowedEncs`) default to `[alg]`/`[enc]`
  to block algorithm-substitution downgrade — only widen deliberately.
- Field mode: the encrypted field becomes a **string**; a response schema must
  allow `string` for that field or it'll be coerced/stripped by
  `fast-json-stringify`.
- Never hand-roll JWE on `node:crypto` — use `jose` (validates `epk` on-curve;
  the 2017 invalid-curve CVE hit libraries that rolled their own).
