/**
 * Versioning Plugin — createApp Integration Suite
 *
 * Verifies end-to-end: createApp → versioningPlugin → version headers,
 * header-based extraction, prefix-based extraction, deprecation warnings,
 * default version fallback, and opt-out.
 */

import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/factory/createApp.js";

describe("createApp — versioning plugin", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    if (app) await app.close().catch(() => {});
    vi.restoreAllMocks();
  });

  // ==========================================================================
  // Registration
  // ==========================================================================

  describe("registration", () => {
    it("registers when arcPlugins.versioning is set", async () => {
      app = await createApp({
        preset: "testing",
        auth: false,
        arcPlugins: { versioning: { type: "header" } },
      });

      expect(app.hasRequestDecorator("apiVersion")).toBe(true);
    });

    it("does NOT register when absent", async () => {
      app = await createApp({ preset: "testing", auth: false });

      expect(app.hasRequestDecorator("apiVersion")).toBe(false);
    });
  });

  // ==========================================================================
  // Header-based versioning
  // ==========================================================================

  describe("header-based versioning", () => {
    it("extracts version from Accept-Version header", async () => {
      app = await createApp({
        preset: "testing",
        auth: false,
        arcPlugins: { versioning: { type: "header" } },
      });

      app.get("/test", async (request) => ({
        version: (request as unknown as { apiVersion: string }).apiVersion,
      }));

      const res = await app.inject({
        method: "GET",
        url: "/test",
        headers: { "accept-version": "2" },
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).version).toBe("2");
    });

    it("defaults to version 1 when no header present", async () => {
      app = await createApp({
        preset: "testing",
        auth: false,
        arcPlugins: { versioning: { type: "header", defaultVersion: "1" } },
      });

      app.get("/test", async (request) => ({
        version: (request as unknown as { apiVersion: string }).apiVersion,
      }));

      const res = await app.inject({ method: "GET", url: "/test" });
      expect(JSON.parse(res.body).version).toBe("1");
    });

    it("sets x-api-version response header", async () => {
      app = await createApp({
        preset: "testing",
        auth: false,
        arcPlugins: { versioning: { type: "header" } },
      });

      app.get("/test", async () => ({ ok: true }));

      const res = await app.inject({
        method: "GET",
        url: "/test",
        headers: { "accept-version": "5" },
      });

      expect(res.headers["x-api-version"]).toBe("5");
    });
  });

  // ==========================================================================
  // Prefix-based versioning
  // ==========================================================================

  describe("prefix-based versioning", () => {
    it("extracts version from URL prefix /v{n}/", async () => {
      app = await createApp({
        preset: "testing",
        auth: false,
        arcPlugins: { versioning: { type: "prefix" } },
      });

      app.get("/v2/test", async (request) => ({
        version: (request as unknown as { apiVersion: string }).apiVersion,
      }));

      const res = await app.inject({ method: "GET", url: "/v2/test" });
      expect(JSON.parse(res.body).version).toBe("2");
    });

    it("defaults to version 1 for non-versioned paths", async () => {
      app = await createApp({
        preset: "testing",
        auth: false,
        arcPlugins: { versioning: { type: "prefix", defaultVersion: "1" } },
      });

      app.get("/test", async (request) => ({
        version: (request as unknown as { apiVersion: string }).apiVersion,
      }));

      const res = await app.inject({ method: "GET", url: "/test" });
      expect(JSON.parse(res.body).version).toBe("1");
    });
  });

  // ==========================================================================
  // Deprecation warnings
  // ==========================================================================

  describe("deprecation warnings", () => {
    it("adds Deprecation header for deprecated versions", async () => {
      app = await createApp({
        preset: "testing",
        auth: false,
        arcPlugins: { versioning: { type: "header", deprecated: ["1"] } },
      });

      app.get("/test", async () => ({ ok: true }));

      const res = await app.inject({
        method: "GET",
        url: "/test",
        headers: { "accept-version": "1" },
      });

      expect(res.headers.deprecation).toBe("true");
      expect(res.headers.sunset).toBeDefined();
    });

    it("uses custom sunset date", async () => {
      app = await createApp({
        preset: "testing",
        auth: false,
        arcPlugins: {
          versioning: { type: "header", deprecated: ["1"], sunset: "2026-01-01T00:00:00Z" },
        },
      });

      app.get("/test", async () => ({ ok: true }));

      const res = await app.inject({
        method: "GET",
        url: "/test",
        headers: { "accept-version": "1" },
      });

      expect(res.headers.sunset).toBe("2026-01-01T00:00:00Z");
    });

    it("does NOT add Deprecation header for current versions", async () => {
      app = await createApp({
        preset: "testing",
        auth: false,
        arcPlugins: { versioning: { type: "header", deprecated: ["1"] } },
      });

      app.get("/test", async () => ({ ok: true }));

      const res = await app.inject({
        method: "GET",
        url: "/test",
        headers: { "accept-version": "2" },
      });

      expect(res.headers.deprecation).toBeUndefined();
    });
  });
});
