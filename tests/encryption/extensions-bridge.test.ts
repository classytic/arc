/**
 * The `extensions` escape hatch — the "React for backend" composition path.
 *
 * Proves the full chain: `defineResource({ extensions })` → frozen on the
 * ResourceDefinition → stamped onto every route's Fastify `config.arcExtensions`
 * by `createCrudRouter` → read at request time by a plugin. The end-to-end
 * test wires the real encryption plugin against a real resource so the bridge
 * is verified, not mocked.
 */
import Fastify, { type FastifyInstance } from "fastify";
import { compactDecrypt, generateKeyPair } from "jose";
import { afterEach, describe, expect, it } from "vitest";
import { defineResource } from "../../src/core/defineResource.js";
import { encryptionPlugin } from "../../src/encryption/encryptionPlugin.js";
import { createStaticKeyProvider } from "../../src/encryption/keyProvider.js";
import { allowPublic } from "../../src/permissions/index.js";

let app: FastifyInstance;
afterEach(async () => {
  await app?.close();
});

describe("ResourceConfig.extensions exposure", () => {
  it("surfaces a frozen copy on the ResourceDefinition", () => {
    const resource = defineResource({
      name: "vault",
      customRoutesOnly: true,
      extensions: { encryption: { mode: "jwe" } },
      routes: [
        { method: "GET", path: "/peek", permissions: allowPublic(), handler: async () => ({}) },
      ],
    });
    expect(resource.extensions).toEqual({ encryption: { mode: "jwe" } });
    expect(Object.isFrozen(resource.extensions)).toBe(true);
  });

  it("is undefined when no extensions are declared", () => {
    const resource = defineResource({
      name: "plain",
      customRoutesOnly: true,
      routes: [
        { method: "GET", path: "/x", permissions: allowPublic(), handler: async () => ({}) },
      ],
    });
    expect(resource.extensions).toBeUndefined();
  });
});

describe("extensions → route config → request-time read (bridge)", () => {
  it("stamps arcExtensions onto a route's config", async () => {
    const resource = defineResource({
      name: "ledger",
      customRoutesOnly: true,
      extensions: { encryption: { mode: "fields", fields: ["balance"] } },
      routes: [
        {
          method: "GET",
          path: "/probe",
          permissions: allowPublic(),
          handler: async () => ({ data: { ok: true } }),
        },
      ],
    });

    app = Fastify({ logger: false });
    let seen: unknown;
    app.addHook("onRequest", async (req) => {
      seen = (req.routeOptions?.config as { arcExtensions?: unknown })?.arcExtensions;
    });
    await app.register(resource.toPlugin());
    await app.ready();

    await app.inject({ url: "/ledgers/probe" });
    expect(seen).toEqual({ encryption: { mode: "fields", fields: ["balance"] } });
  });

  it("end-to-end: a resource declaring extensions.encryption gets JWE responses", async () => {
    const { publicKey, privateKey } = await generateKeyPair("RSA-OAEP-256");
    const resource = defineResource({
      name: "vault",
      customRoutesOnly: true,
      extensions: { encryption: { mode: "jwe" } },
      routes: [
        {
          method: "GET",
          path: "/peek",
          permissions: allowPublic(),
          handler: async () => ({ data: { secret: "top" } }),
        },
      ],
    });

    app = Fastify({ logger: false });
    await app.register(encryptionPlugin, {
      mode: "jwe",
      keyProvider: createStaticKeyProvider({
        encryptionKey: { kid: "k1", key: publicKey },
        decryptionKeys: { k1: privateKey },
      }),
    });
    await app.register(resource.toPlugin());
    await app.ready();

    const res = await app.inject({ url: "/vaults/peek" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/jose");
    // The wire body must be a JWE COMPACT SERIALIZATION — five base64url
    // segments — not the JSON it encrypts. Substring-matching the plaintext
    // against base64 is unsound and was FLAKY: base64url of random ciphertext
    // contains any given 3-character run every few hundred runs, and one such
    // run failed the release gate on `...IXVErtopdK0F4...`. Asserting the
    // SHAPE is both stronger and deterministic — it cannot pass on a body
    // that merely avoided the needle.
    expect(res.body.split(".")).toHaveLength(5);
    expect(res.body).not.toContain('"secret"'); // no JSON structure on the wire

    const { plaintext } = await compactDecrypt(res.body, privateKey);
    // The ENVELOPE is unwrapped before encryption — the handler's `data` is
    // the payload, so the ciphertext holds `{ secret }`, not `{ data: {...} }`.
    // The old `toContain("top")` passed either way and never pinned this.
    expect(JSON.parse(new TextDecoder().decode(plaintext))).toEqual({ secret: "top" });
  });

  it("end-to-end: action routes (POST /:id/action) are encrypted too", async () => {
    const { publicKey, privateKey } = await generateKeyPair("RSA-OAEP-256");
    const resource = defineResource({
      name: "widget",
      customRoutesOnly: true,
      extensions: { encryption: { mode: "jwe" } },
      actions: {
        ping: { handler: async () => ({ pong: "secret-value" }), permissions: allowPublic() },
      },
    });

    app = Fastify({ logger: false });
    await app.register(encryptionPlugin, {
      mode: "jwe",
      keyProvider: createStaticKeyProvider({
        encryptionKey: { kid: "k1", key: publicKey },
        decryptionKeys: { k1: privateKey },
      }),
    });
    await app.register(resource.toPlugin());
    await app.ready();

    const res = await app.inject({
      method: "POST",
      url: "/widgets/abc/action",
      payload: { action: "ping" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/jose");
    expect(res.body).not.toContain("secret-value");

    const { plaintext } = await compactDecrypt(res.body, privateKey);
    expect(new TextDecoder().decode(plaintext)).toContain("secret-value");
  });
});
