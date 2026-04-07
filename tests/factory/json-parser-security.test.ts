/**
 * JSON Parser Security Tests
 *
 * Verifies that createApp's custom JSON parser:
 * 1. Handles empty bodies gracefully (the reason for the override)
 * 2. Preserves prototype poisoning protection (via secure-json-parse)
 * 3. Rejects __proto__ and constructor.prototype payloads
 */

import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/factory/createApp.js";

describe("JSON parser security", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    if (app) await app.close();
  });

  async function makeApp(): Promise<FastifyInstance> {
    app = await createApp({
      preset: "testing",
      auth: false,
    });
    app.post("/echo", async (request) => {
      return { body: request.body };
    });
    app.delete("/item/:id", async () => {
      return { deleted: true };
    });
    await app.ready();
    return app;
  }

  // ── Empty body handling (the reason for the override) ──

  it("accepts DELETE with empty JSON body", async () => {
    await makeApp();
    const res = await app.inject({
      method: "DELETE",
      url: "/item/123",
      headers: { "content-type": "application/json" },
      body: "",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().deleted).toBe(true);
  });

  it("accepts POST with valid JSON body", async () => {
    await makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/echo",
      payload: { name: "test", value: 42 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().body).toEqual({ name: "test", value: 42 });
  });

  it("rejects malformed JSON with error status", async () => {
    await makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/echo",
      headers: { "content-type": "application/json" },
      body: "{ invalid json",
    });
    // Parser error — Fastify returns 4xx or 5xx depending on error handler
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });

  // ── Prototype poisoning protection (secure-json-parse) ──

  it("rejects __proto__ poisoning in JSON body", async () => {
    await makeApp();
    const malicious = '{"__proto__": {"isAdmin": true}}';
    const res = await app.inject({
      method: "POST",
      url: "/echo",
      headers: { "content-type": "application/json" },
      body: malicious,
    });
    // secure-json-parse throws "Object contains forbidden prototype property"
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    // Critical: Object.prototype must NOT be polluted
    expect(({} as Record<string, unknown>).isAdmin).toBeUndefined();
  });

  it("rejects constructor.prototype poisoning", async () => {
    await makeApp();
    const malicious = '{"constructor": {"prototype": {"isAdmin": true}}}';
    const res = await app.inject({
      method: "POST",
      url: "/echo",
      headers: { "content-type": "application/json" },
      body: malicious,
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(({} as Record<string, unknown>).isAdmin).toBeUndefined();
  });

  it("rejects nested __proto__ poisoning", async () => {
    await makeApp();
    const malicious = '{"user": {"__proto__": {"role": "admin"}}}';
    const res = await app.inject({
      method: "POST",
      url: "/echo",
      headers: { "content-type": "application/json" },
      body: malicious,
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(({} as Record<string, unknown>).role).toBeUndefined();
  });

  it("allows normal objects with 'constructor' as a value (not poisoning)", async () => {
    await makeApp();
    // This is a normal object, not prototype poisoning
    const safe = '{"constructor": "BuildingA"}';
    const res = await app.inject({
      method: "POST",
      url: "/echo",
      headers: { "content-type": "application/json" },
      body: safe,
    });
    // secure-json-parse allows string values for constructor (only blocks nested prototype)
    expect(res.statusCode).toBe(200);
    expect(res.json().body.constructor).toBe("BuildingA");
  });
});
