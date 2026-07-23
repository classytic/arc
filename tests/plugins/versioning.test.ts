import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

// ============================================================================
// Supported-version enforcement
// ============================================================================

describe("versioning — supported-version enforcement", () => {
  // Without `versions`, the plugin is detection-only (annotate + deprecate).
  // With it, unknown versions are rejected with 400 arc.unsupported_api_version
  // before the handler runs.
  let vApp: FastifyInstance;

  afterEach(async () => {
    await vApp?.close();
  });

  it("rejects an unsupported header version with 400", async () => {
    vApp = Fastify({ logger: false });
    await vApp.register(versioningPlugin, { type: "header", versions: ["1", "2"] });
    vApp.get("/items", async () => ({ ok: true }));
    await vApp.ready();

    const res = await vApp.inject({
      method: "GET",
      url: "/items",
      headers: { "accept-version": "99" },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.json())).toContain("99");
  });

  it("accepts a supported version and stamps the response header", async () => {
    vApp = Fastify({ logger: false });
    await vApp.register(versioningPlugin, { type: "header", versions: ["1", "2"] });
    vApp.get("/items", async (req) => ({ version: req.apiVersion }));
    await vApp.ready();

    const res = await vApp.inject({
      method: "GET",
      url: "/items",
      headers: { "accept-version": "2" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ version: "2" });
    expect(res.headers["x-api-version"]).toBe("2");
  });

  it("versionless requests resolve to the default and are never rejected", async () => {
    vApp = Fastify({ logger: false });
    await vApp.register(versioningPlugin, { type: "header", versions: ["1", "2"] });
    vApp.get("/items", async (req) => ({ version: req.apiVersion }));
    await vApp.ready();

    const res = await vApp.inject({ method: "GET", url: "/items" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ version: "1" });
  });

  it("rejects an unsupported prefix version", async () => {
    vApp = Fastify({ logger: false });
    await vApp.register(versioningPlugin, { type: "prefix", versions: ["1"] });
    vApp.get("/v1/items", async () => ({ ok: true }));
    vApp.get("/v2/items", async () => ({ ok: true }));
    await vApp.ready();

    expect((await vApp.inject({ method: "GET", url: "/v1/items" })).statusCode).toBe(200);
    expect((await vApp.inject({ method: "GET", url: "/v2/items" })).statusCode).toBe(400);
  });

  it("without `versions`, any requested version is accepted (detection-only back-compat)", async () => {
    vApp = Fastify({ logger: false });
    await vApp.register(versioningPlugin, { type: "header" });
    vApp.get("/items", async (req) => ({ version: req.apiVersion }));
    await vApp.ready();

    const res = await vApp.inject({
      method: "GET",
      url: "/items",
      headers: { "accept-version": "99" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ version: "99" });
  });

  it("throws at registration when defaultVersion is not in versions", async () => {
    vApp = Fastify({ logger: false });
    await expect(
      vApp
        .register(versioningPlugin, { type: "header", versions: ["2", "3"], defaultVersion: "1" })
        .ready(),
    ).rejects.toThrow(/defaultVersion '1' is not in versions/);
  });

  it("deprecation headers still apply to supported-but-deprecated versions", async () => {
    vApp = Fastify({ logger: false });
    await vApp.register(versioningPlugin, {
      type: "header",
      versions: ["1", "2"],
      deprecated: ["1"],
      sunset: "2026-01-01",
    });
    vApp.get("/items", async () => ({ ok: true }));
    await vApp.ready();

    const res = await vApp.inject({
      method: "GET",
      url: "/items",
      headers: { "accept-version": "1" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers.deprecation).toBe("true");
    expect(res.headers.sunset).toBe("2026-01-01");
  });
});
