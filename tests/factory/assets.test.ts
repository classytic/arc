/**
 * Static asset roots — the policy layer over `@fastify/static`.
 *
 * The headline assertion is the one that motivated the feature: arc's app-wide
 * security headers include `Cross-Origin-Resource-Policy: same-origin`, which
 * makes a browser DISCARD an asset a cross-origin document tried to embed — the
 * request returns 200, CORS negotiates fine, and the console blames neither. A
 * per-prefix override is the fix, and it must not leak to the API surface.
 *
 * The transport mechanics (ranges, ETag/304, dotfile refusal) are
 * `@fastify/static`'s, not arc's — asserted here only to prove arc wires them on
 * rather than silently disabling them.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveAssetPolicy } from "../../src/factory/assets.js";
import { createApp } from "../../src/factory/index.js";

const FIXTURE = path.join(tmpdir(), "arc-assets-test");

beforeAll(() => {
  rmSync(FIXTURE, { recursive: true, force: true });
  mkdirSync(FIXTURE, { recursive: true });
  writeFileSync(path.join(FIXTURE, "logo.png"), "hello-static-bytes");
  writeFileSync(path.join(FIXTURE, ".env"), "SECRET=1");
});

afterAll(() => {
  rmSync(FIXTURE, { recursive: true, force: true });
});

describe("resolveAssetPolicy", () => {
  it("defaults are the safe ones — revalidate, same-site, attachment", () => {
    expect(resolveAssetPolicy({ prefix: "/x", root: FIXTURE })).toEqual({
      cacheControl: "public, max-age=0, must-revalidate",
      crossOriginResourcePolicy: "same-site",
      disposition: "attachment",
      varyOrigin: true,
    });
  });

  it("`immutable` is opt-in — it must never be the default for a mutable path", () => {
    // A hashed filename can be cached for a year; a mutable one would serve
    // stale bytes for a year with no recovery, so arc cannot guess.
    expect(
      resolveAssetPolicy({ prefix: "/x", root: FIXTURE, cache: "immutable" }).cacheControl,
    ).toBe("public, max-age=31536000, immutable");
    expect(resolveAssetPolicy({ prefix: "/x", root: FIXTURE, cache: "none" }).cacheControl).toBe(
      "no-store",
    );
  });

  it("same-origin needs no Vary: Origin — nothing varies by caller", () => {
    expect(
      resolveAssetPolicy({ prefix: "/x", root: FIXTURE, crossOrigin: "same-origin" }).varyOrigin,
    ).toBe(false);
  });
});

describe("asset roots — served", () => {
  it("overrides CORP for the prefix WITHOUT relaxing the API surface", async () => {
    const app = await createApp({
      auth: false,
      logger: false,
      assets: [{ prefix: "/uploads", root: FIXTURE, crossOrigin: "cross-origin" }],
      plugins: async (f) => {
        f.get("/api/thing", () => ({ ok: true }));
      },
    });
    await app.ready();
    try {
      const asset = await app.inject({ method: "GET", url: "/uploads/logo.png" });
      const api = await app.inject({ method: "GET", url: "/api/thing" });

      expect(asset.statusCode).toBe(200);
      expect(asset.headers["cross-origin-resource-policy"]).toBe("cross-origin");
      // THE scoping guarantee — the app-wide default still governs the API.
      expect(api.headers["cross-origin-resource-policy"]).toBe("same-origin");
    } finally {
      await app.close();
    }
  });

  it("applies arc's header policy per file", async () => {
    const app = await createApp({
      auth: false,
      logger: false,
      assets: [{ prefix: "/uploads", root: FIXTURE }],
    });
    await app.ready();
    try {
      const res = await app.inject({ method: "GET", url: "/uploads/logo.png" });
      expect(res.headers["cache-control"]).toBe("public, max-age=0, must-revalidate");
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
      // Untrusted uploads download rather than render — an inline .svg/.html
      // would execute on this origin.
      expect(res.headers["content-disposition"]).toContain("attachment");
      expect(res.headers["content-disposition"]).toContain(`filename="logo.png"`);
    } finally {
      await app.close();
    }
  });

  it("keeps @fastify/static's mechanics on: ETag/304, byte ranges, dotfile refusal", async () => {
    const app = await createApp({
      auth: false,
      logger: false,
      assets: [{ prefix: "/uploads", root: FIXTURE }],
    });
    await app.ready();
    try {
      const first = await app.inject({ method: "GET", url: "/uploads/logo.png" });
      expect(first.headers.etag).toBeDefined();
      expect(first.headers["accept-ranges"]).toBe("bytes");

      // Conditional revalidation — what makes the `revalidate` default cheap.
      const revalidated = await app.inject({
        method: "GET",
        url: "/uploads/logo.png",
        headers: { "if-none-match": String(first.headers.etag) },
      });
      expect(revalidated.statusCode).toBe(304);

      // Byte range — audio/video seeking and resumable downloads.
      const ranged = await app.inject({
        method: "GET",
        url: "/uploads/logo.png",
        headers: { range: "bytes=0-4" },
      });
      expect(ranged.statusCode).toBe(206);
      expect(ranged.body).toBe("hello");
      expect(ranged.headers["content-range"]).toBe("bytes 0-4/18");

      // `.env` / `.git` get deployed by accident — refuse hidden files outright.
      const dotfile = await app.inject({ method: "GET", url: "/uploads/.env" });
      expect(dotfile.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });

  it("a duplicate prefix fails at BOOT, naming both roots", async () => {
    // Two roots on one prefix means the second silently never serves, and the
    // symptom is a 404 for files that exist on disk.
    await expect(
      createApp({
        auth: false,
        logger: false,
        assets: [
          { prefix: "/uploads", root: FIXTURE },
          { prefix: "/uploads", root: tmpdir() },
        ],
      }),
    ).rejects.toThrow(/duplicate asset prefix "\/uploads"/);
  });

  it("a synchronous allowedPath gate refuses without reaching the file", async () => {
    // `@fastify/static`'s signature is sync-boolean, so an async permission
    // check cannot run here — this is the seam for a signed-URL HMAC check.
    const app = await createApp({
      auth: false,
      logger: false,
      assets: [
        {
          prefix: "/uploads",
          root: FIXTURE,
          allowedPath: (pathName) => !pathName.includes("logo"),
        },
      ],
    });
    await app.ready();
    try {
      expect((await app.inject({ method: "GET", url: "/uploads/logo.png" })).statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});
