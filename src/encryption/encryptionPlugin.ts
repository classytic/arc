/**
 * Encryption Plugin — Application-Layer Encryption (ALE) for arc.
 *
 * Encrypts response bodies (and optionally decrypts request bodies) so
 * sensitive payloads stay confidential even past TLS termination (proxies,
 * log aggregators). Defense-in-depth ALONGSIDE TLS — scope it to sensitive
 * routes; per-response asymmetric JWE is CPU-heavy.
 *
 * Hook placement follows Fastify's lifecycle exactly:
 *   - INBOUND  decryption → a content-type parser for `application/jose`
 *     (opt-in by media type; normal JSON traffic is untouched).
 *   - OUTBOUND headers (`Content-Type`, flag) → `preSerialization` (arc's
 *     rule: never set headers in async `onSend` — it races the flush path).
 *   - OUTBOUND full-body JWE → `onSend`, where the payload is the serialized
 *     string and arc's response-schema field-stripping has already run, so we
 *     encrypt the already-sanitized output.
 *   - OUTBOUND field encryption → `preSerialization`, mutating the object in
 *     place (the JSON shape is preserved).
 *   - SSE / streams / non-string bodies are skipped — JWE has no streaming form.
 *
 * @example
 * ```ts
 * import { encryptionPlugin, createStaticKeyProvider } from "@classytic/arc/encryption";
 *
 * await app.register(encryptionPlugin, {
 *   mode: "jwe",
 *   keyProvider: createStaticKeyProvider({
 *     encryptionKey: { kid: "client-1", key: clientPublicKey },
 *     decryptionKeys: { "server-1": serverPrivateKey },
 *   }),
 *   routes: (req) => /^\/(payments|accounts)\b/.test(req.url),
 * });
 *
 * // …or per-resource, declaratively:
 * defineResource({
 *   name: "payment",
 *   extensions: { encryption: { mode: "fields", fields: ["cardNumber", "cvv"] } },
 * });
 * ```
 */

import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { encryptField } from "./fieldCipher.js";
import { jweDecrypt, jweEncrypt } from "./jose.js";
import { resolveDirective } from "./resolver.js";
import type { EncryptionOptions, JweAlg, JweEnc, KeyProvider } from "./types.js";

function getPath(obj: Record<string, unknown>, path: string): unknown {
  let cur: unknown = obj;
  for (const seg of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

function setPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const segs = path.split(".");
  const last = segs[segs.length - 1];
  if (last === undefined) return;
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < segs.length - 1; i++) {
    const seg = segs[i];
    if (seg === undefined) return;
    const next = cur[seg];
    if (next === null || typeof next !== "object") return; // path absent — skip silently
    cur = next as Record<string, unknown>;
  }
  cur[last] = value;
}

const encryptionPlugin: FastifyPluginAsync<EncryptionOptions> = async (
  fastify: FastifyInstance,
  opts: EncryptionOptions,
) => {
  const {
    enabled = true,
    keyProvider,
    mode: defaultMode = "jwe",
    alg = "RSA-OAEP-256",
    enc = "A256GCM",
    routes: fallback,
    decryptRequests = true,
    contentType = "application/jose",
    responseContentType = "application/jose",
    flagHeader = "x-encrypted",
  } = opts;

  fastify.decorateRequest("requestDecrypted", false);
  fastify.decorateRequest("responseEncrypted", false);

  if (enabled === false) {
    fastify.log?.debug?.("[arc/encryption] disabled");
    return;
  }

  if (!keyProvider) {
    throw new Error("[arc/encryption] `keyProvider` is required when the plugin is enabled.");
  }

  const allowedAlgs: readonly JweAlg[] = opts.allowedAlgs ?? [alg];
  const allowedEncs: readonly JweEnc[] = opts.allowedEncs ?? [enc];

  function setFlag(reply: { header(k: string, v: string): unknown }): void {
    if (flagHeader) reply.header(flagHeader, "true");
  }

  // ── Inbound: decrypt `application/jose` request bodies ─────────────────
  // Registered per media type, so plain JSON requests never hit this path.
  if (decryptRequests) {
    fastify.addContentTypeParser(
      contentType,
      { parseAs: "string" },
      async (request: FastifyRequest, body: string) => {
        const provider: KeyProvider = keyProvider;
        const plaintext = await jweDecrypt(
          body,
          (kid) => provider.decryptionKey(kid, { request }),
          allowedAlgs,
          allowedEncs,
        );
        request.requestDecrypted = true;
        if (plaintext.length === 0) return undefined;
        try {
          return JSON.parse(plaintext);
        } catch (cause) {
          throw Object.assign(
            new Error("[arc/encryption] decrypted request body is not valid JSON"),
            { statusCode: 400, cause },
          );
        }
      },
    );
  }

  // ── Outbound: encrypt at preSerialization ──────────────────────────────
  //
  // EVERYTHING happens here — never in `onSend`. arc's load-bearing rule:
  // an async `onSend` races Fastify's `onSendEnd → safeWriteHead` flush and
  // yields `ERR_HTTP_HEADERS_SENT` / an empty body when a handler dispatches
  // via `reply.send(object)` (which arc's controller path does). Both jose
  // (JWE) and the field cipher are async, so the body rewrite belongs in
  // `preSerialization`, which Fastify awaits before serialization.
  //
  // Fastify skips this hook for string/Buffer/stream/null payloads — exactly
  // the bodies we exclude anyway (streams have no JWE form; empty responses
  // have nothing to protect). For full-body JWE we install a pass-through
  // serializer so the returned compact string isn't re-JSON-stringified.
  fastify.addHook("preSerialization", async (request, reply, payload) => {
    const directive = resolveDirective(request, defaultMode, fallback);
    if (!directive) return payload;
    if (payload === null || typeof payload !== "object") return payload;

    if (directive.mode === "fields") {
      if (directive.fields.length === 0) return payload;
      const { kid, key } = await keyProvider.encryptionKey({ request });
      const obj = payload as Record<string, unknown>;
      let touched = false;
      for (const path of directive.fields) {
        const value = getPath(obj, path);
        if (value === undefined || value === null) continue;
        setPath(obj, path, encryptField(JSON.stringify(value), kid, key));
        touched = true;
      }
      if (touched) {
        setFlag(reply);
        request.responseEncrypted = true;
      }
      return payload;
    }

    // mode: 'jwe' — serialize the sanitized object ourselves, wrap it, and
    // hand back the compact string under a pass-through serializer.
    const active = await keyProvider.encryptionKey({ request });
    const jwe = await jweEncrypt(JSON.stringify(payload), active, alg, enc);
    reply.header("content-type", responseContentType);
    setFlag(reply);
    reply.serializer((p: unknown) => p as string);
    request.responseEncrypted = true;
    return jwe;
  });

  fastify.log?.debug?.({ mode: defaultMode, alg, enc }, "[arc/encryption] enabled");
};

export default fp(encryptionPlugin, {
  name: "arc-encryption",
  fastify: "5.x",
});

export { encryptionPlugin };
