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

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { FastifyInstance } from "fastify";
import { afterAll, describe, expect, it } from "vitest";
import { defineResource } from "../../src/core/defineResource.js";
import { createApp } from "../../src/factory/createApp.js";

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

      // v2.11 folded the two separate WARNs (one from discovery, one from
      // the zero-count summary) into a single WARN — check for both the
      // raw input and the resolved path in that single line. The phrase
      // "0 resources registered" is the new anchor.
      const zeroWarn = warns.find((m) => m.includes("0 resources registered"));
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

      // v2.11 fold — one WARN anchored on "0 resources registered"
      const zeroWarn = warns.find((m) => m.includes("0 resources registered"));
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

  // ────────────────────────────────────────────────────────────────────────
  // v2.11 — remaining field-report fixes
  //
  // Three gaps the 2.10.9 hardening didn't close:
  //   1. N=0 boot (no resourceDir, resources: [] or undefined) was silent —
  //      no log line, no WARN, no signal that the app is dead on arrival.
  //   2. loadResources() called directly (not via resourceDir) returning []
  //      also silent — the manual path bypasses the registerResources WARN.
  //   3. `strictResources` / `strictResourceDir` still opt-in by default,
  //      meaning the "stale dist/ 17 ghost files" case that triggered a
  //      downstream Mongoose collision only WARNed.
  // ────────────────────────────────────────────────────────────────────────
  describe("v2.11 — zero-count announcement + production-preset defaults", () => {
    const makeLogger = () => {
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
      return { warns, logger };
    };

    it("N=0 via explicit empty resources[] emits a WARN with the count", async () => {
      // Reporter's exact failure mode: manual loadResources() returns []
      // → host passes that empty array to createApp → before v2.11 the app
      // booted with zero resources and nothing in the log announced it.
      const { warns, logger } = makeLogger();
      const app = await createApp({
        preset: "testing",
        auth: false,
        // biome-ignore lint/suspicious/noExplicitAny: Fastify logger shape varies
        logger: logger as any,
        resources: [],
      });
      apps.push(app);
      await app.ready();

      const zeroWarn = warns.find((m) => m.includes("0 resources registered"));
      expect(zeroWarn).toBeDefined();
    });

    it("N=0 via missing resources AND resourceDir (app with nothing) emits a WARN", async () => {
      const { warns, logger } = makeLogger();
      const app = await createApp({
        preset: "testing",
        auth: false,
        // biome-ignore lint/suspicious/noExplicitAny: Fastify logger shape varies
        logger: logger as any,
      });
      apps.push(app);
      await app.ready();

      expect(warns.some((m) => m.includes("0 resources registered"))).toBe(true);
    });

    it("N=0 via resourceDir includes the scanned absolute path in the WARN", async () => {
      // When discovery is configured, the zero-count WARN echoes the
      // resolved path so operators can spot "right option, wrong path"
      // without reading the source.
      const { warns, logger } = makeLogger();
      const app = await createApp({
        preset: "testing",
        auth: false,
        // biome-ignore lint/suspicious/noExplicitAny: Fastify logger shape varies
        logger: logger as any,
        resourceDir: "tests/utils",
      });
      apps.push(app);
      await app.ready();

      const zeroWarn = warns.find((m) => m.includes("0 resources registered"));
      expect(zeroWarn).toBeDefined();
      // v2.11 fold — the phrase is 'resourceDir "X" resolved to "Y"'
      expect(zeroWarn).toContain("resourceDir");
      expect(zeroWarn).toContain("resolved to");
      expect(zeroWarn).toContain(resolve("tests/utils"));
    });

    it("N>0 still logs the info line with names (no regression)", async () => {
      // Locking the happy-path log shape so the N=0 branch doesn't
      // accidentally shadow or duplicate the N>0 info line.
      const infos: string[] = [];
      const logger = {
        level: "info",
        stream: {
          write: (obj: string) => {
            const parsed = JSON.parse(obj);
            if (parsed.level === 30 /* info */) infos.push(String(parsed.msg));
          },
        },
      } as const;

      const resource = defineResource({
        name: "zero-count-happy-path",
        prefix: "/zcHP",
        disableDefaultRoutes: true,
        actions: { ping: async () => ({ pong: true }) },
        actionPermissions: (() => true) as import("../../src/types/index.js").PermissionCheck,
      });

      const app = await createApp({
        preset: "testing",
        auth: false,
        // biome-ignore lint/suspicious/noExplicitAny: Fastify logger shape varies
        logger: logger as any,
        resources: [resource],
      });
      apps.push(app);
      await app.ready();

      expect(
        infos.some(
          (m) => m.includes("1 resource(s) registered") && m.includes("zero-count-happy-path"),
        ),
      ).toBe(true);
    });

    it("production preset → strictResources defaults to true (duplicate names throw)", async () => {
      // 2.11 flips the strict-dupe default in production. The reporter's
      // stale-dist 17-ghost-file case now fails loud before the downstream
      // Mongoose collision fires.
      const makeResource = (name: string, prefix: string) =>
        defineResource({
          name,
          prefix,
          disableDefaultRoutes: true,
          actions: { ping: async () => ({ pong: true }) },
          actionPermissions: (() => true) as import("../../src/types/index.js").PermissionCheck,
        });

      await expect(
        createApp({
          preset: "production",
          auth: { type: "jwt", jwt: { secret: "not-a-real-secret-just-for-testing" } },
          logger: false,
          resources: [
            makeResource("dupe-prod-a", "/dupe-prod-a-1"),
            makeResource("dupe-prod-a", "/dupe-prod-a-2"),
          ],
        }),
      ).rejects.toThrow(/Duplicate resource name "dupe-prod-a"/);
    });

    it("production preset → strictResourceDir defaults to true (zero-discovery throws)", async () => {
      await expect(
        createApp({
          preset: "production",
          auth: { type: "jwt", jwt: { secret: "not-a-real-secret-just-for-testing" } },
          logger: false,
          resourceDir: "tests/utils", // dir exists but has no .resource.ts files
        }),
      ).rejects.toThrow(/yielded 0 resources/);
    });

    it("production preset → explicit strictResources: false opts out of the strict default", async () => {
      // Back-compat escape hatch: hosts that intentionally duplicate
      // resource names (very rare, usually a refactor escape hatch) can
      // still pass the explicit flag.
      const makeResource = (name: string, prefix: string) =>
        defineResource({
          name,
          prefix,
          disableDefaultRoutes: true,
          actions: { ping: async () => ({ pong: true }) },
          actionPermissions: (() => true) as import("../../src/types/index.js").PermissionCheck,
        });

      // Should NOT throw — explicit false overrides the production default.
      const app = await createApp({
        preset: "production",
        auth: { type: "jwt", jwt: { secret: "not-a-real-secret-just-for-testing" } },
        logger: false,
        strictResources: false,
        resources: [
          makeResource("dupe-prod-optout", "/dpoo-1"),
          makeResource("dupe-prod-optout", "/dpoo-2"),
        ],
      });
      apps.push(app);
      await app.ready();
      expect(app.server).toBeDefined();
    });
  });
});
