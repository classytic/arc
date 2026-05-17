/**
 * Tests for the `maxParamLength` option on `createApp()` (2.16).
 *
 * Reproduces the OpenAI-team report's P0: Fastify defaults
 * `maxParamLength` to 100, so a route param longer than 100 chars
 * silently 404s. HMAC tracking tokens (~250), magic-link tokens,
 * JWT-in-URL, OAuth state params all break — and the failure mode is
 * indistinguishable from "route not registered" until you trace it.
 *
 * Contract this file locks in:
 *  - Arc's default is 400 (not Fastify's 100).
 *  - `createApp({ maxParamLength: N })` is honored end-to-end.
 *  - A signed token of typical length (256 chars) routes correctly
 *    against arc's default, without the host having to opt in.
 */

import { describe, expect, it } from "vitest";
import { createApp } from "../../src/factory/createApp.js";

describe("createApp — maxParamLength (2.16)", () => {
  it("defaults to 400 — tokens longer than Fastify's 100-char default route correctly", async () => {
    // The exact scenario the mentora / OpenAI-team report flagged.
    // 256-char HMAC token (well above Fastify's default 100) sitting
    // in a path segment — Fastify would 404 pre-2.16, arc routes it
    // because the default is 400.
    const app = await createApp({
      preset: "development",
      auth: false,
      logger: false,
      helmet: false,
      cors: false,
      rateLimit: false,
      plugins: async (fastify) => {
        fastify.get("/track/:token", async (req) => {
          return { token: (req.params as { token: string }).token };
        });
      },
    });
    try {
      const token = "a".repeat(256);
      const res = await app.inject({ method: "GET", url: `/track/${token}` });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).token).toBe(token);
    } finally {
      await app.close();
    }
  });

  it("honors an explicit override — hosts can raise further for long JWTs", async () => {
    // 800-char param exceeds arc's default 400; host opts up to 1024.
    const app = await createApp({
      preset: "development",
      auth: false,
      logger: false,
      helmet: false,
      cors: false,
      rateLimit: false,
      maxParamLength: 1024,
      plugins: async (fastify) => {
        fastify.get("/jwt/:token", async (req) => {
          return { token: (req.params as { token: string }).token };
        });
      },
    });
    try {
      const token = "a".repeat(800);
      const res = await app.inject({ method: "GET", url: `/jwt/${token}` });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).token).toBe(token);
    } finally {
      await app.close();
    }
  });

  it("honors a tighter explicit override — hosts can clamp below the default", async () => {
    // Auditors may want a tighter limit. 200 chars max → a 250-char
    // token fails with 404 (Fastify rejects before routing).
    const app = await createApp({
      preset: "development",
      auth: false,
      logger: false,
      helmet: false,
      cors: false,
      rateLimit: false,
      maxParamLength: 50,
      plugins: async (fastify) => {
        fastify.get("/short/:token", async () => ({ ok: true }));
      },
    });
    try {
      // 100-char param exceeds the tightened 50-char limit → 404.
      const res = await app.inject({
        method: "GET",
        url: `/short/${"a".repeat(100)}`,
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});
