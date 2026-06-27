/**
 * Encryption plugin — integration on a bare Fastify app.
 *
 * Routes opt in via Fastify's native per-route `config.arcExtensions`
 * (exactly what arc's `createCrudRouter` stamps from `defineResource`), so
 * these tests exercise the resolver + hook placement without the full
 * resource pipeline. Covers: full-body JWE, field-level AES-GCM, inbound
 * decryption, the plugin-level route matcher, and per-resource opt-out.
 */
import { randomBytes } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { CompactEncrypt, compactDecrypt, generateKeyPair } from "jose";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { encryptionPlugin } from "../../src/encryption/encryptionPlugin.js";
import { decryptField, parseFieldEnvelope } from "../../src/encryption/fieldCipher.js";
import { createStaticKeyProvider } from "../../src/encryption/keyProvider.js";

const dec = new TextDecoder();
let publicKey: Awaited<ReturnType<typeof generateKeyPair>>["publicKey"];
let privateKey: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];

beforeAll(async () => {
  const pair = await generateKeyPair("RSA-OAEP-256");
  publicKey = pair.publicKey;
  privateKey = pair.privateKey;
});

let app: FastifyInstance;
afterEach(async () => {
  await app?.close();
});

function jweProvider() {
  return createStaticKeyProvider({
    encryptionKey: { kid: "k1", key: publicKey },
    decryptionKeys: { k1: privateKey },
  });
}

describe("encryptionPlugin — full-body JWE", () => {
  it("encrypts a JSON response into a JWE the private key decrypts", async () => {
    app = Fastify({ logger: false });
    await app.register(encryptionPlugin, { mode: "jwe", keyProvider: jweProvider() });
    app.get(
      "/secret",
      { config: { arcExtensions: { encryption: { mode: "jwe" } } } },
      async () => ({ ssn: "123-45-6789" }),
    );
    await app.ready();

    const res = await app.inject({ url: "/secret" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/jose");
    expect(res.headers["x-encrypted"]).toBe("true");
    expect(res.body).not.toContain("123-45-6789"); // opaque on the wire

    const { plaintext } = await compactDecrypt(res.body, privateKey, {
      keyManagementAlgorithms: ["RSA-OAEP-256"],
      contentEncryptionAlgorithms: ["A256GCM"],
    });
    expect(JSON.parse(dec.decode(plaintext))).toEqual({ ssn: "123-45-6789" });
  });

  it("leaves non-opted-in routes as plaintext JSON", async () => {
    app = Fastify({ logger: false });
    await app.register(encryptionPlugin, { mode: "jwe", keyProvider: jweProvider() });
    app.get("/public", async () => ({ ok: true }));
    await app.ready();

    const res = await app.inject({ url: "/public" });
    expect(res.headers["content-type"]).toContain("application/json");
    expect(res.json()).toEqual({ ok: true });
    expect(res.headers["x-encrypted"]).toBeUndefined();
  });

  it("encrypts via the plugin-level route matcher when no route config is set", async () => {
    app = Fastify({ logger: false });
    await app.register(encryptionPlugin, {
      mode: "jwe",
      keyProvider: jweProvider(),
      routes: (req) => req.url.startsWith("/pay"),
    });
    app.get("/pay/balance", async () => ({ balance: 42 }));
    await app.ready();

    const res = await app.inject({ url: "/pay/balance" });
    expect(res.headers["content-type"]).toContain("application/jose");
    const { plaintext } = await compactDecrypt(res.body, privateKey);
    expect(JSON.parse(dec.decode(plaintext))).toEqual({ balance: 42 });
  });

  it("honours an explicit per-resource opt-out over the matcher", async () => {
    app = Fastify({ logger: false });
    await app.register(encryptionPlugin, {
      mode: "jwe",
      keyProvider: jweProvider(),
      routes: () => true,
    });
    app.get(
      "/skip",
      { config: { arcExtensions: { encryption: { enabled: false } } } },
      async () => ({ ok: true }),
    );
    await app.ready();

    const res = await app.inject({ url: "/skip" });
    expect(res.json()).toEqual({ ok: true });
    expect(res.headers["x-encrypted"]).toBeUndefined();
  });
});

describe("encryptionPlugin — field-level", () => {
  it("encrypts only the named fields, preserving the JSON shape", async () => {
    const key = randomBytes(32);
    app = Fastify({ logger: false });
    await app.register(encryptionPlugin, {
      mode: "fields",
      keyProvider: createStaticKeyProvider({ encryptionKey: { kid: "f1", key } }),
    });
    app.get(
      "/account",
      { config: { arcExtensions: { encryption: { mode: "fields", fields: ["cardNumber"] } } } },
      async () => ({ cardNumber: "4111111111111111", holder: "Jane" }),
    );
    await app.ready();

    const res = await app.inject({ url: "/account" });
    const body = res.json() as { cardNumber: string; holder: string };
    expect(res.headers["content-type"]).toContain("application/json"); // shape preserved
    expect(res.headers["x-encrypted"]).toBe("true");
    expect(body.holder).toBe("Jane"); // untouched
    expect(body.cardNumber.startsWith("arc.v1.")).toBe(true); // encrypted in place

    const parsed = parseFieldEnvelope(body.cardNumber)!;
    expect(JSON.parse(decryptField(parsed, key))).toBe("4111111111111111");
  });
});

describe("encryptionPlugin — inbound decryption", () => {
  it("decrypts an application/jose request body before the handler", async () => {
    app = Fastify({ logger: false });
    await app.register(encryptionPlugin, { mode: "jwe", keyProvider: jweProvider() });
    app.post("/ingest", async (req) => ({ received: req.body, decrypted: req.requestDecrypted }));
    await app.ready();

    const jwe = await new CompactEncrypt(new TextEncoder().encode(JSON.stringify({ amount: 100 })))
      .setProtectedHeader({ alg: "RSA-OAEP-256", enc: "A256GCM", kid: "k1" })
      .encrypt(publicKey);

    const res = await app.inject({
      method: "POST",
      url: "/ingest",
      headers: { "content-type": "application/jose" },
      payload: jwe,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ received: { amount: 100 }, decrypted: true });
  });

  it("rejects a JWE whose kid has no key", async () => {
    app = Fastify({ logger: false });
    await app.register(encryptionPlugin, {
      mode: "jwe",
      keyProvider: createStaticKeyProvider({
        encryptionKey: { kid: "k1", key: publicKey },
        // no private key registered → inbound decrypt cannot resolve
        decryptionKeys: {},
      }),
    });
    app.post("/ingest", async (req) => ({ received: req.body }));
    await app.ready();

    const jwe = await new CompactEncrypt(new TextEncoder().encode("{}"))
      .setProtectedHeader({ alg: "RSA-OAEP-256", enc: "A256GCM", kid: "k1" })
      .encrypt(publicKey);

    const res = await app.inject({
      method: "POST",
      url: "/ingest",
      headers: { "content-type": "application/jose" },
      payload: jwe,
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });
});

describe("encryptionPlugin — disabled", () => {
  it("is a no-op when enabled: false", async () => {
    app = Fastify({ logger: false });
    await app.register(encryptionPlugin, {
      enabled: false,
      keyProvider: jweProvider(),
    });
    app.get(
      "/secret",
      { config: { arcExtensions: { encryption: { mode: "jwe" } } } },
      async () => ({ ssn: "x" }),
    );
    await app.ready();

    const res = await app.inject({ url: "/secret" });
    expect(res.json()).toEqual({ ssn: "x" });
    expect(res.headers["x-encrypted"]).toBeUndefined();
  });
});
