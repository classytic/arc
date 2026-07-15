/**
 * Server timeout + trustProxy pass-throughs (2.22)
 *
 * `requestTimeout` / `connectionTimeout` / `keepAliveTimeout` flow to the
 * Fastify constructor, and `trustProxy` accepts every Fastify form
 * (boolean | hop count | CIDR string | CIDR list) — pre-2.22 the type
 * admitted only booleans, forcing hosts behind one LB into the
 * trust-everything setting.
 */

import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/factory/createApp.js";

describe("server timeout and trustProxy pass-throughs", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app?.close().catch(() => {});
  });

  it("passes requestTimeout / connectionTimeout / keepAliveTimeout to Fastify", async () => {
    app = await createApp({
      preset: "testing",
      auth: false,
      requestTimeout: 30_000,
      connectionTimeout: 15_000,
      keepAliveTimeout: 65_000,
    });
    expect(app.initialConfig.requestTimeout).toBe(30_000);
    expect(app.initialConfig.connectionTimeout).toBe(15_000);
    expect(app.initialConfig.keepAliveTimeout).toBe(65_000);
  });

  it("leaves Fastify defaults untouched when not configured", async () => {
    app = await createApp({ preset: "testing", auth: false });
    expect(app.initialConfig.requestTimeout).toBe(0);
    expect(app.initialConfig.connectionTimeout).toBe(0);
  });

  it("accepts hop-count trustProxy form (behavioral: request.ip honors one XFF hop)", async () => {
    // initialConfig doesn't expose trustProxy — assert the behavior.
    app = await createApp({ preset: "testing", auth: false, trustProxy: 1 });
    app.get("/ip", async (request) => ({ ip: request.ip }));
    await app.ready();

    const res = await app.inject({
      method: "GET",
      url: "/ip",
      headers: { "x-forwarded-for": "203.0.113.7" },
    });
    expect(res.json().ip).toBe("203.0.113.7");
  });

  it("accepts CIDR trustProxy form (non-matching proxy is NOT trusted)", async () => {
    app = await createApp({ preset: "testing", auth: false, trustProxy: "10.0.0.0/8" });
    app.get("/ip", async (request) => ({ ip: request.ip }));
    await app.ready();

    // inject() connects from 127.0.0.1, outside 10.0.0.0/8 → XFF is ignored.
    const res = await app.inject({
      method: "GET",
      url: "/ip",
      headers: { "x-forwarded-for": "203.0.113.7" },
    });
    expect(res.json().ip).not.toBe("203.0.113.7");
  });
});
