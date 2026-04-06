import { describe, expect, it, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { versioningPlugin } from "../../src/plugins/versioning.js";

describe("versioningPlugin — header mode", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = Fastify();
    await app.register(versioningPlugin, { type: "header" });
    app.get("/test", async (req) => ({ version: req.apiVersion }));
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it("defaults to version 1 when no header", async () => {
    const res = await app.inject({ method: "GET", url: "/test" });
    expect(res.json().version).toBe("1");
    expect(res.headers["x-api-version"]).toBe("1");
  });

  it("reads version from Accept-Version header", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/test",
      headers: { "accept-version": "3" },
    });
    expect(res.json().version).toBe("3");
    expect(res.headers["x-api-version"]).toBe("3");
  });
});

describe("versioningPlugin — prefix mode", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = Fastify();
    await app.register(versioningPlugin, { type: "prefix" });
    app.get("/v2/test", async (req) => ({ version: req.apiVersion }));
    app.get("/test", async (req) => ({ version: req.apiVersion }));
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it("extracts version from URL prefix", async () => {
    const res = await app.inject({ method: "GET", url: "/v2/test" });
    expect(res.json().version).toBe("2");
  });

  it("defaults to version 1 for non-versioned URLs", async () => {
    const res = await app.inject({ method: "GET", url: "/test" });
    expect(res.json().version).toBe("1");
  });
});

describe("versioningPlugin — deprecation", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = Fastify();
    await app.register(versioningPlugin, {
      type: "header",
      deprecated: ["1"],
      sunset: "2026-12-31T00:00:00Z",
    });
    app.get("/test", async (req) => ({ version: req.apiVersion }));
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it("adds deprecation headers for deprecated versions", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/test",
      headers: { "accept-version": "1" },
    });
    expect(res.headers.deprecation).toBe("true");
    expect(res.headers.sunset).toBe("2026-12-31T00:00:00Z");
  });

  it("does not add deprecation headers for current versions", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/test",
      headers: { "accept-version": "2" },
    });
    expect(res.headers.deprecation).toBeUndefined();
  });
});

describe("versioningPlugin — custom options", () => {
  it("supports custom header name", async () => {
    const app = Fastify();
    await app.register(versioningPlugin, {
      type: "header",
      headerName: "x-api-version",
      defaultVersion: "5",
    });
    app.get("/test", async (req) => ({ version: req.apiVersion }));
    await app.ready();

    const res = await app.inject({
      method: "GET",
      url: "/test",
      headers: { "x-api-version": "7" },
    });
    expect(res.json().version).toBe("7");
    await app.close();
  });

  it("uses custom default version", async () => {
    const app = Fastify();
    await app.register(versioningPlugin, { type: "header", defaultVersion: "3" });
    app.get("/test", async (req) => ({ version: req.apiVersion }));
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/test" });
    expect(res.json().version).toBe("3");
    await app.close();
  });
});
