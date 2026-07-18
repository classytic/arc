/**
 * toFetchHandler — buffered-adapter hardening (2.23).
 *
 * The adapter is a fetch-compatible BUFFERED bridge over `app.inject()`.
 * These tests pin the fixes from the external review:
 *  1. Binary request bodies survive intact (`arrayBuffer()`, not `text()` —
 *     UTF-8 decoding corrupted protobuf/image payloads).
 *  2. Binary response bodies return byte-for-byte (`rawPayload`).
 *  3. `maxRequestBytes` rejects oversized bodies with 413 before buffering.
 *  4. Concurrent cold-start requests share ONE readiness promise instead of
 *     racing a boolean.
 */

import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { toFetchHandler } from "../../src/factory/edge.js";

let app: FastifyInstance;

afterEach(async () => {
  await app?.close();
});

async function makeBinaryApp(): Promise<FastifyInstance> {
  // bodyLimit raised so these tests exercise the ADAPTER's gate — with the
  // gate disabled, Fastify's own bodyLimit is the (documented) backstop.
  const instance = Fastify({ logger: false, bodyLimit: 5 * 1024 * 1024 });
  instance.addContentTypeParser(
    "application/octet-stream",
    { parseAs: "buffer" },
    (_req, body, done) => done(null, body),
  );
  instance.post("/echo-bytes", async (req, reply) => {
    const body = req.body as Buffer;
    reply.header("content-type", "application/octet-stream");
    return reply.send(body);
  });
  instance.get("/binary", async (_req, reply) => {
    reply.header("content-type", "application/octet-stream");
    return reply.send(Buffer.from([0x00, 0xff, 0x80, 0x7f, 0x01]));
  });
  return instance;
}

describe("toFetchHandler — binary fidelity", () => {
  it("round-trips a binary request body byte-for-byte", async () => {
    app = await makeBinaryApp();
    const handler = toFetchHandler(app);

    // Bytes that are NOT valid UTF-8 — `text()` would mangle them.
    const bytes = new Uint8Array([0x00, 0xc3, 0x28, 0xff, 0xfe, 0x80]);
    const res = await handler(
      new Request("http://edge/echo-bytes", {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: bytes,
      }),
    );
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
  });

  it("returns binary response bodies intact", async () => {
    app = await makeBinaryApp();
    const handler = toFetchHandler(app);
    const res = await handler(new Request("http://edge/binary"));
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(
      new Uint8Array([0x00, 0xff, 0x80, 0x7f, 0x01]),
    );
  });
});

describe("toFetchHandler — maxRequestBytes", () => {
  it("rejects a declared-oversize body with 413 before buffering", async () => {
    app = await makeBinaryApp();
    const handler = toFetchHandler(app, { maxRequestBytes: 16 });
    const res = await handler(
      new Request("http://edge/echo-bytes", {
        method: "POST",
        headers: { "content-type": "application/octet-stream", "content-length": "1000" },
        body: new Uint8Array(1000),
      }),
    );
    expect(res.status).toBe(413);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("arc.payload_too_large");
  });

  it("rejects an actually-oversize body even without content-length", async () => {
    app = await makeBinaryApp();
    const handler = toFetchHandler(app, { maxRequestBytes: 16 });
    // ReadableStream body → fetch Request carries no usable content-length.
    const req = new Request("http://edge/echo-bytes", {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: new Uint8Array(64),
    });
    req.headers.delete("content-length");
    const res = await handler(req);
    expect(res.status).toBe(413);
  });

  it("allows bodies under the limit, and maxRequestBytes: 0 disables the gate", async () => {
    app = await makeBinaryApp();
    const small = toFetchHandler(app, { maxRequestBytes: 1024 });
    const okRes = await small(
      new Request("http://edge/echo-bytes", {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: new Uint8Array(8),
      }),
    );
    expect(okRes.status).toBe(200);

    const unlimited = toFetchHandler(app, { maxRequestBytes: 0 });
    const bigRes = await unlimited(
      new Request("http://edge/echo-bytes", {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: new Uint8Array(2_000_000),
      }),
    );
    expect(bigRes.status).toBe(200);
  });
});

describe("toFetchHandler — shared readiness", () => {
  it("concurrent cold-start requests await ONE app.ready() call", async () => {
    app = Fastify({ logger: false });
    app.get("/ping", async () => ({ ok: true }));
    const readySpy = vi.spyOn(app, "ready");

    const handler = toFetchHandler(app);
    const responses = await Promise.all([
      handler(new Request("http://edge/ping")),
      handler(new Request("http://edge/ping")),
      handler(new Request("http://edge/ping")),
    ]);
    for (const res of responses) expect(res.status).toBe(200);
    expect(readySpy).toHaveBeenCalledTimes(1);
  });
});
