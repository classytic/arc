/**
 * A resource the registry rejects must not boot. It would serve traffic while missing from
 * introspection, the permission matrix and MCP.
 */

import { describe, expect, it } from "vitest";
import { defineResource } from "../../src/core/defineResource.js";
import { createApp } from "../../src/factory/createApp.js";
import { allowPublic } from "../../src/permissions/index.js";

const service = (prefix: string) =>
  defineResource({
    name: "widget",
    prefix,
    customRoutesOnly: true,
    skipRegistry: false,
    routes: [
      {
        method: "GET",
        path: "/ping",
        permissions: allowPublic(),
        handler: async () => ({ ok: true }),
      },
    ],
  });

describe("registry registration is boot-fatal", () => {
  it("two resources with one name fail boot, naming it", async () => {
    await expect(
      (async () => {
        const app = await createApp({
          logger: false,
          preset: "testing",
          auth: false,
          resources: [service("/widgets"), service("/gadgets")],
        });
        await app.ready();
        await app.close();
      })(),
    ).rejects.toThrow(/widget/);
  });

  it("one resource per name boots normally", async () => {
    const app = await createApp({
      logger: false,
      preset: "testing",
      auth: false,
      resources: [service("/widgets")],
    });
    await app.ready();
    expect((await app.inject({ method: "GET", url: "/widgets/ping" })).statusCode).toBe(200);
    await app.close();
  });
});
