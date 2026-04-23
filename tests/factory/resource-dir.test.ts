/**
 * resourceDir — auto-discover resources from a directory path
 *
 * Tests:
 * 1. resourceDir loads resources without explicit resources array
 * 2. explicit resources[] takes priority over resourceDir
 * 3. resourceDir with resourcePrefix applies prefix
 * 4. [v2.10.9] zero-discovery logs a warn with the absolute path
 * 5. [v2.10.9] strictResourceDir: true throws instead of warning
 * 6. [v2.10.9] resourceDir accepts `import.meta.url` (file:// URL)
 * 7. [v2.10.9] strictResources: true throws on duplicate resource names
 */

import { afterAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { createApp } from "../../src/factory/createApp.js";
import { defineResource } from "../../src/core/defineResource.js";

// We can't easily create .resource.ts files on disk in a test, but we CAN
// test that resourceDir is wired correctly by pointing at a dir that exists
// but has no .resource.ts files — it should produce an app with 0 resources.

describe("createApp — resourceDir option", () => {
  const apps: FastifyInstance[] = [];

  afterAll(async () => {
    for (const app of apps) await app?.close();
  });

  it("creates app with 0 resources when resourceDir has no .resource.ts files", async () => {
    const app = await createApp({
      preset: "testing",
      auth: false,
      logger: false,
      // Point at tests/ — no .resource.ts files there
      resourceDir: "tests/utils",
    });
    apps.push(app);
    await app.ready();

    // App boots successfully with 0 resources — verify it's alive
    expect(app.server).toBeDefined();
  });

  it("explicit resources[] takes priority over resourceDir", async () => {
    const resource = defineResource({
      name: "priority-test",
      prefix: "/priority",
      disableDefaultRoutes: true,
      actions: {
        ping: async () => ({ pong: true }),
      },
      actionPermissions: (() => true) as import("../../src/types/index.js").PermissionCheck,
    });

    const app = await createApp({
      preset: "testing",
      auth: false,
      logger: false,
      resources: [resource],
      resourceDir: "nonexistent-dir", // should be ignored
    });
    apps.push(app);
    await app.ready();

    // The explicit resource IS registered
    const res = await app.inject({
      method: "POST",
      url: "/priority/test-id/action",
      payload: { action: "ping" },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data.pong).toBe(true);
  });

  // v2.10.9 — silent zero-discovery was the exact shape of a reported
  // prod outage (deployed app served 404 on every /api/v1/* for an
  // unknown window before anyone noticed). Arc now logs loudly by
  // default and offers a strict-mode throw for prod boots.
  describe("v2.10.9 — resourceDir hardening", () => {
    it("zero-discovery emits a warn with the raw input and the absolute resolved path", async () => {
      const warns: string[] = [];
      const logger = {
        level: "warn",
        stream: {
          write: (obj: string) => {
            const parsed = JSON.parse(obj);
            if (parsed.level === 40 /* warn */) warns.push(String(parsed.msg));
          },
        },
      } as const;

      const app = await createApp({
        preset: "testing",
        auth: false,
        // biome-ignore lint/suspicious/noExplicitAny: Fastify logger shape varies
        logger: logger as any,
        resourceDir: "tests/utils",
      });
      apps.push(app);
      await app.ready();

      const zeroWarn = warns.find((m) => m.includes("yielded 0 resources"));
      expect(zeroWarn).toBeDefined();
      expect(zeroWarn).toContain('"tests/utils"');
      expect(zeroWarn).toContain(resolve("tests/utils"));
      expect(zeroWarn).toContain("strictResourceDir");
    });

    it("strictResourceDir: true throws on zero-discovery", async () => {
      await expect(
        createApp({
          preset: "testing",
          auth: false,
          logger: false,
          resourceDir: "tests/utils",
          strictResourceDir: true,
        }),
      ).rejects.toThrow(/yielded 0 resources/);
    });

    it("strictResourceDir: true with a valid dir does NOT throw (only zero-discovery triggers it)", async () => {
      // Point at a dir with a real .resource.ts fixture. The loader
      // will find something and the strict check falls through.
      const fixtureDir = resolve(__dirname, "../fixtures/load-resources");
      // If there's no fixture dir, skip — this test is about the
      // happy-path pass-through, not the fixture infra.
      try {
        const { readdir } = await import("node:fs/promises");
        const entries = await readdir(fixtureDir);
        const hasResource = entries.some((e) => /\.resource\.(ts|js|mts|mjs)$/.test(e));
        if (!hasResource) return;
      } catch {
        return; // fixture dir absent — test is informational
      }

      const app = await createApp({
        preset: "testing",
        auth: false,
        logger: false,
        resourceDir: fixtureDir,
        strictResourceDir: true,
      });
      apps.push(app);
      await app.ready();
      expect(app.server).toBeDefined();
    });

    it("resourceDir accepts `import.meta.url` (file:// URL) and resolves to its containing dir", async () => {
      // The caller passes a file:// URL; arc should resolve to the
      // URL's dirname, NOT join it against cwd. We verify by passing
      // a URL for a file inside tests/utils/ — resolution should
      // land in tests/utils (which has no .resource.ts, so we catch
      // the absolute path in the warn message).
      const fileUrl = pathToFileURL(resolve(__dirname, "../utils/dummy.ts")).href;

      const warns: string[] = [];
      const logger = {
        level: "warn",
        stream: {
          write: (obj: string) => {
            const parsed = JSON.parse(obj);
            if (parsed.level === 40) warns.push(String(parsed.msg));
          },
        },
      } as const;

      const app = await createApp({
        preset: "testing",
        auth: false,
        // biome-ignore lint/suspicious/noExplicitAny: Fastify logger shape varies
        logger: logger as any,
        resourceDir: fileUrl,
      });
      apps.push(app);
      await app.ready();

      const zeroWarn = warns.find((m) => m.includes("yielded 0 resources"));
      expect(zeroWarn).toBeDefined();
      // Raw input (the URL) shows up verbatim — helps debugging
      expect(zeroWarn).toContain(fileUrl);
      // Resolved path is the URL's dirname (tests/utils), NOT cwd + the URL
      expect(zeroWarn).toContain(resolve(__dirname, "../utils"));
    });
  });

  describe("v2.10.9 — strictResources", () => {
    // Duplicate-name resources with DIFFERENT prefixes so routes don't
    // collide at Fastify registration time. The duplicate detection we
    // care about is name-based (a stale-dist/ symptom), not route-based.
    const makeResource = (name: string, prefix: string) =>
      defineResource({
        name,
        prefix,
        disableDefaultRoutes: true,
        actions: {
          ping: async () => ({ pong: true }),
        },
        actionPermissions: (() => true) as import("../../src/types/index.js").PermissionCheck,
      });

    it("duplicates emit a warn by default (back-compat)", async () => {
      const warns: string[] = [];
      const logger = {
        level: "warn",
        stream: {
          write: (obj: string) => {
            const parsed = JSON.parse(obj);
            if (parsed.level === 40) warns.push(String(parsed.msg));
          },
        },
      } as const;

      const app = await createApp({
        preset: "testing",
        auth: false,
        // biome-ignore lint/suspicious/noExplicitAny: Fastify logger shape varies
        logger: logger as any,
        resources: [
          makeResource("dupe-warn-a", "/dupe-warn-a-1"),
          makeResource("dupe-warn-a", "/dupe-warn-a-2"),
        ],
      });
      apps.push(app);
      await app.ready();

      expect(warns.some((m) => m.includes('Duplicate resource name "dupe-warn-a"'))).toBe(true);
    });

    it("strictResources: true throws on duplicate resource names", async () => {
      await expect(
        createApp({
          preset: "testing",
          auth: false,
          logger: false,
          strictResources: true,
          resources: [
            makeResource("dupe-strict-a", "/dupe-strict-a-1"),
            makeResource("dupe-strict-a", "/dupe-strict-a-2"),
          ],
        }),
      ).rejects.toThrow(/Duplicate resource name "dupe-strict-a"/);
    });
  });
});
