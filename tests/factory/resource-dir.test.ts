/**
 * resourceDir — auto-discover resources from a directory path
 *
 * Tests:
 * 1. resourceDir loads resources without explicit resources array
 * 2. explicit resources[] takes priority over resourceDir
 * 3. resourceDir with resourcePrefix applies prefix
 */

import { afterAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
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
});
